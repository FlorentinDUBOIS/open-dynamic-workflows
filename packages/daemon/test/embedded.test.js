import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('host provider: callWithTools parses text-protocol tool calls for native hosts', async () => {
  const seen = [];
  const p = createHostProvider({
    invoke: async (job) => {
      seen.push(job);
      return '{"text":"reading","toolCalls":[{"id":"t1","name":"read_file","args":{"path":"src/a.js"}}]}';
    },
  });
  const result = await p.callWithTools({
    model: 'host:default',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'inspect src/a.js' }],
    tools: [{ name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } }],
  });
  assert.match(seen[0].prompt, /ODW_TEXT_TOOL_PROTOCOL/);
  assert.match(seen[0].prompt, /read_file/);
  assert.equal(result.text, 'reading');
  assert.deepEqual(result.toolCalls, [{ id: 't1', name: 'read_file', args: { path: 'src/a.js' } }]);
  assert.ok(result.tokensInput > 0);
  assert.ok(result.tokensOutput > 0);
});

test('host provider: callWithTools returns final text when no tool call is requested', async () => {
  const p = createHostProvider({ invoke: async () => '{"text":"final answer"}' });
  const result = await p.callWithTools({
    model: 'host:default',
    messages: [{ role: 'user', content: 'answer now' }],
    tools: [{ name: 'read_file', description: 'read a file', inputSchema: { type: 'object' } }],
  });
  assert.equal(result.text, 'final answer');
  assert.equal(result.toolCalls, undefined);
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

test('embedded: start exposes the workflow id before completion', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const orch = createEmbeddedOrchestrator({
    invoke: async () => { await gate; return { text: '{"result":"ok"}' }; },
    maxConcurrency: 1,
  });
  const started = await orch.start({
    prompt: 'wait',
    topology: 'pipeline',
    roles: [],
    estimate: { totalAgents: 1 },
    strategy: mergeStrategy({ budget: { model: 'host:default' } }),
    script: 'module.exports={execute:async()=>agent({role:"analysis",prompt:"wait",schema:{result:"string"}})}',
  });
  assert.match(started.workflowId, /^wf_/);
  assert.equal(orch.store.getWorkflow(started.workflowId).status, 'running');
  release();
  assert.equal((await started.completion).status, 'completed');
});

test('embedded: host-model text protocol executes workflow tools', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-embedded-tools-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.js'), 'module.exports = 1;', 'utf8');
    const calls = [];
    const orch = createEmbeddedOrchestrator({
      invoke: async (job) => {
        calls.push(job.prompt);
        if (calls.length === 1) {
          return '{"toolCalls":[{"id":"r1","name":"read_file","args":{"path":"src/a.js"}}],"text":"reading"}';
        }
        if (calls.length === 2) {
          assert.match(job.prompt, /module\.exports = 1/);
          return '{"text":"ready"}';
        }
        assert.match(job.prompt, /Respond with ONLY a single JSON object/);
        return '{"summary":"read module.exports = 1"}';
      },
      maxConcurrency: 1,
    });
    const { result } = await orch.run(plan(
      'async function execute(){ return await agent({ prompt: "inspect src/a.js", tools: ["read_file"], schema: { summary: "string" } }); } module.exports={execute};'
    ), { cwd: root });
    assert.deepEqual(result, { summary: 'read module.exports = 1' });
    assert.equal(calls.length, 3, 'one tool-call turn, one synthesis turn, one schema final turn');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('embedded: runs twenty tool-capable host agents concurrently', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-embedded-20-'));
  try {
    mkdirSync(join(root, 'sample'), { recursive: true });
    for (let i = 1; i <= 20; i++) {
      writeFileSync(join(root, 'sample', `item-${i}.txt`), `item ${i}: value-${i}`, 'utf8');
    }

    let active = 0;
    let maxActive = 0;
    const orch = createEmbeddedOrchestrator({
      invoke: async (job) => {
        active++;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const prompt = job.prompt;
          const content = prompt.match(/item (\d+): value-(\d+)/);
          if (content) {
            return `{"id":${content[1]},"value":"value-${content[2]}"}`;
          }
          const request = prompt.match(/inspect sample\/item-(\d+)\.txt/);
          if (request) {
            return `{"text":"reading","toolCalls":[{"id":"read-${request[1]}","name":"read_file","args":{"path":"sample/item-${request[1]}.txt"}}]}`;
          }
          return '{"id":0,"value":"unknown"}';
        } finally {
          active--;
        }
      },
      maxConcurrency: 20,
    });

    const { status, result } = await orch.run(plan(
      'async function execute(){ const ids = Array.from({ length: 20 }, (_, i) => i + 1); ' +
      'const rows = await parallel(ids.map((id) => () => agent({ prompt: "inspect sample/item-" + id + ".txt", tools: ["read_file"], schema: { id: "number", value: "string" } }))); ' +
      'return rows.sort((a, b) => a.id - b.id); } module.exports={execute};'
    ), { cwd: root });

    assert.equal(status, 'completed');
    assert.equal(result.length, 20);
    assert.deepEqual(result[0], { id: 1, value: 'value-1' });
    assert.deepEqual(result[19], { id: 20, value: 'value-20' });
    assert.equal(maxActive, 20, 'all twenty host calls can be in flight under maxConcurrency=20');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('embedded: explicit labelled fanout dispatches every requested worker without discovery', async () => {
  const prompts = [];
  const workerLabels = [];
  const orch = createEmbeddedOrchestrator({
    invoke: async (job) => {
      prompts.push(job.prompt);
      if (/Enumerate the concrete targets/.test(job.prompt)) {
        return '{"items":["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T"]}';
      }
      if (/Find false positives|Challenge the severity|What is MISSING/.test(job.prompt)) {
        return '{"approved":true,"confidence":0.9,"critique":"","rejectedItems":[]}';
      }
      if (/Merge verified results|Merge aggregated results/.test(job.prompt)) {
        return '{"summary":"done","details":[]}';
      }
      const label = job.prompt.match(/"label":"([A-Z])"/)?.[1] ?? '?';
      workerLabels.push(label);
      if (/Analyze ONE target/.test(job.prompt)) return '{"findings":[],"confidence":0.9}';
      return JSON.stringify({ label, result: `observation-${label}`, confidence: 0.9 });
    },
    maxConcurrency: 20,
  });

  const { status, result, plan: planned } = await orch.run(
    'workflow: Split into exactly 20 independent micro-agents labeled A through T. Each agent should return one short synthetic readiness observation. Synthesize all 20 observations.',
    { maxAgents: 21 }
  );
  assert.equal(status, 'completed');
  assert.equal(result.summary, 'done');
  assert.equal(planned.estimate.totalAgents, 21);
  assert.equal(prompts.some((p) => /Enumerate the concrete targets/.test(p)), false);
  assert.deepEqual(workerLabels, 'ABCDEFGHIJKLMNOPQRST'.split(''));
});

test('embedded: explicit labelled fanout preserves failed worker slots for synthesis', async () => {
  let synthesisContext;
  const orch = createEmbeddedOrchestrator({
    invoke: async (job) => {
      if (/ Context: /.test(job.prompt)) {
        synthesisContext = JSON.parse(job.prompt.split(' Context: ')[1].split('\n\nRespond with ONLY')[0]);
        return '{"summary":"done","details":[]}';
      }
      const label = job.prompt.match(/"label":"([A-Z])"/)?.[1] ?? '?';
      if (label === 'C') return 'not json';
      return JSON.stringify({ label, result: `observation-${label}`, confidence: 0.9 });
    },
    maxConcurrency: 5,
    maxAttempts: 1,
  });

  const { status } = await orch.run(
    'workflow: Split into exactly 5 independent agents labeled A through E. Each agent should return one short synthetic readiness observation. Synthesize all 5 observations.',
    { maxAgents: 6 }
  );
  assert.equal(status, 'completed');
  assert.equal(synthesisContext.work.length, 5);
  assert.deepEqual(synthesisContext.work.map((item) => item.label), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(synthesisContext.work[2].__odw_failed, true);
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
