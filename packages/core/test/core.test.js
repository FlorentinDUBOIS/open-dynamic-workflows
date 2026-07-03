import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectTrigger } from '../src/trigger.js';
import { costFor } from '../src/pricing.js';
import { defaultStrategy, mergeStrategy } from '../src/strategy.js';
import { decompose } from '../src/decompose.js';
import { selectTopology } from '../src/topology.js';
import { buildRoles, BUILTIN_ROLES } from '../src/roles.js';
import { generateScript } from '../src/script-generator.js';
import { estimate } from '../src/estimator.js';
import { compileSchema, validateAgainstSchema, extractJson, normalizeSchema } from '../src/schema.js';
import { createPlan } from '../src/planner.js';

// ── trigger ──────────────────────────────────────────────────────────────────

test('trigger: workflow intent phrases fire', () => {
  for (const p of [
    'workflow: audit all API endpoints for missing auth',
    'run a workflow to migrate this codebase to TypeScript',
    'please use a workflow to check every file',
    'I want a dynamic workflow that finds flaky tests',
  ]) {
    const r = detectTrigger(p);
    assert.equal(r.triggered, true, p);
    assert.equal(r.mode, 'workflow', p);
  }
});

test('trigger: bare keyword mentions do NOT fire (false-positive guard)', () => {
  for (const p of [
    'explain my git workflow to me',
    'why is the ci workflow file failing?',
    'open the workflows tab',
    'what is a workflow engine?',
  ]) {
    assert.equal(detectTrigger(p).triggered, false, p);
  }
});

test('trigger: ultracode fires anywhere and is stripped from the clean prompt', () => {
  const r = detectTrigger('ultracode migrate everything to ESM');
  assert.equal(r.mode, 'ultracode');
  assert.ok(!/ultracode/i.test(r.cleanPrompt));
});

test('trigger: /deep-research fires', () => {
  const r = detectTrigger('/deep-research React Server Components patterns');
  assert.equal(r.mode, 'deep-research');
  assert.match(r.cleanPrompt, /React Server Components/);
});

test('trigger: empty input is safe', () => {
  assert.deepEqual(detectTrigger(''), { triggered: false, mode: null, cleanPrompt: '' });
  assert.equal(detectTrigger(undefined).triggered, false);
});

// ── pricing ──────────────────────────────────────────────────────────────────

test('pricing: known model exact math', () => {
  // sonnet: 3 in / 15 out per MTok → 1M in + 1M out = $18
  assert.equal(costFor('claude-sonnet-4-6', 1_000_000, 1_000_000), 18);
});

test('pricing: date-suffixed alias resolves to family', () => {
  assert.equal(costFor('claude-haiku-4-5-20251001', 1_000_000, 0), 1);
});

test('pricing: local and free models are zero-cost', () => {
  assert.equal(costFor('ollama:llama3', 5_000_000, 5_000_000), 0);
  assert.equal(costFor('minimax-m3-free', 1_000_000, 1_000_000), 0);
});

test('pricing: unknown model falls back to default, never NaN', () => {
  const c = costFor('mystery-model-x', 100_000, 100_000);
  assert.ok(Number.isFinite(c) && c > 0);
});

// ── strategy ─────────────────────────────────────────────────────────────────

test('strategy: defaults match the documented contract', () => {
  const s = defaultStrategy();
  assert.equal(s.concurrency.max, 16);
  assert.equal(s.retry.maxAttempts, 3);
  assert.equal(s.budget.alertAtPercent, 80);
  assert.equal(s.timeouts.perAgent, 120);
  assert.equal(s.git.branchPrefix, 'odw/');
  assert.deepEqual(s.safety.requireApprovalFor, ['write_file', 'run_bash', 'git_commit']);
});

test('strategy: overrides merge deep and hard limits clamp', () => {
  const s = mergeStrategy({ concurrency: { max: 9999 }, budget: { maxCostUSD: 100000 }, timeouts: { perAgent: 30 } });
  assert.equal(s.concurrency.max, 100); // ceiling
  assert.equal(s.budget.maxCostUSD, 500); // ceiling
  assert.equal(s.timeouts.perAgent, 30);
  assert.equal(s.retry.maxAttempts, 3); // untouched default survives
});

// ── decompose / topology / roles ─────────────────────────────────────────────

test('decompose: audit prompt yields discovery→fanout work→verify→synthesize', () => {
  const g = decompose('audit all API endpoints for missing auth checks');
  const ids = g.tasks.map((t) => t.id);
  assert.deepEqual(ids, ['discover', 'work', 'verify', 'synthesize']);
  const work = g.tasks[1];
  assert.equal(work.parallelizable, true);
  assert.equal(work.fanoutSource, 'discover.items');
  assert.ok(g.root.estimatedTotalAgents > 10);
});

test('decompose: simple prompt stays small with no verification', () => {
  const g = decompose('rename this function', { complexityHint: 'low' });
  assert.ok(!g.tasks.some((t) => t.type === 'verification'));
  assert.equal(g.tasks.find((t) => t.id === 'work').parallelizable, false);
});

test('decompose: scrutiny-class prompts (review/bug/inspect) get a verification pass', () => {
  for (const p of ['review the files for bugs', 'inspect this module for issues', 'check the code quality', 'find flaws in src']) {
    const g = decompose(p, { complexityHint: 'low' });
    assert.ok(g.tasks.some((t) => t.type === 'verification'), `"${p}" should plan verification`);
  }
});

test('decompose: explicit labelled agent fanout is deterministic, not discovery-dependent', () => {
  const g = decompose('Split into exactly 20 independent micro-agents labeled A through T. Each agent should return one short synthetic readiness observation. Synthesize all 20 observations.');
  assert.equal(g.root.explicitFanout.count, 20);
  assert.deepEqual(g.tasks.map((t) => t.id), ['work', 'synthesize']);
  const work = g.tasks[0];
  assert.equal(work.parallelizable, true);
  assert.equal(work.fanoutSource, undefined);
  assert.equal(work.fanoutItems.length, 20);
  assert.deepEqual(work.fanoutItems.slice(0, 3).map((item) => item.label), ['A', 'B', 'C']);
  assert.equal(work.fanoutItems.at(-1).label, 'T');
  assert.equal(g.root.estimatedTotalAgents, 21, 'twenty worker agents plus one synthesis agent');
});

test('decompose: external graph is validated (unknown dep rejected)', () => {
  assert.throws(
    () => decompose('x', { graph: { tasks: [{ id: 'a', dependencies: ['ghost'] }] } }),
    /unknown "ghost"/
  );
});

test('topology: fanout+verification+phases → hybrid; fanout-only → mapreduce; chain → pipeline', () => {
  const audit = decompose('audit all API endpoints for missing auth checks');
  assert.equal(selectTopology(audit), 'hybrid');

  const fanoutOnly = decompose('summarize every file in src', { complexityHint: 'medium' });
  // medium fans out, may not verify
  const topo = selectTopology(fanoutOnly);
  assert.ok(['mapreduce', 'hybrid'].includes(topo));

  const chain = decompose('rename this function', { complexityHint: 'low' });
  assert.equal(selectTopology(chain), 'pipeline');
});

test('roles: every task role resolves, built-ins win, schemas attach', () => {
  const g = decompose('audit all API endpoints for missing auth checks');
  const roles = buildRoles(g);
  const ids = roles.map((r) => r.id);
  assert.ok(ids.includes('discovery-agent'));
  assert.ok(ids.includes('synthesis-agent'));
  for (const r of roles) {
    assert.ok(r.systemPrompt.length > 20);
    assert.ok(Array.isArray(r.allowedTools));
    assert.ok(r.outputSchema);
  }
  assert.ok(Object.keys(BUILTIN_ROLES).length >= 7);
});

// ── script generation ────────────────────────────────────────────────────────

test('script-generator: output is valid JS with the documented shape', () => {
  const g = decompose('audit all API endpoints for missing auth checks');
  const roles = buildRoles(g);
  const strategy = defaultStrategy();
  const src = generateScript(g, 'hybrid', roles, strategy);

  assert.match(src, /async function execute\(context\)/);
  assert.match(src, /module\.exports = \{ execute \};/);
  assert.match(src, /parallel\(/);
  assert.match(src, /verify\(\{/);
  assert.match(src, /checkpoint\(/);
  assert.match(src, /maxConcurrency: 16/);
  assert.match(src, /tools: \["read_file","search","glob"\]/, 'discovery agents should receive filesystem discovery tools');
  assert.match(src, /tools: \["read_file","search"\]/, 'analysis agents should receive read/search tools');
  assert.match(src, /role: 'completeness-checker', tools: \['read_file', 'search'\]/, 'verification critics should receive their tools');
  // fan-out must be per-item resilient: each agent catches its own failure and
  // failed items are filtered out rather than rejecting the whole batch
  assert.match(src, /__odw_failed/);
  assert.match(src, /\.catch\(/);
  assert.match(src, /_ok = .*_raw\.filter/);
  // must be syntactically valid
  new Function(src);
});

test('script-generator: cycle in dependencies throws', () => {
  const g = {
    root: { id: 'root', prompt: 'x', complexity: 'low', estimatedTotalAgents: 2, estimatedCostUSD: 0, estimatedDurationMinutes: 0 },
    tasks: [
      { id: 'a', description: '', type: 'analysis', dependencies: ['b'], parallelizable: false, role: 'analysis-agent', expectedOutputSchema: {}, estimatedTokens: 1000 },
      { id: 'b', description: '', type: 'analysis', dependencies: ['a'], parallelizable: false, role: 'analysis-agent', expectedOutputSchema: {}, estimatedTokens: 1000 },
    ],
  };
  assert.throws(() => generateScript(g, 'pipeline', buildRoles(g), defaultStrategy()), /cycle/);
});

// ── estimator ────────────────────────────────────────────────────────────────

test('estimator: produces finite, plausible numbers', () => {
  const g = decompose('audit all API endpoints for missing auth checks');
  const e = estimate(g, defaultStrategy());
  assert.ok(e.totalAgents >= 4);
  assert.equal(e.maxConcurrent, Math.min(16, e.totalAgents));
  assert.ok(e.tokens > 0 && Number.isFinite(e.costUSD) && e.costUSD > 0);
  assert.ok(e.minutes >= 1);
});

// ── schema / extraction ──────────────────────────────────────────────────────

test('schema: shorthand normalizes and validates', () => {
  const v = compileSchema({ findings: 'array', confidence: 'number' });
  assert.equal(v({ findings: [], confidence: 0.9 }).valid, true);
  const bad = v({ findings: 'nope', confidence: 'high' });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.length >= 2);
});

test('schema: formal JSON Schema passes through', () => {
  const formal = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
  assert.deepEqual(normalizeSchema(formal), formal);
  assert.equal(validateAgainstSchema({ n: 3 }, formal).valid, true);
  assert.equal(validateAgainstSchema({ n: 3.5 }, formal).valid, false);
});

test('extractJson: direct, fenced, embedded, trailing-comma', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a": 1}\n```\nDone.'), { a: 1 });
  assert.deepEqual(extractJson('The answer is {"a": {"b": [1,2]}} as requested'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('```json\n{"a": 1,}\n```'), { a: 1 });
  assert.equal(extractJson('no json here at all'), undefined);
  assert.equal(extractJson(undefined), undefined);
});

test('extractJson: tolerates weak-model output (single quotes, unquoted keys, Python literals)', () => {
  assert.deepEqual(extractJson("{'a': 1, 'b': 'two'}"), { a: 1, b: 'two' });
  assert.deepEqual(extractJson('{findings: [], confidence: 0.9}'), { findings: [], confidence: 0.9 });
  assert.deepEqual(extractJson('{"ok": True, "bad": False, "x": None}'), { ok: true, bad: false, x: null });
  assert.deepEqual(
    extractJson('Sure! Here is the result:\n{approved: True, confidence: 0.8,}\nLet me know.'),
    { approved: true, confidence: 0.8 }
  );
});

// ── planner (end-to-end, no LLM) ─────────────────────────────────────────────

test('createPlan: full plan artifact from a single prompt', async () => {
  const plan = await createPlan('workflow: audit all API endpoints for missing auth checks');
  assert.match(plan.planId, /^plan_/);
  assert.equal(plan.topology, selectTopology(plan.taskGraph));
  assert.ok(plan.roles.length >= 3);
  assert.ok(plan.estimate.totalAgents > 1);
  assert.match(plan.script, /module\.exports = \{ execute \};/);
  new Function(plan.script); // valid JS
  assert.ok(plan.taskGraph.root.estimatedCostUSD > 0);
});

test('createPlan: maxAgents is a hard runtime cap, not just an estimate hint', async () => {
  const plan = await createPlan('workflow: audit every file in src for security bugs', {
    maxAgents: 20,
    strategy: { concurrency: { max: 20 } },
  });
  assert.equal(plan.estimate.totalAgents, 20);
  assert.equal(plan.taskGraph.root.agentCap.maxAgents, 20);
  assert.equal(plan.taskGraph.root.agentCap.capped, true);
  assert.match(plan.script, /const __odw_agentCap = 20/);
  assert.match(plan.script, /__odw_takeAgentSlots\(work_items_all\.length, "Work", 4\)/);
  assert.match(plan.script, /work_items_all\.slice\(0, work_slots\)/);
  assert.match(plan.script, /__odw_takeAgentSlots\(verify_critics\.length, "Verify critics", 1\)/);
  new Function(plan.script);
});

test('createPlan: explicit labelled fanout compiles fixed work items without a discovery agent', async () => {
  const plan = await createPlan('workflow: Split into exactly 20 independent micro-agents labeled A through T. Each agent should return one short synthetic readiness observation. Synthesize all 20 observations.', {
    strategy: { concurrency: { max: 20 } },
  });
  assert.equal(plan.estimate.totalAgents, 21);
  assert.deepEqual(plan.taskGraph.tasks.map((t) => t.id), ['work', 'synthesize']);
  assert.doesNotMatch(plan.script, /Enumerate the concrete targets/);
  assert.match(plan.script, /const items = \[\{"label":"A"/);
  assert.match(plan.script, /"label":"T"/);
  new Function(plan.script);
});

test('createPlan: maxAgents rejects caps below required serial phases', async () => {
  await assert.rejects(
    () => createPlan('workflow: audit every file in src for security bugs', { maxAgents: 4 }),
    /minimum is 5/
  );
});

test('createPlan: llmDecompose failure falls back to heuristic', async () => {
  const plan = await createPlan('audit everything', {
    llmDecompose: async () => { throw new Error('planner model down'); },
  });
  assert.ok(plan.taskGraph.tasks.length >= 3);
});
