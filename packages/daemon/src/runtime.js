/**
 * Workflow runtime — glues sandbox + agent queue + store + budget + events.
 * Owns the workflow lifecycle: exec, checkpoint, pause/resume/stop, completion.
 *
 * Deterministic node identity makes resume safe:
 *   node_id = sha1(workflowId|phase|role|prompt)
 * On re-run, completed nodes resolve instantly from the SQLite cache.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mergeStrategy, costFor } from 'odw-core';
import { createSandbox } from './sandbox.js';
import { createBudget } from './budget.js';
import { createToolExecutor } from './tools.js';

/**
 * @param {{store: object, queue: object, config: object, events: {emit: Function}, logger: object}} deps
 */
export function createRuntime(deps) {
  const { store, queue, config, events, logger } = deps;

  /** in-memory state per active workflow */
  const active = new Map();

  const emit = (workflowId, type, payload = {}) => {
    const event = { type, workflowId, ts: Date.now(), payload };
    try {
      store.journal(workflowId, type, payload);
    } catch (error) {
      logger.warn('journal write failed', { error });
    }
    events.emit('workflow-event', event);
  };

  /**
   * Start executing a plan. Returns the workflowId immediately; execution
   * continues in the background (await result via GET /workflows/:id/result).
   * @param {object} plan
   * @param {object} [strategyOverrides]
   * @param {{workflowId?: string, cwd?: string, args?: object, wait?: boolean}} [options]
   */
  async function execWorkflow(plan, strategyOverrides, options = {}) {
    if (!plan?.script) throw new Error('execWorkflow: plan.script is required');
    const workflowId = options.workflowId ?? `wf_${randomUUID().slice(0, 12)}`;
    const strategy = mergeStrategy({ ...(plan.strategy ?? {}), ...(strategyOverrides ?? {}) });

    store.insertWorkflow({
      workflow_id: workflowId,
      status: 'running',
      root_prompt: plan.prompt ?? '',
      compiled_script: plan.script,
      execution_strategy: JSON.stringify(strategy),
      topology: plan.topology ?? 'hybrid',
      total_agents: plan.estimate?.totalAgents ?? 0,
      budget_max_usd: strategy.budget.maxCostUSD,
    });
    emit(workflowId, 'workflow_started', { topology: plan.topology, estimate: plan.estimate });

    const running = runWorkflow(workflowId, plan.script, strategy, options).catch(() => {});
    if (options.wait) await running;
    return workflowId;
  }

  /** Core execution path, shared by exec and resume. */
  async function runWorkflow(workflowId, script, strategy, options = {}) {
    const abort = new AbortController();
    const state = {
      abort,
      paused: false,
      currentPhase: 'init',
      done: null,
    };
    active.set(workflowId, state);

    // resume cache: completed node → parsed output
    const cache = new Map();
    for (const node of store.completedNodes(workflowId)) {
      try {
        cache.set(node.node_id, JSON.parse(node.output));
      } catch {
        /* skip unparseable cache rows */
      }
    }

    const workflowRow = store.getWorkflow(workflowId);
    const budget = createBudget({
      maxTokens: strategy.budget.maxTokens,
      maxCostUSD: strategy.budget.maxCostUSD,
      alertAtPercent: strategy.budget.alertAtPercent,
      onAlert: (type, usage) => {
        emit(workflowId, 'budget_alert', { alertType: type, usage });
        if (type === 'exceeded') {
          state.paused = true;
          store.setBudgetAlerted(workflowId);
          abort.abort();
        } else {
          store.setBudgetAlerted(workflowId);
        }
      },
    });
    budget.seed(
      (workflowRow?.tokens_input ?? 0) + (workflowRow?.tokens_output ?? 0),
      workflowRow?.cost_usd ?? 0
    );

    const toolExecutor = createToolExecutor({
      cwd: options.cwd ?? process.cwd(),
      safety: strategy.safety,
      logger,
    });

    const hostBridges = {
      agent: async (job) => {
        if (state.paused) throw Object.assign(new Error('workflow paused'), { code: 'paused' });
        if (abort.signal.aborted) throw Object.assign(new Error('workflow stopped'), { code: 'aborted' });

        const model = job.model ?? strategy.budget.model;
        const phase = state.currentPhase;
        const nodeId = sha1(`${workflowId}|${phase}|${job.role ?? ''}|${job.prompt}`);

        if (cache.has(nodeId)) {
          emit(workflowId, 'agent_cached', { nodeId, phase });
          return cache.get(nodeId);
        }

        store.upsertNode({
          node_id: nodeId,
          workflow_id: workflowId,
          phase_name: phase,
          role_id: job.role ?? 'agent',
          status: 'running',
          prompt: String(job.prompt).slice(0, 100_000),
          max_retries: strategy.retry.maxAttempts,
        });
        emit(workflowId, 'agent_start', { nodeId, phase, role: job.role, model });

        try {
          const result = await queue.executeAgent(
            {
              model,
              systemPrompt: job.systemPrompt ?? roleSystemPrompt(job, options),
              prompt: job.prompt,
              schema: job.schema,
              maxTokens: job.maxTokens,
              temperature: job.temperature,
            },
            abort.signal
          );
          budget.track(model, result.tokensInput, result.tokensOutput);
          store.completeNode({
            node_id: nodeId,
            output: JSON.stringify(result.output ?? null),
            tokens_input: result.tokensInput,
            tokens_output: result.tokensOutput,
            cost_usd: costOf(budget, model, result),
            duration_ms: result.durationMs,
          });
          store.bumpWorkflowTotals({
            workflow_id: workflowId,
            completed: 1,
            failed: 0,
            tokens_input: result.tokensInput,
            tokens_output: result.tokensOutput,
            cost_usd: costOf(budget, model, result),
          });
          cache.set(nodeId, result.output);
          emit(workflowId, 'agent_complete', { nodeId, phase, durationMs: result.durationMs });
          return result.output;
        } catch (error) {
          store.failNode({
            node_id: nodeId,
            status: error.code === 'aborted' ? 'cancelled' : 'failed',
            error: String(error.message).slice(0, 2000),
          });
          store.bumpWorkflowTotals({
            workflow_id: workflowId, completed: 0, failed: 1, tokens_input: 0, tokens_output: 0, cost_usd: 0,
          });
          emit(workflowId, 'agent_failed', { nodeId, phase, error: String(error.message).slice(0, 500) });
          throw error;
        }
      },

      tool: (payload) => toolExecutor(payload),

      checkpoint: async (data) => {
        store.insertCheckpoint({
          checkpoint_id: `cp_${randomUUID().slice(0, 12)}`,
          workflow_id: workflowId,
          phase_name: state.currentPhase,
          checkpoint_key: typeof data?.phase === 'string' ? data.phase : state.currentPhase,
          state_data: JSON.stringify(data ?? null).slice(0, 4_000_000),
          agent_results: null,
        });
        emit(workflowId, 'checkpoint', { phase: state.currentPhase });
        return null;
      },

      log: ({ message, level }) => {
        logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](`[${workflowId}] ${message}`);
        emit(workflowId, 'log', { message: String(message).slice(0, 2000), level });
      },

      phase: ({ name, meta }) => {
        state.currentPhase = name;
        emit(workflowId, 'phase', { name, meta });
      },

      budget: () => budget.snapshot(),
      args: () => options.args ?? {},
    };

    state.done = (async () => {
      let sandbox;
      try {
        sandbox = await createSandbox({
          hostBridges,
          strategy,
          totalTimeoutMs: strategy.timeouts.total * 1000,
        });
        const result = await sandbox.runScript(script);
        store.setWorkflowResult(workflowId, 'completed', result);
        emit(workflowId, 'workflow_complete', { });
        return result;
      } catch (error) {
        if (state.paused) {
          store.setWorkflowStatus(workflowId, 'paused');
          emit(workflowId, 'workflow_paused', { reason: budget.exceeded() ? 'budget_exceeded' : 'paused' });
        } else if (abort.signal.aborted) {
          store.setWorkflowStatus(workflowId, 'cancelled');
          emit(workflowId, 'workflow_cancelled', {});
        } else {
          store.setWorkflowResult(workflowId, 'failed', { error: String(error.message).slice(0, 2000) });
          emit(workflowId, 'workflow_failed', { error: String(error.message).slice(0, 500) });
        }
        throw error;
      } finally {
        sandbox?.dispose();
        active.delete(workflowId);
      }
    })();

    // surface unhandled rejections to logs without crashing the daemon
    state.done.catch((error) => logger.warn(`workflow ${workflowId} ended: ${error.message}`));
    return state.done;
  }

  /**
   * @param {string} workflowId
   * @param {"pause"|"resume"|"stop"} action
   */
  async function control(workflowId, action) {
    const row = store.getWorkflow(workflowId);
    if (!row) throw Object.assign(new Error(`workflow not found: ${workflowId}`), { status: 404 });
    const state = active.get(workflowId);

    if (action === 'pause') {
      if (state) {
        state.paused = true;
      }
      store.setWorkflowStatus(workflowId, 'paused');
      emit(workflowId, 'workflow_paused', { reason: 'user' });
      return { workflowId, status: 'paused' };
    }

    if (action === 'stop') {
      if (state) {
        state.abort.abort();
      }
      store.setWorkflowStatus(workflowId, 'cancelled');
      emit(workflowId, 'workflow_cancelled', {});
      return { workflowId, status: 'cancelled' };
    }

    if (action === 'resume') {
      if (state) return { workflowId, status: row.status }; // already live
      const resumed = await resumeWorkflow(workflowId);
      return { workflowId, status: resumed ? 'running' : row.status };
    }

    throw Object.assign(new Error(`unknown action: ${action}`), { status: 400 });
  }

  /**
   * Resume an interrupted workflow: requeue orphans, rebuild cache, re-run script.
   * @param {string} workflowId
   * @returns {Promise<boolean>} true if a resume was started
   */
  async function resumeWorkflow(workflowId) {
    const row = store.getWorkflow(workflowId);
    if (!row || row.status === 'completed') return false;
    if (active.has(workflowId)) return true;

    const requeued = store.requeueOrphans(workflowId);
    store.setWorkflowStatus(workflowId, 'running');
    emit(workflowId, 'workflow_resumed', { requeued });

    const strategy = mergeStrategy(JSON.parse(row.execution_strategy));
    runWorkflow(workflowId, row.compiled_script, strategy, {}).catch(() => {});
    return true;
  }

  /** Resume everything that was running/paused at last shutdown. */
  async function resumeInterrupted() {
    const interrupted = store.listInterrupted();
    const resumed = [];
    for (const row of interrupted) {
      if (await resumeWorkflow(row.workflow_id)) resumed.push(row.workflow_id);
    }
    return resumed;
  }

  /** Await a workflow's completion if it is currently active. */
  function resultOf(workflowId) {
    return active.get(workflowId)?.done ?? null;
  }

  function stats() {
    return {
      activeWorkflows: active.size,
      queueSize: queue.size(),
      queuePending: queue.pending(),
      maxConcurrency: config.daemon.maxConcurrency,
    };
  }

  return { execWorkflow, control, resumeWorkflow, resumeInterrupted, resultOf, stats };
}

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function costOf(_budget, model, result) {
  // budget.track already accumulated; this is the per-call figure for the row
  return Math.round(costFor(model, result.tokensInput, result.tokensOutput) * 10000) / 10000;
}

function roleSystemPrompt(job, options) {
  const roles = options.roles;
  if (!roles || !job.role) return undefined;
  const role = roles.find?.((r) => r.id === job.role);
  return role?.systemPrompt;
}
