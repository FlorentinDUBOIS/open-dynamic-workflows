/**
 * Anthropic Messages API adapter.
 * POST https://api.anthropic.com/v1/messages
 * headers: x-api-key, anthropic-version: 2023-06-01
 * - max_tokens REQUIRED top-level; system is top-level; content = typed blocks.
 * - Structured output via output_config.format json_schema.
 * - opus-4.7/4.8 reject temperature — adapter omits it for those models.
 * - usage: {input_tokens, output_tokens}.
 */
export function createAnthropicProvider({ apiKey, baseURL }) {
  void apiKey; void baseURL;
  throw new Error('not implemented (P4)');
}
