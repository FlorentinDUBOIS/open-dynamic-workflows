import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFINITIONS, createToolHandlers } from '../src/tools.js';

const SAMPLE_PLAN = {
  planId: 'plan_abc',
  topology: 'hybrid',
  estimate: { totalAgents: 12, costUSD: 1.25, minutes: 3 },
  hasVerification: true,
  script: 'SCRIPT_BODY_MUST_NOT_LEAK '.repeat(40),
  roles: [{ name: 'auditor' }],
  strategy: { mode: 'parallel' },
};

/** stub daemon client recording calls; per-test overrides */
function stubClient(overrides = {}) {
  const calls = [];
  const record = (name, impl) => async (...args) => {
    calls.push([name, ...args]);
    return impl(...args);
  };
  return {
    calls,
    base: 'http://127.0.0.1:7345',
    health: record('health', () => ({ status: 'ok', uptime: 7, activeWorkflows: 2, activeAgents: 3, queuedAgents: 1 })),
    plan: record('plan', () => ({ plan: SAMPLE_PLAN })),
    exec: record('exec', () => ({ workflowId: 'wf_run1', status: 'running' })),
    list: record('list', () => ({ workflows: [] })),
    get: record('get', () => ({ status: 'running', total_agents: 12, completed_agents: 4, failed_agents: 0, cost_usd: 0.5, nodeStats: {} })),
    result: record('result', () => ({ status: 'completed', result: { ok: true } })),
    control: record('control', () => ({ workflowId: 'wf_run1', status: 'paused' })),
    ...overrides,
  };
}

const textOf = (response) => response.content[0].text;

// ── TOOL_DEFINITIONS shape ───────────────────────────────────────────────────

test('TOOL_DEFINITIONS: unique names, MCP shape, object inputSchemas', () => {
  assert.ok(Array.isArray(TOOL_DEFINITIONS) && TOOL_DEFINITIONS.length >= 7);
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const def of TOOL_DEFINITIONS) {
    assert.match(def.name, /^odw_[a-z]+$/);
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 20, `${def.name} needs a real description`);
    assert.equal(def.inputSchema.type, 'object');
    assert.equal(typeof def.inputSchema.properties, 'object');
    for (const required of def.inputSchema.required ?? []) {
      assert.ok(required in def.inputSchema.properties, `${def.name} requires undeclared ${required}`);
    }
  }
});

test('TOOL_DEFINITIONS and createToolHandlers cover the same tool set', () => {
  const handlers = createToolHandlers(stubClient());
  assert.deepEqual(Object.keys(handlers).sort(), TOOL_DEFINITIONS.map((t) => t.name).sort());
});

// ── odw_plan: cache + compact summary ────────────────────────────────────────

test('odw_plan returns a compact summary — never the script — and caches the full plan', async () => {
  const client = stubClient();
  const handlers = createToolHandlers(client);

  const planned = await handlers.odw_plan({ prompt: 'audit auth', topology: 'parallel', maxAgents: 8 });
  assert.notEqual(planned.isError, true);
  const summary = textOf(planned);
  assert.match(summary, /plan_abc/);
  assert.match(summary, /"totalAgents": 12/);
  assert.match(summary, /"estCostUSD": 1.25/);
  assert.match(summary, /"estMinutes": 3/);
  assert.match(summary, /"hasVerification": true/);
  assert.match(summary, /"scriptLength": \d+/);
  assert.doesNotMatch(summary, /SCRIPT_BODY_MUST_NOT_LEAK/, 'full script must never enter context');
  assert.deepEqual(client.calls[0], ['plan', 'audit auth', { topology: 'parallel', maxAgents: 8 }]);

  // cached plan is executable by id — exec receives the FULL plan
  const run = await handlers.odw_run({ planId: 'plan_abc' });
  assert.notEqual(run.isError, true);
  assert.match(textOf(run), /wf_run1/);
  const execCall = client.calls.find(([name]) => name === 'exec');
  assert.equal(execCall[1].script, SAMPLE_PLAN.script);
});

test('odw_plan validates prompt', async () => {
  const handlers = createToolHandlers(stubClient());
  const response = await handlers.odw_plan({});
  assert.equal(response.isError, true);
  assert.match(textOf(response), /prompt/);
});

// ── odw_run ──────────────────────────────────────────────────────────────────

test('odw_run rejects both/neither of prompt and planId', async () => {
  const handlers = createToolHandlers(stubClient());
  for (const args of [{}, { prompt: 'x', planId: 'plan_abc' }]) {
    const response = await handlers.odw_run(args);
    assert.equal(response.isError, true);
    assert.match(textOf(response), /exactly one of prompt or planId/);
  }
});

test('odw_run with unknown planId explains the cache expired', async () => {
  const handlers = createToolHandlers(stubClient());
  const response = await handlers.odw_run({ planId: 'plan_gone' });
  assert.equal(response.isError, true);
  assert.match(textOf(response), /plan_gone/);
  assert.match(textOf(response), /not cached|expire/);
});

test('odw_run with prompt plans then executes; cwd defaults to process.cwd()', async () => {
  const client = stubClient();
  const handlers = createToolHandlers(client);
  const response = await handlers.odw_run({ prompt: 'migrate to TS', maxAgents: 6 });
  assert.notEqual(response.isError, true);
  assert.match(textOf(response), /wf_run1/);
  assert.match(textOf(response), /"status": "running"/);
  assert.deepEqual(client.calls.find(([name]) => name === 'plan'), ['plan', 'migrate to TS', { maxAgents: 6 }]);
  const [, plan, opts] = client.calls.find(([name]) => name === 'exec');
  assert.equal(plan.planId, 'plan_abc');
  assert.equal(opts.cwd, process.cwd());
});

test('odw_run preserves the compact plan when execution config is not ready', async () => {
  const client = stubClient({
    exec: async () => {
      throw new Error('daemon POST /workflows/exec -> 400: {"error":{"code":"provider_not_ready","message":"model configuration is not ready"}}');
    },
  });
  const handlers = createToolHandlers(client);
  const response = await handlers.odw_run({ prompt: 'workflow: split into exactly 20 agents labeled A through T', maxAgents: 24 });
  assert.equal(response.isError, true);
  const payload = JSON.parse(textOf(response));
  assert.equal(payload.error, 'daemon POST /workflows/exec -> 400: {"error":{"code":"provider_not_ready","message":"model configuration is not ready"}}');
  assert.equal(payload.plan.planId, 'plan_abc');
  assert.equal(payload.plan.totalAgents, 12);
  assert.match(payload.next, /odw_run/);
  assert.match(payload.next, /plan_abc/);
  assert.doesNotMatch(textOf(response), /SCRIPT_BODY_MUST_NOT_LEAK/, 'exec failures must not leak the compiled script');
});

test('odw_run wait=true polls result until terminal and returns the final result JSON', async () => {
  let polls = 0;
  const client = stubClient({
    result: async () => (++polls < 3 ? { status: 'running', result: null } : { status: 'completed', result: { answer: 42 } }),
  });
  const handlers = createToolHandlers(client, { pollIntervalMs: 5, pollCapMs: 1000 });
  const response = await handlers.odw_run({ prompt: 'compute', wait: true });
  assert.notEqual(response.isError, true);
  assert.equal(polls, 3);
  assert.match(textOf(response), /"status": "completed"/);
  assert.match(textOf(response), /"answer": 42/);
});

test('odw_run wait=true gives up cleanly at the poll cap', async () => {
  const client = stubClient({ result: async () => ({ status: 'running', result: null }) });
  const handlers = createToolHandlers(client, { pollIntervalMs: 5, pollCapMs: 20 });
  const response = await handlers.odw_run({ prompt: 'slow', wait: true });
  assert.notEqual(response.isError, true);
  assert.match(textOf(response), /still running after wait cap/);
  assert.match(textOf(response), /wf_run1/);
});

// ── odw_status / odw_result / odw_list / odw_health ─────────────────────────

test('odw_status reports agents + nodeStats, and the error field when failed', async () => {
  const failed = stubClient({
    get: async () => ({
      status: 'failed', total_agents: 5, completed_agents: 2, failed_agents: 1, cost_usd: 0.2,
      nodeStats: { failed: 1 }, error: { code: 'agent_error', message: 'boom' },
    }),
  });
  const response = await createToolHandlers(failed).odw_status({ workflowId: 'wf_bad' });
  assert.match(textOf(response), /"status": "failed"/);
  assert.match(textOf(response), /"message": "boom"/);

  const running = await createToolHandlers(stubClient()).odw_status({ workflowId: 'wf_run1' });
  assert.match(textOf(running), /"completed": 4/);
  assert.doesNotMatch(textOf(running), /"error"/);
});

test('odw_result passes wait through to the client', async () => {
  const client = stubClient();
  const handlers = createToolHandlers(client);
  await handlers.odw_result({ workflowId: 'wf_run1', wait: true });
  assert.deepEqual(client.calls[0], ['result', 'wf_run1', { wait: true }]);
  const response = await handlers.odw_result({});
  assert.equal(response.isError, true);
});

test('odw_list formats id/status/topology/created_at and handles empty', async () => {
  const empty = await createToolHandlers(stubClient()).odw_list({});
  assert.equal(textOf(empty), 'no workflows yet');

  const client = stubClient({
    list: async () => ({
      workflows: [{ workflow_id: 'wf_1', status: 'running', topology: 'parallel', created_at: 1718000000, root_prompt: 'x' }],
    }),
  });
  const listed = await createToolHandlers(client).odw_list({});
  assert.match(textOf(listed), /"id": "wf_1"/);
  assert.match(textOf(listed), /"topology": "parallel"/);
  assert.match(textOf(listed), /"created_at": 1718000000/);
});

test('odw_health summarizes daemon stats', async () => {
  const response = await createToolHandlers(stubClient()).odw_health({});
  assert.match(textOf(response), /daemon ok/);
  assert.match(textOf(response), /2 active workflow/);
});

// ── odw_control validation ───────────────────────────────────────────────────

test('odw_control validates action and workflowId', async () => {
  const client = stubClient();
  const handlers = createToolHandlers(client);
  const bad = await handlers.odw_control({ workflowId: 'wf_1', action: 'restart' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /pause\|resume\|stop/);
  const missing = await handlers.odw_control({ action: 'stop' });
  assert.equal(missing.isError, true);

  const ok = await handlers.odw_control({ workflowId: 'wf_1', action: 'pause' });
  assert.notEqual(ok.isError, true);
  assert.deepEqual(client.calls[0], ['control', 'wf_1', 'pause']);
});

// ── error wrapping ───────────────────────────────────────────────────────────

test('handlers never throw raw — client failures become isError text', async () => {
  const exploding = stubClient({
    health: async () => { throw new Error('daemon offline — start it with: odw-daemon start'); },
    get: async () => { throw new Error('daemon requires an auth token — copy it from ~/.odw/daemon.token or set ODW_DAEMON_TOKEN'); },
  });
  const handlers = createToolHandlers(exploding);

  const offline = await handlers.odw_health({});
  assert.equal(offline.isError, true);
  assert.match(textOf(offline), /error: daemon offline/);

  const unauthorized = await handlers.odw_status({ workflowId: 'wf_1' });
  assert.equal(unauthorized.isError, true);
  assert.match(textOf(unauthorized), /auth token/);

  // even undefined args must not throw
  const noArgs = await handlers.odw_run(undefined);
  assert.equal(noArgs.isError, true);
});
