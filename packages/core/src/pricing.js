/**
 * Model pricing reference (USD per million tokens, input/output).
 * Used for pre-execution estimates and real-time cost tracking.
 * Unknown models fall back to `default`; local models cost zero.
 */
export const PRICING = {
  // anthropic
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // openai
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'o3': { input: 2, output: 8 },
  'o4-mini': { input: 1.1, output: 4.4 },
  // fallback for unknown models
  'default': { input: 3, output: 15 },
};

/**
 * Cost of a single call in USD.
 * Local/free model conventions (`ollama:*`, `*-free`) cost zero.
 * @param {string} model
 * @param {number} tokensInput
 * @param {number} tokensOutput
 * @returns {number}
 */
export function costFor(model, tokensInput, tokensOutput) {
  const id = String(model ?? '');
  // Local/free models and the embedded "host:" backend cost $0 to ODW — the
  // host harness's own auth pays for host: calls, so ODW must not bill them.
  // (Runaway protection on the embedded path comes from the token cap, not cost.)
  if (id.startsWith('ollama:') || id.startsWith('ollama/') || id.startsWith('host:') || /-free$/.test(id)) return 0;
  // exact id, then date-suffix-stripped alias (claude-haiku-4-5-20251001 → claude-haiku-4-5)
  const rate =
    PRICING[id] ??
    PRICING[id.replace(/-\d{8}$/, '')] ??
    PRICING['default'];
  const inTok = Math.max(0, Number(tokensInput) || 0);
  const outTok = Math.max(0, Number(tokensOutput) || 0);
  return (inTok * rate.input + outTok * rate.output) / 1_000_000;
}
