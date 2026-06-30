import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStrategy } from 'odw-core';

const { createHostProvider } = await import('../src/providers/host.js');
const { createEmbeddedOrchestrator } = await import('../src/embedded.js');
const { createMemoryStore } = await import('../src/memory-store.js');

const plan = (script, budget = {}) => ({
  script,
  strategy: mergeStrategy({ budget: { model: 'host:default', ...budget } }),
  roles: [],
  topology: 'hybrid',
  estimate: { totalAgents: 1 },
  prompt: 'test',
});

// ── host provider ────────────────────────────────────────────────────────────

test('host provider: ESTIMATES token usage when the host reports none (budget safety rail)', async () => {
  const p = createHostProvider({ invoke: async () => 'a reasonably long reply that yields a nonzero token estimate' });
  const r = await p.call({ prompt: 'some prompt text', systemPrompt: 'sys' });
  assert.match(r.text, /reply/);
  assert.ok(r.tokensInput > 0, 'input tokens estimated (else budget never trips)');
  assert.ok(r.tokensOutput > 0, 'output tokens estimated');
});

test('host provider: uses reported usage when the host provides it', async () => {
  const p = createHostProvider({ invoke: async () => ({ text: 'x', usage: { input: 11, output: 7 } }) });
  const r = await p.call({ prompt: 'p' });
  assert.deepEqual([r.tokensInput, r.tokensOutput], [11, 7]);
});

test('host provider: requires an invoke function', () => {
  assert.throws(() => createHostProvider({}), /invoke/);
});

// ── embedded orchestrator (real sandbox + queue + runtime, mock host model) ──────

test('embedded: runs a real orchestration script through the sandbox on the host model', async () => {
  const seen = [];
  const orch = createEmbeddedOrchestrator({
    invoke: async (job) => { seen.push(job.prompt); return 'RESULT:' + job.prompt.slice(0, 3); },
    maxConcurrency: 2,
  });
  const { status, result } = await orch.run(plan(
    'async function execute(){ const a = await agent({prompt:"alpha"}); ' +
    'const b = await parallel([()=>agent({prompt:"beta"}), ()=>agent({prompt:"gamma"})]); ' +
    'return { a: a, b: b }; } module.exports = { execute };'
  ));
  assert.equal(status, 'completed');
  assert.equal(result.a, 'RESULT:alp');
  assert.deepEqual(result.b, ['RESULT:bet', 'RESULT:gam']);
  assert.equal(seen.length, 3, 'all three agent() calls dispatched through the host model');
});

test('embedded: budget hard-stop trips on ESTIMATED host usage (no unbounded loop — the BLOCKER fix)', async () => {
  const orch = createEmbeddedOrchestrator({
    invoke: async () => 'x'.repeat(4000), // ~1000 estimated output tokens/call
    maxConcurrency: 1,
  });
  // Distinct prompts per iteration → distinct cache nodes → real provider calls
  // that accumulate budget (identical prompts would dedupe via the node cache).
  const { result } = await orch.run(plan(
    'async function execute(){ let n=0; for (let i=0;i<50;i++){ try { await agent({prompt:"call-"+i+"-"+"x".repeat(4000)}); n++; } catch(e){ return { stoppedAfter:n }; } } return { stoppedAfter:n }; } module.exports={execute};',
    { maxTokens: 6000, maxCostUSD: 1000 }
  ));
  assert.ok(result.stoppedAfter < 50, `budget cap interrupted the loop (ran ${result.stoppedAfter}/50)`);
});

test('embedded: an explicit resolveProvider can replace the agent backend', async () => {
  const orch = createEmbeddedOrchestrator({
    resolveProvider: () => ({ provider: { name: 'stub', call: async () => ({ text: 'STUB', tokensInput: 1, tokensOutput: 1 }) }, model: 'host:default' }),
  });
  const { result } = await orch.run(plan('async function execute(){ return await agent({prompt:"hi"}); } module.exports={execute};'));
  assert.equal(result, 'STUB');
});

// ── memory store ─────────────────────────────────────────────────────────────

test('embedded: prompt runs honor maxAgents with the real planner and host backend', async () => {
  const prompts = [];
  const orch = createEmbeddedOrchestrator({
    invoke: async (job) => {
      prompts.push(job.prompt);
      if (/Enumerate the concrete targets/.test(job.prompt)) return '{"items":["a","b","c","d","e"]}';
      if (/Find false positives|Challenge the severity|What is MISSING/.test(job.prompt)) {
        return '{"approved":true,"confidence":0.9,"critique":"","rejectedItems":[]}';
      }
      if (/Merge verified results/.test(job.prompt)) return '{"summary":"done","details":[]}';
      return '{"findings":[],"confidence":0.9}';
    },
    maxConcurrency: 6,
  });
  const { status, result, plan: planned } = await orch.run('workflow: audit every file in src for security bugs', { maxAgents: 6 });
  assert.equal(status, 'completed');
  assert.equal(result.summary, 'done');
  assert.equal(planned.estimate.totalAgents, 6);
  assert.equal(prompts.length, 6, '1 discovery + 1 capped work item + 3 critics + 1 synthesis');
});

test('memory store: round-trips a workflow, nodes, totals, checkpoints', () => {
  const s = createMemoryStore();
  s.insertWorkflow({ workflow_id: 'wf1', status: 'running', root_prompt: 'p', compiled_script: 's', execution_strategy: '{}', topology: 'hybrid', total_agents: 2, budget_max_usd: 10 });
  assert.equal(s.getWorkflow('wf1').status, 'running');
  assert.equal(s.getWorkflow('wf1').tokens_input, 0, 'counters default to 0 (budget seed reads these)');
  s.upsertNode({ node_id: 'n1', workflow_id: 'wf1', phase_name: 'P', role_id: 'r', status: 'running', prompt: 'x', max_retries: 3 });
  s.completeNode({ node_id: 'n1', output: '{"a":1}', tokens_input: 5, tokens_output: 3, cost_usd: 0, duration_ms: 10 });
  assert.deepEqual(JSON.parse(s.completedNodes('wf1')[0].output), { a: 1 });
  s.bumpWorkflowTotals({ workflow_id: 'wf1', completed: 1, failed: 0, tokens_input: 5, tokens_output: 3, cost_usd: 0 });
  assert.equal(s.getWorkflow('wf1').completed_agents, 1);
  s.setWorkflowResult('wf1', 'completed', { done: true });
  assert.deepEqual(JSON.parse(s.getWorkflow('wf1').result), { done: true });
  assert.deepEqual(s.listInterrupted(), [], 'embedded store never resumes across sessions');
});
