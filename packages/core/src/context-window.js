/**
 * Per-model context-window registry (pure odw-core, zero deps) — the peer of
 * pricing.js. Cost tells you how much a call costs; this tells you how much
 * input a call can hold before the provider rejects it with a 400.
 *
 * Why it exists: the engine must never let a single agent call overflow its
 * model's input window. For small/free/local models that window can be as small
 * as 8K tokens, so an UNKNOWN model is assumed small on purpose — over-budgeting
 * just compacts a little early (cheap, safe); under-budgeting overflows and
 * crashes the call (catastrophic). The asymmetry decides every default here.
 *
 * Windows are TOTAL context (input + output) for OpenAI-compatible models;
 * Anthropic's published window is effectively the input budget. `contextWindowFor`
 * reports which via `outputSharesWindow` so the daemon reserves output headroom
 * only when it actually counts against the same pool.
 */

/** Known model → total context window in tokens (June 2026). */
export const CONTEXT_WINDOWS = {
  // anthropic (input-budget windows; see outputSharesWindow=false below)
  'claude-opus-4-8': 200000,
  'claude-opus-4-7': 200000,
  'claude-opus-4-6': 1000000,
  'claude-sonnet-4-6': 1000000,
  'claude-haiku-4-5': 200000,
  // openai (total = input + output)
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4.1': 1000000,
  'gpt-4.1-mini': 1000000,
  'gpt-4.1-nano': 1000000,
  'gpt-5': 400000,
  'gpt-5-mini': 400000,
  'o3': 200000,
  'o4-mini': 200000,
};

/**
 * Conservative window for any unrecognized model id. 8192 is the smallest
 * common modern floor (original Llama 3 8B), so assuming it guarantees we never
 * overflow a genuinely small model. Named + exported so it is tunable.
 */
export const DEFAULT_UNKNOWN_WINDOW = 8192;

/**
 * Substring fallbacks for common open/local model families, matched after the
 * exact-id and date-suffix lookups. ORDER MATTERS: the llama-3.x entries MUST
 * precede the bare 'llama-3' entry — "Llama 3 8B" is 8K but "Llama 3.1 8B" is
 * 128K, a 16x difference the research flagged as decisive.
 */
const FAMILY_WINDOWS = [
  ['llama-3.1', 128000], ['llama-3.2', 128000], ['llama-3.3', 128000], ['llama3.1', 128000],
  ['llama-3', 8192], ['llama3', 8192],
  ['mistral-7b', 32768], ['mixtral', 32768], ['mistral', 32768],
  ['qwen2.5', 128000], ['qwen-2.5', 128000], ['qwen', 32768],
  ['minimax', 200000],
  ['gemma', 8192],
  ['phi-3', 4096], ['phi3', 4096],
];

/**
 * Resolve a model id to its context window.
 * Local/free conventions (`ollama:*`, `ollama/*`, `*-free`) deliberately fall
 * through to the conservative default (known:false) — they are the ids most
 * likely to front a small window, and a host (Ollama's num_ctx) often serves
 * far less than the model's advertised maximum.
 *
 * @param {string} model
 * @returns {{window: number, outputSharesWindow: boolean, known: boolean}}
 */
export function contextWindowFor(model) {
  const raw = String(model ?? '');
  const outputSharesWindow = !/^claude-/i.test(raw);

  // local/free ids: treat as unknown-small regardless of any family hint.
  if (/^ollama[:/]/i.test(raw) || /-free$/i.test(raw)) {
    return { window: DEFAULT_UNKNOWN_WINDOW, outputSharesWindow, known: false };
  }

  // strip a "<provider>:" routing prefix (e.g. "zen:minimax-m2.5") then normalize.
  const id = raw.replace(/^[a-z][a-z0-9_-]*:(?=.)/i, '').toLowerCase();

  // exact id, then date-suffix-stripped alias (mirrors costFor).
  const exact = CONTEXT_WINDOWS[id] ?? CONTEXT_WINDOWS[id.replace(/-\d{8}$/, '')];
  if (exact) return { window: exact, outputSharesWindow, known: true };

  for (const [needle, window] of FAMILY_WINDOWS) {
    if (id.includes(needle)) return { window, outputSharesWindow, known: true };
  }

  return { window: DEFAULT_UNKNOWN_WINDOW, outputSharesWindow, known: false };
}
