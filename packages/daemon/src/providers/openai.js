/**
 * OpenAI Chat Completions adapter (also serves every OpenAI-compatible
 * endpoint via configurable baseURL: OpenCode Zen, Azure, LM Studio, vLLM...).
 * POST {baseURL}/chat/completions, Authorization: Bearer.
 * - Structured output via response_format {type:"json_schema", json_schema:{name,strict,schema}}.
 * - usage: {prompt_tokens, completion_tokens}.
 * - newer models take max_completion_tokens (fallback handled).
 */
export function createOpenAIProvider({ apiKey, baseURL }) {
  void apiKey; void baseURL;
  throw new Error('not implemented (P4)');
}
