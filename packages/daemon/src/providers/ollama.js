/**
 * Ollama local adapter. POST {baseURL}/api/chat (no auth, $0 cost).
 * format: full JSON Schema object directly (or "json").
 * usage: prompt_eval_count / eval_count — may be 0 on cache hit (treated as 0).
 */

import { httpError } from './anthropic.js';

export function createOllamaProvider({ baseURL = 'http://localhost:11434', fetchImpl = fetch }) {
  return {
    name: 'ollama',
    async call(job, opts = {}) {
      const messages = [];
      if (job.systemPrompt) messages.push({ role: 'system', content: job.systemPrompt });
      messages.push({ role: 'user', content: job.prompt });

      const body = {
        model: job.model.replace(/^ollama[:/]/, ''),
        messages,
        stream: false,
      };
      if (job.schema) body.format = job.schema;
      if (job.temperature !== undefined) body.options = { temperature: job.temperature };

      const res = await fetchImpl(`${baseURL.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw httpError('ollama', res.status, errorBody);
      }

      const data = await res.json();
      return {
        text: data.message?.content ?? '',
        tokensInput: data.prompt_eval_count ?? 0,
        tokensOutput: data.eval_count ?? 0,
        raw: data,
      };
    },
  };
}
