/**
 * Provider registry. Each provider implements:
 *   call(job, {signal}) => Promise<{text: string, tokensInput: number, tokensOutput: number, raw: object}>
 * where job = {model, systemPrompt, prompt, maxTokens, temperature, schema?}.
 * Three distinct wire formats — no shared response_format code path.
 */

/**
 * @param {string} model e.g. "claude-sonnet-4-6", "gpt-4o-mini", "ollama:llama3", "openai-compatible:..."
 * @param {import('../config.js').DaemonConfig} config
 * @returns {{provider: string, call: Function}}
 */
export function resolveProvider(model, config) {
  void model; void config;
  throw new Error('not implemented (P4)');
}
