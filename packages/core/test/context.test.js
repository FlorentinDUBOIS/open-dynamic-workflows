import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, estimateMessageTokens, detectKind, CHAR_PER_TOKEN,
  contextWindowFor, CONTEXT_WINDOWS, DEFAULT_UNKNOWN_WINDOW,
  compactValue, compactText,
  mergeStrategy, defaultStrategy,
} from '../src/index.js';

// ── token estimator ────────────────────────────────────────────────────────

test('estimateTokens: english uses ~/4, denser kinds count MORE tokens', () => {
  assert.equal(estimateTokens('a'.repeat(400), 'english'), 100); // 400/4
  assert.equal(estimateTokens('a'.repeat(400), 'code'), Math.ceil(400 / 3.5));
  assert.equal(estimateTokens('a'.repeat(400), 'json'), Math.ceil(400 / 3)); // densest → most tokens
  assert.ok(estimateTokens('x'.repeat(400), 'json') > estimateTokens('x'.repeat(400), 'english'),
    'JSON divisor must over-count vs english (safe failure mode)');
  assert.equal(estimateTokens(''), 0);
  assert.equal(CHAR_PER_TOKEN.english, 4.0);
});

test('detectKind: classifies json / code / cjk / english', () => {
  assert.equal(detectKind('{"a":1,"b":[1,2,3]}'), 'json');
  assert.equal(detectKind('```\nfor (let i=0;i<n;i++) { x += i; }\n```'), 'code');
  assert.equal(detectKind('これは日本語のテキストです'.repeat(5)), 'cjk');
  assert.equal(detectKind('The quick brown fox jumps over the lazy dog.'), 'english');
});

test('estimateMessageTokens: adds per-message overhead + safety margin', () => {
  const raw = estimateTokens('hello world here is a prompt');
  const withSys = estimateMessageTokens({ systemPrompt: 'you are helpful', prompt: 'hello world here is a prompt' });
  // must exceed the bare user estimate (overhead + margin + system)
  assert.ok(withSys > raw, 'message estimate must exceed bare prompt estimate');
});

// ── context-window registry ──────────────────────────────────────────────────

test('contextWindowFor: known models, date-suffix alias, claude input-budget flag', () => {
  assert.equal(contextWindowFor('claude-haiku-4-5').window, 200000);
  assert.equal(contextWindowFor('claude-haiku-4-5-20251001').window, 200000); // date-strip alias
  assert.equal(contextWindowFor('claude-sonnet-4-6').outputSharesWindow, false); // Claude window == input budget
  assert.equal(contextWindowFor('gpt-4o').outputSharesWindow, true);            // OpenAI window shared
  assert.equal(contextWindowFor('gpt-4o-mini').window, 128000);
  assert.equal(contextWindowFor('claude-opus-4-8').known, true);
  assert.ok(CONTEXT_WINDOWS['gpt-5'] > 0);
});

test('contextWindowFor: llama-3 (8K) vs llama-3.1 (128K) disambiguation', () => {
  assert.equal(contextWindowFor('llama-3-8b').window, 8192);
  assert.equal(contextWindowFor('llama-3.1-8b').window, 128000);
  assert.equal(contextWindowFor('llama3.1').window, 128000);
  // an ollama: id is deliberately treated as unknown-small regardless of the
  // family hint — the host's served num_ctx is often capped below the model max.
  assert.equal(contextWindowFor('ollama:llama3.1').window, DEFAULT_UNKNOWN_WINDOW);
  assert.equal(contextWindowFor('ollama:llama3.1').known, false);
});

test('contextWindowFor: unknown / ollama / -free fall through to the conservative default', () => {
  assert.equal(contextWindowFor('totally-unknown-model').window, DEFAULT_UNKNOWN_WINDOW);
  assert.equal(contextWindowFor('totally-unknown-model').known, false);
  assert.equal(contextWindowFor('ollama:some-tiny-model').window, DEFAULT_UNKNOWN_WINDOW);
  assert.equal(contextWindowFor('ollama:some-tiny-model').known, false);
  assert.equal(contextWindowFor('minimax-m2.5-free').window, DEFAULT_UNKNOWN_WINDOW, '-free => unknown floor');
  assert.equal(DEFAULT_UNKNOWN_WINDOW, 8192);
});

test('contextWindowFor: provider-prefixed id resolves the bare model (zen:minimax)', () => {
  assert.equal(contextWindowFor('zen:minimax-m2.5').window, 200000); // minimax family
  assert.equal(contextWindowFor('zen:minimax-m2.5').known, true);
});

// ── structure-preserving compaction (the load-bearing JSON-validity guarantee) ──

test('compactValue: identity (byte-equal) when the value already fits', () => {
  const v = { a: 1, b: [1, 2, 3], c: 'hello' };
  const { value, manifest } = compactValue(v, 100000);
  assert.deepEqual(value, v);
  assert.equal(manifest.droppedCount, 0);
  // exact same serialization — this is the no-regression guarantee for deps injection
  assert.equal(JSON.stringify(value), JSON.stringify(v));
});

test('compactValue: output ALWAYS re-parses as valid JSON (fuzzed nested structures)', () => {
  const rnd = (seed) => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
  const r = rnd(42);
  const gen = (depth) => {
    if (depth <= 0) return r() < 0.5 ? 'x'.repeat(Math.floor(r() * 200)) : Math.floor(r() * 1000);
    if (r() < 0.5) return Array.from({ length: Math.floor(r() * 8) }, () => gen(depth - 1));
    const o = {};
    for (let i = 0; i < Math.floor(r() * 8); i++) o['k' + i] = gen(depth - 1);
    return o;
  };
  for (let trial = 0; trial < 50; trial++) {
    const value = gen(4);
    for (const budget of [20, 100, 500, 2000]) {
      const { value: out } = compactValue(value, budget);
      // re-parse must never throw — the core promise vs blind slicing
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)), `budget ${budget} produced invalid JSON`);
    }
  }
});

test('compactValue: drops WHOLE trailing array items and records them in the manifest', () => {
  const arr = Array.from({ length: 100 }, (_, i) => ({ id: i, text: 'item-' + 'y'.repeat(50) }));
  const { value, manifest } = compactValue(arr, 600);
  assert.ok(Array.isArray(value));
  assert.ok(value.length < 100 && value.length > 0, 'some kept, some dropped');
  // every kept item is WHOLE (deep-equal to the original at its index)
  value.forEach((item, i) => assert.deepEqual(item, arr[i]));
  assert.equal(manifest.droppedCount, 100 - value.length);
  assert.ok(manifest.finalChars <= 600);
});

test('compactValue: object drops trailing props but honors keepKeys', () => {
  const obj = { keep: 'IMPORTANT', a: 'z'.repeat(500), b: 'z'.repeat(500), c: 'z'.repeat(500) };
  const { value } = compactValue(obj, 120, { keepKeys: ['keep'] });
  assert.equal(value.keep, 'IMPORTANT', 'keepKeys survive eviction');
});

test('compactText: identity when it fits; boundary-safe truncation with marker when not', () => {
  assert.equal(compactText('short string', 1000), 'short string');
  const long = 'word '.repeat(1000);
  const out = compactText(long, 200);
  assert.ok(out.length <= 200, 'respects the char budget including marker');
  assert.match(out, /truncated \d+ chars/);
});

test('compactText: NEVER exceeds the budget even for tiny budgets (marker would not fit)', () => {
  // budgets smaller than the ~26-char marker must still be honored exactly.
  for (const budget of [1, 5, 16, 20, 25, 30]) {
    const out = compactText('x'.repeat(1_000_000), budget);
    assert.ok(out.length <= budget, `budget ${budget}: got ${out.length} chars (must be <= ${budget})`);
  }
});

test('compactValue: a single oversized element still fits the budget (with JSON-wrapper room)', () => {
  for (const budget of [20, 50, 200]) {
    const { value } = compactValue(['x'.repeat(100000)], budget);
    assert.ok(JSON.stringify(value).length <= budget, `budget ${budget}: serialized exceeds budget`);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)));
  }
});

// ── strategy.context wiring ──────────────────────────────────────────────────

test('mergeStrategy: context block defaults present and clamped', () => {
  const s = defaultStrategy();
  assert.equal(s.context.enabled, true);
  assert.equal(s.context.safetyFactor, 0.9);
  assert.equal(s.context.maxCompactAttempts, 3);

  const merged = mergeStrategy({ context: { enabled: false, safetyFactor: 2.0, maxCompactAttempts: 99 } });
  assert.equal(merged.context.enabled, false, 'override-wins');
  assert.equal(merged.context.safetyFactor, 0.99, 'clamped to [0.5,0.99]');
  assert.equal(merged.context.maxCompactAttempts, 5, 'clamped to [1,5]');
  assert.equal(merged.context.reservedOutputTokens, 4096, 'untouched default survives merge');
});
