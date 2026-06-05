/**
 * OpenAI Chat Completions adapter — also serves every OpenAI-compatible
 * endpoint via configurable baseURL (OpenCode Zen, Azure, LM Studio, vLLM...).
 * POST {baseURL}/chat/completions, Authorization: Bearer.
 * Structured output: response_format json_schema (strict).
 * usage: {prompt_tokens, completion_tokens}.
 */

import { httpError } from './anthropic.js';

// Models that require max_completion_tokens instead of max_tokens.
const NEW_TOKEN_PARAM = /^(o[0-9]|gpt-5|gpt-4\.1)/;

export function createOpenAIProvider({ apiKey, baseURL = 'https://api.openai.com/v1', fetchImpl = fetch, name = 'openai' }) {
  if (!apiKey) throw new Error(`${name} provider requires an API key`);

  return {
    name,
    async call(job, opts = {}) {
      const messages = [];
      if (job.systemPrompt) messages.push({ role: 'system', content: job.systemPrompt });
      messages.push({ role: 'user', content: job.prompt });

      const body = { model: job.model, messages };
      if (NEW_TOKEN_PARAM.test(job.model)) body.max_completion_tokens = job.maxTokens ?? 4096;
      else body.max_tokens = job.maxTokens ?? 4096;
      if (job.temperature !== undefined) body.temperature = job.temperature;
      if (job.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'output', strict: false, schema: job.schema },
        };
      }

      const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw httpError(name, res.status, errorBody);
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      return {
        text,
        tokensInput: data.usage?.prompt_tokens ?? 0,
        tokensOutput: data.usage?.completion_tokens ?? 0,
        raw: data,
      };
    },
  };
}
