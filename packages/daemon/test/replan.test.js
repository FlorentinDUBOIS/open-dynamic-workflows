/**
 * replan() — mid-execution replanning: the guest asks the host planner for a
 * new sub-plan, which executes in a FRESH sandbox inside the SAME workflow
 * (shared bridges → shared budget/cache/abort). Runtime tests follow the
 * tool-loop conventions (createRuntime + memory store + fake queue); guest-side
 * tests drive the sandbox directly; the db test uses a temp sqlite file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeStrategy } from 'odw-core';

const { createRuntime } = await import('../src/runtime.js');
const { createMemoryStore } = await import('../src/memory-store.js');
const { createSandbox } = await import('../src/sandbox.js');
const { openDatabase, createStore } = await import('../src/db.js');
const { createEmbeddedOrchestrator } = await import('../src/embedded.js');

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const okResult = (output) => ({ output, text: String(output), tokensInput: 1, tokensOutput: 1, durationMs: 1 });

function makeRuntime(executeAgent, { planner, store = createMemoryStore(), config = {} } = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const queue = { executeAgent, size: () => 0, pending: () => 0 };
  const runtime = createRuntime({
    store,
    queue,
    config: { models: { default: 'def-model' }, daemon: { maxConcurrency: 2 }, ...config },
    events,
    logger: noopLogger,
    planner,
  });
  return { runtime, store };
}

const plan = (script, strategyOverrides = {}) => ({
  script,
  strategy: mergeStrategy({ budget: { model: 'base-model' }, ...strategyOverrides }),
  roles: [],
  topology: 'hybrid',
  estimate: { totalAgents: 1 },
  prompt: 'test',
});

/** Minimal sub-plan shape: the bridge consumes only {script, topology}. */
const subPlan = (script) => ({ script, topology: 'pipeline' });

const resultOf = (store, workflowId) => JSON.parse(store.getWorkflow(workflowId).result);

// ── happy path ───────────────────────────────────────────────────────────────

test('replan: plans via the injected planner, runs the sub-script, returns its result; usage flows into the parent', async () => {
  const plannerCalls = [];
  const planner = async (prompt, opts) => {
    plannerCalls.push({ prompt, opts });
    return subPlan(
      'async function execute(){ const r = await agent({ prompt: "sub-agent-work" }); ' +
      'return { marker: "SUB", agent: r }; } module.exports = { execute };'
    );
  };
  const { runtime, store } = makeRuntime(async (job) => okResult('AGENT:' + job.prompt), { planner });
  const script =
    'async function execute(){ const sub = await replan("new plan please", { reason: "too many findings" }); ' +
    'return { sub: sub }; } module.exports = { execute };';
  const workflowId = await runtime.execWorkflow(plan(script), undefined, { wait: true });

  const row = store.getWorkflow(workflowId);
  assert.equal(row.status, 'completed');
  const result = resultOf(store, workflowId);
  assert.equal(result.sub.marker, 'SUB');
  assert.equal(result.sub.agent, 'AGENT:sub-agent-work');
  assert.equal(plannerCalls.length, 1);
  assert.equal(plannerCalls[0].prompt, 'new plan please');
  assert.equal(plannerCalls[0].opts.strategy.budget.model, 'base-model', 'planner receives the merged sub-strategy');
  // the sub-agent ran through the SAME agent bridge → parent workflow accounting
  assert.equal(row.completed_agents, 1);
  assert.ok(row.tokens_input >= 1 && row.tokens_output >= 1, 'sub-agent usage flowed into the parent totals');
  // journal carries the replan event
  const replans = store.journalAfter(workflowId, 0).filter((r) => r.operation === 'replan').map((r) => JSON.parse(r.payload));
  assert.equal(replans.length, 1);
  assert.deepEqual(
    { reason: replans[0].reason, depth: replans[0].depth, count: replans[0].count, cached: replans[0].cached, topology: replans[0].topology },
    { reason: 'too many findings', depth: 0, count: 1, cached: false, topology: 'pipeline' }
  );
});

test('replan: opts.strategy deep-merges over the parent strategy and reaches the sub-script context', async () => {
  const planner = async () => subPlan(
    'async function execute(context){ return { maxTokens: context.strategy.budget.maxTokens, ' +
    'model: context.strategy.budget.model }; } module.exports = { execute };'
  );
  const { runtime, store } = makeRuntime(async () => okResult('x'), { planner });
  const script =
    'async function execute(){ return await replan("shrink scope", { strategy: { budget: { maxTokens: 5000 } } }); } ' +
    'module.exports = { execute };';
  const workflowId = await runtime.execWorkflow(plan(script), undefined, { wait: true });
  const result = resultOf(store, workflowId);
  assert.equal(result.maxTokens, 5000, 'override applied to the sub-strategy');
  assert.equal(result.model, 'base-model', 'parent budget fields survive a deep partial override');
});

test('replan: sub-script args default to the parent args; opts.args overrides them', async () => {
  const planner = async () => subPlan('async function execute(){ return args(); } module.exports = { execute };');
  const { runtime, store } = makeRuntime(async () => okResult('x'), { planner });
  const script =
    'async function execute(){' +
    ' const inherited = await replan("a");' +
    ' const explicit = await replan("b", { args: { sub: 1 } });' +
    ' return { inherited: inherited, explicit: explicit }; } module.exports = { execute };';
  const workflowId = await runtime.execWorkflow(plan(script), undefined, { wait: true, args: { root: true } });
  const result = resultOf(store, workflowId);
  assert.deepEqual(result.inherited, { root: true });
  assert.deepEqual(result.explicit, { sub: 1 });
});

// ── bounds ───────────────────────────────────────────────────────────────────

test('replan: exceeding maxReplans (default 2) throws a clear error', async () => {
  const planner = async () => subPlan('async function execute(){ return "ok"; } module.exports = { execute };');
  const { runtime, store } = makeRuntime(async () => okResult('x'), { planner });
  const script =
    'async function execute(){' +
    ' await replan("one"); await replan("two");' +
    ' try { await replan("three"); return "no-error"; } catch (e) { return "caught:" + e.message; } }' +
    ' module.exports = { execute };';
  const workflowId = await runtime.execWorkflow(plan(script), undefined, { wait: true });
  const result = resultOf(store, workflowId);
  assert.match(result, /^caught:/);
  assert.match(result, /maxReplans \(2\)/);
});

test('replan: a sub-script replanning again exceeds maxDepth (default 1) — bounds-rejected before planning', async () => {
  let plans = 0;
  const planner = async () => {
    plans++;
    return subPlan(
      'async function execute(){ try { await replan("deeper"); return "no-error"; } ' +
      'catch (e) { return "caught:" + e.message; } } module.exports = { execute };'
    );
  };
  const { runtime, store } = makeRuntime(async () => okResult('x'), { planner });
  const script = 'async function execute(){ return await replan("level one"); } module.exports = { execute };';
  const workflowId = await runtime.execWorkflow(plan(script), undefined, { wait: true });
  const result = resultOf(store, workflowId);
  assert.match(result, /^caught:/);
  assert.match(result, /maxDepth \(1\)/);
  assert.equal(plans, 1, 'the nested call never reached the planner');
});

test('replan: nesting is allowed up to maxDepth when the strategy raises it', async () => {
  let plans = 0;
  const planner = async () => subPlan(++plans === 1
    ? 'async function execute(){ return "L2:" + await replan("go deeper"); } module.exports = { execute };'
    : 'async function execute(){ return "L3"; } module.exports = { execute };');
  const { runtime, store } = makeRuntime(async () => okResult('x'), { planner });
  const script = 'async function execute(){ return "L1:" + await replan("level"); } module.exports = { execute };';
  const workflowId = await runtime.execWorkflow(
    plan(script, { replan: { maxDepth: 2, maxReplans: 3 } }), undefined, { wait: true });
  assert.equal(resultOf(store, workflowId), 'L1:L2:L3', 'depth-incremented wrapper chains through both levels');
  assert.equal(plans, 2);
});

// ── resume determinism ───────────────────────────────────────────────────────

test('replan: a re-run of the SAME workflowId reuses the PERSISTED sub-script, not a fresh plan', async () => {
  const store = createMemoryStore();
  let plannerCalls = 0;
  const script = 'async function execute(){ return await replan("adapt"); } module.exports = { execute };';

  const plannerA = async () => {
    plannerCalls++;
    return subPlan('async function execute(){ return "FIRST-PLAN"; } module.exports = { execute };');
  };
  const first = makeRuntime(async () => okResult('x'), { planner: plannerA, store });
  const workflowId = await first.runtime.execWorkflow(plan(script), undefined, { wait: true });
  assert.equal(resultOf(store, workflowId), 'FIRST-PLAN');
  assert.equal(plannerCalls, 1);

  // same workflowId, same store, but a planner that would now plan DIFFERENTLY
  const plannerB = async () => {
    plannerCalls++;
    return subPlan('async function execute(){ return "SECOND-PLAN"; } module.exports = { execute };');
  };
  const second = makeRuntime(async () => okResult('x'), { planner: plannerB, store });
  await second.runtime.execWorkflow(plan(script), undefined, { wait: true, workflowId });
  assert.equal(resultOf(store, workflowId), 'FIRST-PLAN', 'the persisted sub-script executed verbatim');
  assert.equal(plannerCalls, 1, 'the planner was NOT consulted again on the resumed run');

  const replans = store.journalAfter(workflowId, 0).filter((r) => r.operation === 'replan').map((r) => JSON.parse(r.payload));
  assert.deepEqual(replans.map((r) => r.cached), [false, true], 'first run planned, second run replayed the checkpoint');
});

// ── configuration failures ───────────────────────────────────────────────────

test('replan: no planner configured → clear error', async () => {
  const { runtime, store } = makeRuntime(async () => okResult('x'), {}); // no planner
  const script =
    'async function execute(){ try { await replan("p"); return "no-error"; } ' +
    'catch (e) { return "caught:" + e.message; } } module.exports = { execute };';
  const workflowId = await runtime.execWorkflow(plan(script), undefined, { wait: true });
  assert.match(resultOf(store, workflowId), /replan is not configured in this engine/);
});

test('replan: sandbox without a replan bridge rejects with the update-odw-daemon message', async () => {
  const sandbox = await createSandbox({ hostBridges: { agent: async () => ({}) } });
  const result = await sandbox.runScript(
    'async function execute(){ try { await replan("p"); return "no-error"; } ' +
    'catch (e) { return "caught:" + e.message; } } module.exports = { execute };'
  );
  sandbox.dispose();
  assert.match(result, /^caught:/);
  assert.match(result, /replan is not available in this engine — update odw-daemon/);
});

test('replan: guest validates the prompt and passes {prompt, opts} through the bridge', async () => {
  const payloads = [];
  const sandbox = await createSandbox({
    hostBridges: { agent: async () => ({}), replan: async (p) => { payloads.push(p); return { sub: true }; } },
  });
  const result = await sandbox.runScript(`
    async function execute() {
      const r = await replan("new plan", { reason: "budget" });
      const bad = [];
      try { replan(""); bad.push("no-throw-empty"); } catch (e) { bad.push(e.message); }
      try { replan(42); bad.push("no-throw-number"); } catch (e) { bad.push(e.message); }
      return { r: r, bad: bad };
    }
    module.exports = { execute };
  `);
  sandbox.dispose();
  assert.deepEqual(result.r, { sub: true });
  assert.deepEqual(payloads, [{ prompt: 'new plan', opts: { reason: 'budget' } }]);
  assert.match(result.bad[0], /non-empty prompt string/, 'empty prompt rejected guest-side');
  assert.match(result.bad[1], /non-empty prompt string/, 'non-string prompt rejected guest-side');
});

// ── checkpointByKey (store parity) ───────────────────────────────────────────

test('checkpointByKey: sqlite store returns the latest row for a key, scoped to the workflow', () => {
  const home = mkdtempSync(join(tmpdir(), 'odw-replan-db-'));
  const db = openDatabase(join(home, 'replan.db'));
  const store = createStore(db);
  for (const id of ['wf_a', 'wf_b']) {
    store.insertWorkflow({
      workflow_id: id, status: 'running', root_prompt: 'p', compiled_script: 's',
      execution_strategy: '{}', topology: 'hybrid', total_agents: 0, budget_max_usd: 1,
    });
  }
  store.insertCheckpoint({ checkpoint_id: 'cp_1', workflow_id: 'wf_a', phase_name: 'P', checkpoint_key: 'k', state_data: '{"script":"old"}', agent_results: null });
  store.insertCheckpoint({ checkpoint_id: 'cp_2', workflow_id: 'wf_a', phase_name: 'P', checkpoint_key: 'k', state_data: '{"script":"new"}', agent_results: null });
  store.insertCheckpoint({ checkpoint_id: 'cp_3', workflow_id: 'wf_b', phase_name: 'P', checkpoint_key: 'k', state_data: '{"script":"other-wf"}', agent_results: null });
  assert.equal(JSON.parse(store.checkpointByKey('wf_a', 'k').state_data).script, 'new', 'same-second duplicate: insertion-order latest wins');
  assert.equal(JSON.parse(store.checkpointByKey('wf_b', 'k').state_data).script, 'other-wf', 'scoped to the workflow');
  assert.ok(!store.checkpointByKey('wf_a', 'missing'), 'no match → falsy');
  store.close();
  rmSync(home, { recursive: true, force: true });
});

test('checkpointByKey: memory store API parity (insertion-order latest match)', () => {
  const s = createMemoryStore();
  s.insertCheckpoint({ checkpoint_id: 'cp_1', workflow_id: 'wf_m', phase_name: 'P', checkpoint_key: 'k', state_data: '{"script":"old"}', agent_results: null });
  s.insertCheckpoint({ checkpoint_id: 'cp_2', workflow_id: 'wf_m', phase_name: 'P', checkpoint_key: 'k', state_data: '{"script":"new"}', agent_results: null });
  assert.equal(JSON.parse(s.checkpointByKey('wf_m', 'k').state_data).script, 'new');
  assert.equal(s.checkpointByKey('wf_m', 'missing'), null);
  assert.equal(s.checkpointByKey('wf_other', 'k'), null);
});

// ── embedded orchestrator ────────────────────────────────────────────────────

test('embedded: replan works via the wired heuristic planner (no planning model)', async () => {
  const prompts = [];
  const orch = createEmbeddedOrchestrator({
    invoke: async (job) => {
      prompts.push(job.prompt);
      const instruction = String(job.prompt).split(' Context: ')[0];
      if (/Enumerate the concrete targets/i.test(instruction)) return JSON.stringify({ items: ['helper.js'] });
      if (/Analyze ONE target/i.test(instruction)) return JSON.stringify({ findings: [{ note: 'mock finding' }], confidence: 0.9 });
      if (/final deliverable/i.test(instruction)) return JSON.stringify({ summary: 'embedded sub-plan done', details: [] });
      return JSON.stringify({ result: 'ok' });
    },
    maxConcurrency: 2,
  });
  const { status, result } = await orch.run(plan(
    'async function execute(){ const sub = await replan("rename this helper function", { reason: "plan drift" }); ' +
    'return { summary: sub.summary }; } module.exports = { execute };',
    { budget: { model: 'host:default' } }
  ));
  assert.equal(status, 'completed');
  assert.equal(result.summary, 'embedded sub-plan done', 'the heuristic sub-plan executed through to synthesis');
  assert.ok(prompts.some((p) => /Enumerate the concrete targets/i.test(p)), 'heuristic discovery agent dispatched on the host model');
});
