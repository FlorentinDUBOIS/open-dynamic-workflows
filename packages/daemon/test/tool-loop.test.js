/**
 * Model-side tool-use loop: agent({tools:[...]}) drives a provider-mapped
 * tool loop in the queue (fake providers are plain objects via the custom
 * resolveProvider, per unit.test.js conventions), the manifest maps named
 * args to the executor's positional order, and the runtime bridge whitelists
 * tools / bypasses the resume cache / resolves model tier aliases.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeStrategy } from 'odw-core';

const { createAgentQueue } = await import('../src/agent-queue.js');
const { createToolExecutor, TOOL_MANIFEST, toolDefinitionsFor, positionalToolArgs } = await import('../src/tools.js');
const { createRuntime } = await import('../src/runtime.js');
const { createMemoryStore } = await import('../src/memory-store.js');
const { defaultConfig } = await import('../src/config.js');

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

// Snapshot the (mutated-in-place) neutral transcript; it is JSON-safe by design.
const clone = (value) => JSON.parse(JSON.stringify(value));

function toolQueue(provider, opts = {}) {
  return createAgentQueue({
    maxConcurrency: 2,
    retry: { maxAttempts: opts.maxAttempts ?? 3, backoff: 'linear' },
    perAgentTimeout: opts.perAgentTimeout ?? 5,
    resolveProvider: () => ({ provider, model: opts.model ?? 'fake-model' }),
    logger: opts.logger ?? noopLogger,
  });
}

// ── manifest ─────────────────────────────────────────────────────────────────

test('manifest: definitions resolve, unknown names rejected with the valid-names list', () => {
  const defs = toolDefinitionsFor(['read_file', 'git']);
  assert.deepEqual(defs.map((d) => d.name), ['read_file', 'git']);
  assert.deepEqual(defs[0].inputSchema.required, ['path']);
  assert.ok(defs[1].description.length > 0);
  assert.throws(() => toolDefinitionsFor(['hack_the_planet']), /valid tools: .*read_file/);

  assert.deepEqual(positionalToolArgs('write_file', { content: 'c', path: 'p' }), ['p', 'c'], 'manifest order, not arrival order');
  assert.deepEqual(positionalToolArgs('search', { pattern: 'x' }), ['x', undefined], 'optional glob stays undefined');
  assert.deepEqual(positionalToolArgs('git', { args: ['log', '-1'] }), ['log', '-1'], 'git args array spreads');
  assert.deepEqual(positionalToolArgs('git', {}), [], 'missing git args spread to nothing');
  assert.ok(Object.keys(TOOL_MANIFEST).length >= 8, 'all eight workflow tools are listed');
});

// ── the loop ─────────────────────────────────────────────────────────────────

test('loop: read_file executes once, result feeds back, usage is SUMMED across calls', async () => {
  const executed = [];
  const seen = [];
  const provider = {
    name: 'fake',
    callWithTools: async (job) => {
      seen.push({ tools: job.tools, messages: clone(job.messages) });
      if (seen.length === 1) {
        return { text: 'reading', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'src/a.js' } }], tokensInput: 5, tokensOutput: 2 };
      }
      return { text: 'the file declares x', tokensInput: 7, tokensOutput: 3 };
    },
  };
  const result = await toolQueue(provider).executeAgent({
    model: 'm',
    prompt: 'analyze src/a.js',
    tools: ['read_file'],
    toolExecutor: async (call) => { executed.push(call); return 'const x = 1;'; },
  });
  assert.equal(result.output, 'the file declares x');
  assert.deepEqual(executed, [{ tool: 'read_file', args: ['src/a.js'] }], 'named args arrive positional');
  assert.deepEqual([result.tokensInput, result.tokensOutput], [12, 5], 'usage summed across BOTH calls');
  // the first call carried the provider-neutral tool definitions
  assert.deepEqual(seen[0].tools.map((t) => t.name), ['read_file']);
  // the second call saw assistant toolCalls + the tool result in the neutral transcript
  const transcript = seen[1].messages;
  assert.deepEqual(transcript[0], { role: 'user', content: 'analyze src/a.js' });
  assert.deepEqual(transcript[1].toolCalls, [{ id: 't1', name: 'read_file', args: { path: 'src/a.js' } }]);
  assert.deepEqual(transcript[2], { role: 'tool', toolCallId: 't1', name: 'read_file', content: 'const x = 1;' });
});

test('loop: write_file named→positional mapping and git spread reach the executor', async () => {
  const executed = [];
  let calls = 0;
  const provider = {
    name: 'fake',
    callWithTools: async () => {
      calls++;
      if (calls === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 'w1', name: 'write_file', args: { content: 'hello', path: 'out.txt' } },
            { id: 'g1', name: 'git', args: { args: ['status', '--short'] } },
          ],
          tokensInput: 1, tokensOutput: 1,
        };
      }
      return { text: 'done', tokensInput: 1, tokensOutput: 1 };
    },
  };
  await toolQueue(provider).executeAgent({
    model: 'm', prompt: 'p', tools: ['write_file', 'git'],
    toolExecutor: async (call) => { executed.push(call); return { ok: true }; },
  });
  assert.deepEqual(executed[0], { tool: 'write_file', args: ['out.txt', 'hello'] });
  assert.deepEqual(executed[1], { tool: 'git', args: ['status', '--short'] });
});

test('loop: executor errors (approval gate) become isError tool results — the agent still completes', async () => {
  const transcripts = [];
  const provider = {
    name: 'fake',
    callWithTools: async (job) => {
      transcripts.push(clone(job.messages));
      if (transcripts.length === 1) {
        return { text: '', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'x', content: 'y' } }], tokensInput: 1, tokensOutput: 1 };
      }
      return { text: 'adapted without writing', tokensInput: 1, tokensOutput: 1 };
    },
  };
  const result = await toolQueue(provider).executeAgent({
    model: 'm', prompt: 'p', tools: ['write_file'],
    toolExecutor: async () => { throw new Error('write_file requires approval and the daemon has no interactive approval channel.'); },
  });
  assert.equal(result.output, 'adapted without writing');
  const toolMessage = transcripts[1].find((m) => m.role === 'tool');
  assert.equal(toolMessage.isError, true);
  assert.match(toolMessage.content, /requires approval/);
});

test('loop: provider-side parseError feeds back as an isError result without invoking the executor', async () => {
  let executorCalls = 0;
  const transcripts = [];
  const provider = {
    name: 'fake',
    callWithTools: async (job) => {
      transcripts.push(clone(job.messages));
      if (transcripts.length === 1) {
        return { text: '', toolCalls: [{ id: 'b1', name: 'glob', args: {}, parseError: 'unparseable tool arguments: {oops' }], tokensInput: 1, tokensOutput: 1 };
      }
      return { text: 'recovered', tokensInput: 1, tokensOutput: 1 };
    },
  };
  const result = await toolQueue(provider).executeAgent({
    model: 'm', prompt: 'p', tools: ['glob'],
    toolExecutor: async () => { executorCalls++; return []; },
  });
  assert.equal(result.output, 'recovered');
  assert.equal(executorCalls, 0, 'malformed args never reach the executor');
  const toolMessage = transcripts[1].find((m) => m.role === 'tool');
  assert.equal(toolMessage.isError, true);
  assert.match(toolMessage.content, /unparseable/);
});

test('loop: maxToolIterations cap forces a final tool-free answer', async () => {
  const calls = [];
  const provider = {
    name: 'fake',
    callWithTools: async (job) => {
      calls.push({ tools: job.tools, last: job.messages[job.messages.length - 1] });
      if (job.tools) return { text: '', toolCalls: [{ id: `t${calls.length}`, name: 'glob', args: { pattern: '*' } }], tokensInput: 1, tokensOutput: 1 };
      return { text: 'forced answer', tokensInput: 1, tokensOutput: 1 };
    },
  };
  const result = await toolQueue(provider).executeAgent({
    model: 'm', prompt: 'p', tools: ['glob'], maxToolIterations: 2,
    toolExecutor: async () => [],
  });
  assert.equal(result.output, 'forced answer');
  assert.equal(calls.length, 3, 'two tool iterations + one final');
  assert.equal(calls[2].tools, undefined, 'final call is tool-free');
  assert.match(calls[2].last.content, /Tool budget exhausted/);
});

test('loop: schema enforced on the FINAL turn; an invalid→corrected sequence never re-executes tools', async () => {
  let toolRuns = 0;
  let calls = 0;
  const finalTurns = [];
  const provider = {
    name: 'fake',
    callWithTools: async (job) => {
      calls++;
      if (calls === 1) return { text: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'a' } }], tokensInput: 1, tokensOutput: 1 };
      if (calls === 2) return { text: 'prose, done with tools', tokensInput: 1, tokensOutput: 1 };
      // final tool-free turns only from here
      assert.equal(job.tools, undefined, 'schema turn carries no tools');
      finalTurns.push(job.messages[job.messages.length - 1].content);
      return calls === 3
        ? { text: 'not json at all', tokensInput: 1, tokensOutput: 1 }
        : { text: '{"n": 7}', tokensInput: 1, tokensOutput: 1 };
    },
  };
  const result = await toolQueue(provider).executeAgent({
    model: 'm', prompt: 'p', tools: ['read_file'], schema: { n: 'number' },
    toolExecutor: async () => { toolRuns++; return 'data'; },
  });
  assert.deepEqual(result.output, { n: 7 });
  assert.equal(toolRuns, 1, 'the tool portion is never replayed on schema correction');
  assert.match(finalTurns[0], /Respond with ONLY a single JSON object/);
  assert.match(finalTurns[1], /was rejected/);
  assert.equal(result.tokensInput, 4, 'usage summed across all four calls');
});

test('loop: persistent schema failure throws schema_invalid WITHOUT outer-loop replay of tools', async () => {
  let toolRuns = 0;
  let calls = 0;
  const provider = {
    name: 'fake',
    callWithTools: async (job) => {
      calls++;
      if (calls === 1) return { text: '', toolCalls: [{ id: 't1', name: 'glob', args: { pattern: '*' } }], tokensInput: 1, tokensOutput: 1 };
      if (calls === 2) return { text: 'no more tools', tokensInput: 1, tokensOutput: 1 };
      assert.equal(job.tools, undefined);
      return { text: 'still not json', tokensInput: 1, tokensOutput: 1 };
    },
  };
  await assert.rejects(
    () => toolQueue(provider, { maxAttempts: 2 }).executeAgent({
      model: 'm', prompt: 'p', tools: ['glob'], schema: { n: 'number' },
      toolExecutor: async () => { toolRuns++; return []; },
    }),
    (e) => e.code === 'schema_invalid' && e.noRetry === true
  );
  assert.equal(toolRuns, 1, 'noRetry prevented the outer loop from re-running the tool portion');
  assert.equal(calls, 4, '1 tool call + 1 stop + maxAttempts(2) final turns — no full replay');
});

test('loop: mid-loop context_overflow compacts the largest tool result and retries the same call', async () => {
  let calls = 0;
  const lengths = [];
  const provider = {
    name: 'fake',
    callWithTools: async (job) => {
      calls++;
      if (calls === 1) return { text: '', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'big' } }], tokensInput: 1, tokensOutput: 1 };
      const toolMessage = job.messages.find((m) => m.role === 'tool');
      lengths.push(toolMessage.content.length);
      if (calls === 2) { const e = new Error('prompt is too long'); e.code = 'context_overflow'; throw e; }
      return { text: 'fits now', tokensInput: 1, tokensOutput: 1 };
    },
  };
  const result = await toolQueue(provider).executeAgent({
    model: 'm', prompt: 'p', tools: ['read_file'],
    toolExecutor: async () => 'word '.repeat(20000),
  });
  assert.equal(result.output, 'fits now');
  assert.ok(lengths[1] < lengths[0], 'the oversized tool result was compacted before the retry');
});

test('loop: provider WITHOUT callWithTools falls back to one plain call with tools stripped (warn once)', async () => {
  const warns = [];
  const calls = [];
  const provider = { name: 'host', call: async (job) => { calls.push(job); return { text: 'plain', tokensInput: 1, tokensOutput: 1 }; } };
  const queue = toolQueue(provider, { logger: { ...noopLogger, warn: (m) => warns.push(m) } });
  const result = await queue.executeAgent({ model: 'm', prompt: 'p', tools: ['read_file'], toolExecutor: async () => 'x' });
  assert.equal(result.output, 'plain', 'output unchanged from today’s behavior');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, 'p');
  assert.equal(calls[0].tools, undefined, 'tools stripped from the wire job');
  assert.equal(calls[0].toolExecutor, undefined, 'executor never leaks to providers');
  assert.equal(warns.filter((m) => /no tool-use support/.test(m)).length, 1);
  await queue.executeAgent({ model: 'm', prompt: 'p2', tools: ['read_file'] });
  assert.equal(warns.filter((m) => /no tool-use support/.test(m)).length, 1, 'warned once per provider, not per call');
});

test('loop: plain jobs (no tools) never touch callWithTools', async () => {
  let loopCalls = 0;
  const provider = {
    name: 'fake',
    call: async () => ({ text: 'ok', tokensInput: 1, tokensOutput: 1 }),
    callWithTools: async () => { loopCalls++; return { text: 'x', tokensInput: 0, tokensOutput: 0 }; },
  };
  const result = await toolQueue(provider).executeAgent({ model: 'm', prompt: 'p' });
  assert.equal(result.output, 'ok');
  assert.equal(loopCalls, 0, 'no-tools path is byte-identical to the legacy single call');
});

// ── allowTestCommands ────────────────────────────────────────────────────────

test('config: safety.allowTestCommands defaults to an empty array', () => {
  assert.deepEqual(defaultConfig().safety.allowTestCommands, []);
});

test('allowTestCommands: exact-match run_bash bypasses approval; non-allowlisted + blocked still throw', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-allow-'));
  const exec = createToolExecutor({
    cwd: root,
    safety: {
      requireApprovalFor: ['run_bash', 'write_file'],
      autoApproveReadOnly: true,
      dryRun: false,
      blockedCommands: ['rm -rf /'],
      allowTestCommands: ['node -e "process.exit(0)"', 'rm -rf / --force'],
    },
  });
  const ok = await exec({ tool: 'run_bash', args: ['node -e "process.exit(0)"'] });
  assert.equal(ok.exitCode, 0, 'allowlisted command runs headless');
  const okTrimmed = await exec({ tool: 'run_bash', args: ['  node -e "process.exit(0)"  '] });
  assert.equal(okTrimmed.exitCode, 0, 'match is on the TRIMMED command');
  // exact string match only — a superset command is NOT allowlisted
  await assert.rejects(() => exec({ tool: 'run_bash', args: ['node -e "process.exit(0)"; echo extra'] }), /requires approval/);
  // the allowlist skips ONLY the approval gate — blockedCommands still apply
  await assert.rejects(() => exec({ tool: 'run_bash', args: ['rm -rf / --force'] }), /blocked command/);
  // other approval-gated tools are unaffected
  await assert.rejects(() => exec({ tool: 'write_file', args: ['a.txt', 'x'] }), /requires approval/);
  rmSync(root, { recursive: true, force: true });
});

test('allowTestCommands: dryRun still blocks an allowlisted command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-allow-dry-'));
  const exec = createToolExecutor({
    cwd: root,
    safety: { requireApprovalFor: ['run_bash'], autoApproveReadOnly: true, dryRun: true, blockedCommands: [], allowTestCommands: ['node -e "process.exit(0)"'] },
  });
  await assert.rejects(() => exec({ tool: 'run_bash', args: ['node -e "process.exit(0)"'] }), /dryRun/);
  rmSync(root, { recursive: true, force: true });
});

// ── runtime bridge ───────────────────────────────────────────────────────────

function makeRuntime(executeAgent, configOverrides = {}) {
  const store = createMemoryStore();
  const events = new EventEmitter();
  events.setMaxListeners(100);
  const queue = { executeAgent, size: () => 0, pending: () => 0 };
  const config = { models: { default: 'def-model' }, daemon: { maxConcurrency: 1 }, ...configOverrides };
  const runtime = createRuntime({ store, queue, config, events, logger: noopLogger });
  return { runtime, store };
}

const plan = (script) => ({
  script,
  strategy: mergeStrategy({ budget: { model: 'base-model' } }),
  topology: 'hybrid',
  estimate: { totalAgents: 1 },
  prompt: 'test',
});

const okResult = (output) => ({ output, text: String(output), tokensInput: 1, tokensOutput: 1, durationMs: 1 });

test('runtime bridge: unknown tool names are rejected with the valid-names message', async () => {
  const { runtime, store } = makeRuntime(async () => okResult('never'));
  const script = 'async function execute(){ try { await agent({ prompt: "p", tools: ["nope"] }); return "no-error"; } catch (e) { return e.message; } } module.exports = { execute };';
  const workflowId = await runtime.execWorkflow(plan(script), undefined, { wait: true });
  const result = JSON.parse(store.getWorkflow(workflowId).result);
  assert.match(result, /unknown tool\(s\): nope/);
  assert.match(result, /valid tools: .*read_file/);
});

test('runtime bridge: model tier aliases resolve via config.models for ALL agents', async () => {
  const models = [];
  const { runtime } = makeRuntime(
    async (job) => { models.push(job.model); return okResult('ok'); },
    { models: { planning: 'plan-model', default: 'def-model', fallback: 'fb-model' } }
  );
  const script =
    'async function execute(){' +
    ' await agent({ prompt: "a", model: "planning" });' +
    ' await agent({ prompt: "b", model: "fallback" });' +
    ' await agent({ prompt: "c", model: "custom-model" });' +
    ' await agent({ prompt: "d", model: "default", tools: ["read_file"] });' +
    ' return "ok"; } module.exports = { execute };';
  await runtime.execWorkflow(plan(script), undefined, { wait: true });
  assert.deepEqual(models, ['plan-model', 'fb-model', 'custom-model', 'def-model']);
});

test('runtime bridge: tool jobs bypass the resume cache; plain jobs still dedupe; executor travels on the job', async () => {
  let calls = 0;
  const jobs = [];
  const { runtime, store } = makeRuntime(async (job) => { calls++; jobs.push(job); return okResult(`out-${calls}`); });
  const script =
    'async function execute(){' +
    ' const a = await agent({ prompt: "same", tools: ["read_file"] });' +
    ' const b = await agent({ prompt: "same", tools: ["read_file"] });' +
    ' const c = await agent({ prompt: "plain" });' +
    ' const d = await agent({ prompt: "plain" });' +
    ' return { a, b, c, d }; } module.exports = { execute };';
  const workflowId = await runtime.execWorkflow(plan(script), undefined, { wait: true });
  const result = JSON.parse(store.getWorkflow(workflowId).result);
  assert.equal(calls, 3, 'two tool executions + one plain (second plain came from cache)');
  assert.notEqual(result.a, result.b, 'identical tool agents BOTH executed (no cached side-effect skip)');
  assert.equal(result.c, result.d, 'plain agents still dedupe via the node cache');
  assert.deepEqual(jobs[0].tools, ['read_file']);
  assert.equal(typeof jobs[0].toolExecutor, 'function', 'per-workflow executor attached for tool jobs');
  assert.equal(jobs[2].toolExecutor, undefined, 'plain jobs stay byte-identical');
  // node rows are still recorded for audit/stats even though the cache was bypassed
  assert.ok(store.completedNodes(workflowId).length >= 2);
});
