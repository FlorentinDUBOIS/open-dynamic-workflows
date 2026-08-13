import { costFor } from './pricing.js';

/**
 * Tokenizer-free token estimation. A real tokenizer is the only exact answer,
 * but pulling one in would break odw-core's zero-dependency contract — so we use
 * the well-established chars-per-token heuristic, branched by content kind, and
 * bias toward OVER-counting (denser divisors + a safety margin) because the safe
 * failure mode is "compact a little early", not "overflow the provider".
 *
 * Divisors: English prose ~4.0 chars/token; source code is denser (~3.5);
 * JSON/structured & CJK are denser still (~3.0). A flat /4 silently under-counts
 * code and JSON — exactly the payloads an orchestration engine carries most.
 */
export const CHAR_PER_TOKEN = { english: 4.0, code: 3.5, json: 3.0, cjk: 3.0 };

/** Upward safety buffer applied to message estimates (heuristic MAE is ~10-15%). */
export const TOKEN_SAFETY_MARGIN = 1.15;

/** Per-message chat-template overhead (role markers) + reply priming, in tokens. */
const PER_MESSAGE_OVERHEAD = 4;
const REPLY_PRIMING = 3;

/**
 * Cheaply classify a string's content kind to pick a divisor. Ordered cheapest
 * check first; defaults to the densest plausible kind on ambiguity (over-count).
 * @param {string} text
 * @returns {'english'|'code'|'json'|'cjk'}
 */
export function detectKind(text) {
  const s = String(text ?? '');
  if (!s) return 'english';
  // high non-ASCII ratio → CJK/non-Latin (heuristic blows up here; assume dense).
  let nonAscii = 0;
  const sample = s.length > 4000 ? s.slice(0, 4000) : s;
  for (let i = 0; i < sample.length; i++) if (sample.charCodeAt(i) > 127) nonAscii++;
  if (nonAscii / sample.length > 0.2) return 'cjk';
  // looks like JSON (cheap structural sniff, no full parse on huge strings).
  const trimmed = s.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return 'json';
  }
  // fenced code or high symbol density → code.
  if (/```/.test(sample)) return 'code';
  const symbols = (sample.match(/[{}()[\];=<>+\-*/&|]/g) || []).length;
  if (symbols / sample.length > 0.05) return 'code';
  return 'english';
}

/**
 * Estimate the token count of a string. Rounds UP. When `kind` is omitted it is
 * auto-detected; pass it explicitly on a hot path to skip detection.
 * @param {string} text
 * @param {'english'|'code'|'json'|'cjk'} [kind]
 * @returns {number}
 */
export function estimateTokens(text, kind) {
  const s = String(text ?? '');
  if (!s) return 0;
  const divisor = CHAR_PER_TOKEN[kind ?? detectKind(s)] ?? CHAR_PER_TOKEN.english;
  return Math.ceil(s.length / divisor);
}

/**
 * Estimate the full INPUT token cost of an agent message (system + user prompt),
 * including per-message chat-template overhead and the safety margin. This is the
 * number the context-fit guard compares against the model's input budget.
 * @param {{systemPrompt?: string, prompt: string}} job
 * @returns {number}
 */
export function estimateMessageTokens(job) {
  const sys = job?.systemPrompt ? estimateTokens(job.systemPrompt) : 0;
  const user = estimateTokens(job?.prompt ?? '');
  const messages = (job?.systemPrompt ? 1 : 0) + 1;
  const raw = sys + user + messages * PER_MESSAGE_OVERHEAD + REPLY_PRIMING;
  return Math.ceil(raw * TOKEN_SAFETY_MARGIN);
}

/**
 * Pre-execution resource estimation: agents, tokens, cost, wall-clock.
 *
 * @param {import('./types.js').TaskGraph} taskGraph
 * @param {import('./types.js').ExecutionStrategy} strategy
 * @returns {{totalAgents: number, maxConcurrent: number, tokens: number, costUSD: number, minutes: number}}
 */
export function estimate(taskGraph, strategy) {
  const totalAgents = Math.max(1, taskGraph?.root?.estimatedTotalAgents ?? taskGraph?.tasks?.length ?? 1);
  const maxConcurrent = strategy.concurrency.max === null
    ? totalAgents
    : Math.min(strategy.concurrency.max, totalAgents);

  const perAgentTokens = average(
    (taskGraph?.tasks ?? []).map((t) => t.estimatedTokens || 6000)
  );
  const tokens = Math.round(totalAgents * perAgentTokens);

  // assume ~60% input / 40% output split for estimation
  const costUSD = round2(costFor(strategy.budget.model, tokens * 0.6, tokens * 0.4));

  // ~30s per agent wall-clock, divided by effective concurrency, plus startup overhead
  const waves = Math.ceil(totalAgents / Math.max(1, maxConcurrent));
  const minutes = Math.max(1, Math.round((waves * 30 + 15) / 60));

  return { totalAgents, maxConcurrent, tokens, costUSD, minutes };
}

function average(values) {
  if (!values.length) return 6000;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
