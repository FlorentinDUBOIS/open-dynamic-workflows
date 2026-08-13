import { randomUUID } from 'node:crypto';
import { acquireSessionLock } from './session-lock.js';
import { DEFAULT_PROFILE, routeModel } from './profiles.js';
import { extractJson, compileSchema } from 'odw-core';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export function createWorkflowController(options) {
  const { client, directory, state, createOrchestrator, createBackend } = options;

  async function ownSession(sessionID) {
    const session = state.ensure(sessionID);
    if (session.lock) return session;
    session.lock = await acquireSessionLock(sessionID, options.lockOptions);
    if (!session.lock) throw new Error(`ODW session ${sessionID} is owned by another OpenCode process`);
    return session;
  }

  async function start({ sessionID, prompt, profile = DEFAULT_PROFILE, mode = 'workflow', agent }) {
    await ownSession(sessionID);
    const id = `odw_${randomUUID().replaceAll('-', '')}`;
    const workflow = state.addWorkflow(sessionID, {
      id,
      parentSessionID: sessionID,
      prompt,
      profile,
      mode,
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      engineID: null,
      plan: null,
      result: null,
      error: null,
      children: [],
    });

    const backend = createBackend(client, {
      parentSessionID: sessionID,
      profile,
      agent,
      modelForRole: (role) => routeModel(profile, role),
      onSessionCreate(childID) {
        state.registerChild(childID);
        workflow.children.push(childID);
        workflow.updatedAt = Date.now();
      },
    });
    const orchestrator = createOrchestrator({
      invoke: backend.invoke,
      modelForRole: (role) => routeModel(profile, role),
      embeddedUnbounded: true,
      hybridPlanning: true,
      nativeHostTools: true,
    });
    workflow.orchestrator = orchestrator;
    workflow.backend = backend;

    workflow.promise = (async () => {
      try {
        workflow.status = 'running';
        workflow.updatedAt = Date.now();
        const started = await orchestrator.start(prompt, { cwd: directory, profile });
        workflow.engineID = started.workflowId;
        workflow.plan = started.plan;
        workflow.updatedAt = Date.now();
        const output = await started.completion;
        workflow.result = output.result;
        workflow.status = output.status === 'completed' ? 'completed' : output.status;
      } catch (error) {
        if (workflow.status !== 'cancelled') workflow.status = 'failed';
        workflow.error = String(error?.message ?? error);
        throw error;
      } finally {
        workflow.updatedAt = Date.now();
        await backend.dispose().catch(() => {});
      }
      return workflow;
    })();
    workflow.promise.catch(() => {});
    return snapshot(workflow);
  }

  async function control(sessionID, workflowID, action) {
    const workflow = state.workflow(sessionID, workflowID);
    if (!workflow) throw new Error(`unknown ODW workflow: ${workflowID}`);
    if (TERMINAL.has(workflow.status) && action !== 'resume') {
      throw new Error(`workflow ${workflowID} is already ${workflow.status}`);
    }
    if (!['pause', 'resume', 'stop'].includes(action)) throw new Error(`unsupported ODW action: ${action}`);
    if (!workflow.engineID) {
      if (action === 'stop') {
        workflow.status = 'cancelled';
        workflow.updatedAt = Date.now();
        return snapshot(workflow);
      }
      throw new Error(`workflow ${workflowID} is still planning`);
    }
    const result = await workflow.orchestrator.control(workflow.engineID, action);
    workflow.status = action === 'stop' ? 'cancelled' : action === 'pause' ? 'paused' : 'running';
    workflow.updatedAt = Date.now();
    return { ...snapshot(workflow), control: result };
  }

  async function reconcile(sessionID, workflowID, nodeID, verdict, evidence, output) {
    const workflow = state.workflow(sessionID, workflowID);
    if (!workflow) throw new Error(`unknown ODW workflow: ${workflowID}`);
    let reconstructed = output;
    if (verdict === 'skip' && reconstructed === undefined) {
      const node = workflow.orchestrator.store.getNode(nodeID);
      if (!node) throw new Error(`unknown ODW node: ${nodeID}`);
      const response = await workflow.backend.invoke({
        workflowId: workflowID,
        nodeId: `${nodeID}-reconstruction`,
        role: 'reconstruction',
        model: routeModel(workflow.profile, 'reconstruction').model,
        variant: routeModel(workflow.profile, 'reconstruction').variant,
        prompt: [
          'Reconstruct the lost output of an interrupted tool node without changing any state.',
          `Evidence that the effect must not be replayed: ${evidence}`,
          `Original node prompt: ${node.prompt}`,
          'Return only the reconstructed JSON output.',
        ].join('\n'),
      });
      reconstructed = extractJson(response.text);
      if (reconstructed === undefined) throw new Error('reconstruction did not return JSON');
      if (node.output_schema) {
        const verdictResult = compileSchema(JSON.parse(node.output_schema))(reconstructed);
        if (!verdictResult.valid) throw new Error(`reconstructed output is invalid: ${verdictResult.errors.join('; ')}`);
      }
    }
    const result = workflow.orchestrator.reconcileNode(workflow.engineID, nodeID, { verdict, evidence, output: reconstructed });
    workflow.status = 'paused';
    workflow.updatedAt = Date.now();
    return { ...snapshot(workflow), reconciliation: result };
  }

  function list(sessionID) {
    return state.workflows(sessionID).map(snapshot);
  }

  async function remove(sessionID) {
    const workflows = state.workflows(sessionID);
    await Promise.all(workflows.map(async (workflow) => {
      if (!TERMINAL.has(workflow.status) && workflow.engineID) {
        await workflow.orchestrator.control(workflow.engineID, 'stop').catch(() => {});
      }
      await workflow.backend?.dispose().catch(() => {});
      for (const childID of workflow.children) state.unregisterChild(childID);
    }));
    await state.remove(sessionID);
  }

  return { start, control, reconcile, list, remove };
}

export function snapshot(workflow) {
  return {
    id: workflow.id,
    engineID: workflow.engineID,
    parentSessionID: workflow.parentSessionID,
    prompt: workflow.prompt,
    profile: workflow.profile,
    mode: workflow.mode,
    status: workflow.status,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    plan: workflow.plan,
    result: workflow.result,
    error: workflow.error,
    children: [...workflow.children],
  };
}

export function parseControlArguments(value) {
  const [workflowID, action, ...rest] = String(value ?? '').trim().split(/\s+/);
  if (!workflowID || !action) {
    throw new Error('usage: /odw-control <workflow-id> <pause|resume|stop>');
  }
  if (!['pause', 'resume', 'stop', 'replay', 'skip'].includes(action)) {
    throw new Error('ODW control action must be pause, resume, stop, replay or skip');
  }
  if (['pause', 'resume', 'stop'].includes(action)) {
    if (rest.length) throw new Error('pause, resume and stop take no additional arguments');
    return { workflowID, action };
  }
  const [nodeID, ...evidenceWords] = rest;
  const evidence = evidenceWords.join(' ').trim();
  if (!nodeID || !evidence) throw new Error(`usage: /odw-control <workflow-id> ${action} <node-id> <evidence>`);
  return { workflowID, action, nodeID, evidence };
}
