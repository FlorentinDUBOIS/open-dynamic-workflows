import { test } from 'node:test';
import assert from 'node:assert/strict';

const { httpError, CONTEXT_OVERFLOW_PHRASES } = await import('../src/providers/anthropic.js');
const { createAgentQueue } = await import('../src/agent-queue.js');

// ── overflow classification (single shared chokepoint) ───────────────────────

test('httpError: Anthropic "prompt is too long" 400 → context_overflow + parsed counts', () => {
  const err = httpError('anthropic', 400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 233153 tokens > 200000 maximum"}}');
  assert.equal(err.code, 'context_overflow');
  assert.equal(err.requestedTokens, 233153);
  assert.equal(err.limitTokens, 200000);
});

test('httpError: OpenAI context_length_exceeded 400 → context_overflow', () => {
  const err = httpError('openai', 400, '{"error":{"code":"context_length_exceeded","message":"This model\'s maximum context length is 128000 tokens. However, you requested 130000 tokens"}}');
  assert.equal(err.code, 'context_overflow');
  assert.equal(err.limitTokens, 128000);
  assert.equal(err.requestedTokens, 130000);
});

test('httpError: a NON-overflow 400 (auth/schema) stays request_failed (no false self-heal)', () => {
  const err = httpError('openai', 400, '{"error":{"message":"invalid api key"}}');
  assert.equal(err.code, 'request_failed');
});

test('httpError: existing classifications are unchanged', () => {
  assert.equal(httpError('x', 429, 'rate').code, 'rate_limit');
  assert.equal(httpError('x', 503, 'down').code, 'service_unavailable');
  assert.equal(httpError('x', 504, 'gw').code, 'timeout');
  assert.ok(CONTEXT_OVERFLOW_PHRASES.includes('prompt is too long'), 'Anthropic phrase present');
});

// ── helpers ──────────────────────────────────────────────────────────────────

function queueWith(providerCall, opts = {}) {
  return createAgentQueue({
    maxConcurrency: 4,
    retry: { maxAttempts: opts.maxAttempts ?? 3, backoff: 'linear' },
    perAgentTimeout: 5,
    resolveProvider: () => ({ provider: { name: 'fake', call: providerCall }, model: opts.model ?? 'fake-model' }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    onCompact: opts.onCompact,
  });
}
const overflow = () => { const e = new Error('prompt is too long: 999 tokens > 100 maximum'); e.code = 'context_overflow'; e.limitTokens = 100; e.requestedTokens = 999; return e; };

// ── pre-call guard: fit-case byte parity ─────────────────────────────────────

test('guard: a small prompt on a KNOWN model is sent BYTE-IDENTICAL (zero regression)', async () => {
  let seenPrompt;
  const queue = queueWith(async (job) => { seenPrompt = job.prompt; return { text: 'ok', tokensInput: 1, tokensOutput: 1 }; }, { model: 'gpt-4o' });
  await queue.executeAgent({ model: 'gpt-4o', prompt: 'hello world', context: { enabled: true, safetyFactor: 0.9, reservedOutputTokens: 4096, maxCompactAttempts: 3, overflowRetry: true } });
  assert.equal(seenPrompt, 'hello world', 'fits the window → prompt untouched');
});

test('guard: UNKNOWN-window model sends everything as-is on first try (no proactive compaction)', async () => {
  let seenLen;
  const big = 'x'.repeat(500000); // would exceed an 8K assumed window if proactively compacted
  const queue = queueWith(async (job) => { seenLen = job.prompt.length; return { text: 'ok', tokensInput: 1, tokensOutput: 1 }; }, { model: 'mystery-local-model' });
  await queue.executeAgent({ model: 'mystery-local-model', prompt: big });
  assert.equal(seenLen, big.length, 'unknown model: not proactively compacted — preserves legacy behavior');
});

test('guard: oversize prompt on a KNOWN SMALL model IS proactively compacted before sending', async () => {
  let seenLen;
  const compactions = [];
  const big = 'word '.repeat(200000); // ~1M chars, far over an 8K llama-3 window
  const queue = queueWith(async (job) => { seenLen = job.prompt.length; return { text: 'ok', tokensInput: 1, tokensOutput: 1 }; },
    { model: 'llama-3-8b', onCompact: (i) => compactions.push(i) });
  await queue.executeAgent({ model: 'llama-3-8b', prompt: big });
  assert.ok(seenLen < big.length, 'oversize prompt on a known 8K model was compacted');
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].reason, 'pre_call');
});

test('guard: enabled:false restores legacy send-everything even for a known small model', async () => {
  let seenLen;
  const big = 'word '.repeat(200000);
  const queue = queueWith(async (job) => { seenLen = job.prompt.length; return { text: 'ok', tokensInput: 1, tokensOutput: 1 }; }, { model: 'llama-3-8b' });
  await queue.executeAgent({ model: 'llama-3-8b', prompt: big, context: { enabled: false } });
  assert.equal(seenLen, big.length, 'context.enabled:false is a hard pass-through');
});

// ── reactive self-heal ────────────────────────────────────────────────────────

test('self-heal: a real context_overflow then success → compacts and recovers', async () => {
  let calls = 0;
  const lengths = [];
  const big = 'word '.repeat(200000);
  const queue = queueWith(async (job) => {
    calls++; lengths.push(job.prompt.length);
    if (calls === 1) throw overflow();        // first send overflows
    return { text: 'recovered', tokensInput: 1, tokensOutput: 1 };
  }, { model: 'gpt-4o' });
  const res = await queue.executeAgent({ model: 'gpt-4o', prompt: big });
  assert.equal(res.output, 'recovered');
  assert.equal(calls, 2);
  assert.ok(lengths[1] < lengths[0], 'the retry prompt was compacted smaller');
});

test('self-heal: persistent overflow is BOUNDED (no infinite loop), stops at maxCompactAttempts', async () => {
  let calls = 0;
  const queue = queueWith(async () => { calls++; throw overflow(); }, { model: 'gpt-4o' });
  await assert.rejects(
    () => queue.executeAgent({ model: 'gpt-4o', prompt: 'word '.repeat(200000), context: { enabled: true, safetyFactor: 0.9, reservedOutputTokens: 4096, maxCompactAttempts: 3, overflowRetry: true } }),
    (e) => e.code === 'context_overflow'
  );
  // first call + at most maxCompactAttempts retries
  assert.ok(calls <= 4, `bounded retries (got ${calls}, cap 1+3)`);
  assert.ok(calls >= 2, 'it did attempt recovery');
});

test('self-heal: overflowRetry:false fails fast on the first overflow', async () => {
  let calls = 0;
  const queue = queueWith(async () => { calls++; throw overflow(); }, { model: 'gpt-4o' });
  await assert.rejects(
    () => queue.executeAgent({ model: 'gpt-4o', prompt: 'p', context: { enabled: true, overflowRetry: false, maxCompactAttempts: 3, safetyFactor: 0.9, reservedOutputTokens: 4096 } }),
    (e) => e.code === 'context_overflow'
  );
  assert.equal(calls, 1);
});

test('regression: a generic non-overflow 400 still fails fast (1 attempt, not self-healed)', async () => {
  let calls = 0;
  const queue = queueWith(async () => { calls++; const e = new Error('bad'); e.code = 'request_failed'; throw e; }, { model: 'gpt-4o' });
  await assert.rejects(() => queue.executeAgent({ model: 'gpt-4o', prompt: 'p' }));
  assert.equal(calls, 1);
});
