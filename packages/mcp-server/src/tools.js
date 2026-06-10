/**
 * MCP tool definitions + handlers for the odw daemon. SDK-free on purpose —
 * this is the surface the tests cover; src/index.js wires it into the SDK.
 *
 * Context hygiene: odw_plan caches the FULL plan in-process and returns only a
 * compact summary — the compiled script never enters the model's context.
 */

const RESULT_POLL_INTERVAL_MS = 2000;
const RESULT_POLL_CAP_MS = 600_000; // ~10 min

export const TOOL_DEFINITIONS = [
  {
    name: 'odw_health',
    description: 'Check the local odw daemon: status, uptime and active workflow/agent counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'odw_plan',
    description:
      'Plan a dynamic multi-agent workflow without executing it. Returns a compact summary (planId, topology, agent count, cost/time estimate). Execute later with odw_run {planId}.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'what the workflow should accomplish' },
        topology: { type: 'string', description: 'optional topology hint (e.g. parallel, pipeline, hybrid)' },
        maxAgents: { type: 'number', description: 'optional cap on total agents' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'odw_run',
    description:
      'Execute a dynamic multi-agent workflow via the local odw daemon. Pass EITHER prompt (plan + execute in one step) OR planId (execute a plan cached by odw_plan). wait=true blocks until the workflow finishes (up to ~10 min).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'what the workflow should accomplish (mutually exclusive with planId)' },
        planId: { type: 'string', description: 'a plan_... id previously returned by odw_plan (mutually exclusive with prompt)' },
        cwd: { type: 'string', description: 'working directory for the workflow (default: the MCP server cwd)' },
        wait: { type: 'boolean', description: 'true: block and return the final result; false (default): return the workflowId immediately' },
      },
    },
  },
  {
    name: 'odw_status',
    description: 'Status of one odw workflow: phase, per-node stats, agents completed/failed, cost, failure reason.',
    inputSchema: {
      type: 'object',
      properties: { workflowId: { type: 'string', description: 'the wf_... id' } },
      required: ['workflowId'],
    },
  },
  {
    name: 'odw_result',
    description: 'Fetch the result of an odw workflow. wait=true blocks server-side until the workflow finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'the wf_... id' },
        wait: { type: 'boolean', description: 'true: block until the workflow finishes' },
      },
      required: ['workflowId'],
    },
  },
  {
    name: 'odw_control',
    description: 'Pause, resume or stop a running odw workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'the wf_... id' },
        action: { type: 'string', enum: ['pause', 'resume', 'stop'], description: 'pause | resume | stop' },
      },
      required: ['workflowId', 'action'],
    },
  },
  {
    name: 'odw_list',
    description: 'List all workflows known to the local odw daemon with id, status, topology and creation time.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

const fail = (message) => ({ content: [{ type: 'text', text: `error: ${message}` }], isError: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function planSummary(plan) {
  return {
    planId: plan.planId,
    topology: plan.topology,
    totalAgents: plan.estimate?.totalAgents,
    estCostUSD: plan.estimate?.costUSD,
    estMinutes: plan.estimate?.minutes,
    hasVerification: plan.hasVerification === true,
    scriptLength: plan.script?.length ?? 0,
  };
}

/**
 * @param {ReturnType<import('./daemon-client.js').createDaemonClient>} client
 * @param {{pollIntervalMs?: number, pollCapMs?: number}} [options] test seams only
 * @returns {Record<string, (args: object) => Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>>}
 */
export function createToolHandlers(client, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? RESULT_POLL_INTERVAL_MS;
  const pollCapMs = options.pollCapMs ?? RESULT_POLL_CAP_MS;
  // Full plans live only in this process — odw_plan returns summaries to the model.
  const planCache = new Map();

  // Handlers must NEVER throw raw — every failure becomes an isError text block.
  const guarded = (fn) => async (args) => {
    try {
      return await fn(args ?? {});
    } catch (error) {
      return fail(String(error?.message ?? error));
    }
  };

  return {
    odw_health: guarded(async () => {
      const health = await client.health();
      return text(
        `daemon ${health.status} on ${client.base} — ${health.activeWorkflows ?? 0} active workflow(s), ` +
          `${health.activeAgents ?? 0} active / ${health.queuedAgents ?? 0} queued agent(s), uptime ${health.uptime ?? 0}s`
      );
    }),

    odw_plan: guarded(async ({ prompt, topology, maxAgents }) => {
      if (!prompt || typeof prompt !== 'string') return fail('prompt (string) is required');
      const planOptions = {};
      if (topology !== undefined) planOptions.topology = topology;
      if (maxAgents !== undefined) planOptions.maxAgents = maxAgents;
      const { plan } = await client.plan(prompt, planOptions);
      planCache.set(plan.planId, plan);
      return text({ ...planSummary(plan), next: `execute with odw_run {"planId": "${plan.planId}"}` });
    }),

    odw_run: guarded(async ({ prompt, planId, cwd, wait }) => {
      if (Boolean(prompt) === Boolean(planId)) {
        return fail('pass exactly one of prompt or planId');
      }
      let plan;
      if (planId) {
        plan = planCache.get(planId);
        if (!plan) {
          return fail(
            `plan ${planId} is not cached (plans expire when the MCP server restarts) — re-plan with odw_plan or pass prompt directly`
          );
        }
      } else {
        ({ plan } = await client.plan(prompt, {}));
        planCache.set(plan.planId, plan);
      }
      const { workflowId } = await client.exec(plan, { cwd: cwd || process.cwd() });
      if (!wait) {
        return text({ workflowId, status: 'running', plan: planSummary(plan) });
      }
      // Poll instead of one long blocking call so a stalled workflow can't
      // wedge the MCP request past the ~10 min cap.
      const deadline = Date.now() + pollCapMs;
      for (;;) {
        const { status, result } = await client.result(workflowId);
        if (status === 'completed' || status === 'failed') {
          return text({ workflowId, status, result });
        }
        if (Date.now() >= deadline) {
          return text({ workflowId, status, note: 'still running after wait cap — check later with odw_result' });
        }
        await sleep(pollIntervalMs);
      }
    }),

    odw_status: guarded(async ({ workflowId }) => {
      if (!workflowId) return fail('workflowId is required');
      const record = await client.get(workflowId);
      return text({
        workflowId,
        status: record.status,
        agents: { total: record.total_agents, completed: record.completed_agents, failed: record.failed_agents },
        costUSD: record.cost_usd,
        nodeStats: record.nodeStats,
        ...(record.status === 'failed' ? { error: record.error ?? null } : {}),
      });
    }),

    odw_result: guarded(async ({ workflowId, wait }) => {
      if (!workflowId) return fail('workflowId is required');
      return text(await client.result(workflowId, { wait: wait === true }));
    }),

    odw_control: guarded(async ({ workflowId, action }) => {
      if (!workflowId) return fail('workflowId is required');
      if (!['pause', 'resume', 'stop'].includes(action)) return fail('action must be pause|resume|stop');
      return text(await client.control(workflowId, action));
    }),

    odw_list: guarded(async () => {
      const { workflows } = await client.list();
      if (!workflows?.length) return text('no workflows yet');
      return text(
        workflows.map((w) => ({
          id: w.workflow_id,
          status: w.status,
          topology: w.topology,
          created_at: w.created_at,
        }))
      );
    }),
  };
}
