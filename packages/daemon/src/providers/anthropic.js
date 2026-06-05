/**
 * Anthropic Messages API adapter.
 * POST {baseURL}/v1/messages — headers: x-api-key, anthropic-version: 2023-06-01.
 * max_tokens REQUIRED top-level; system top-level; content = typed blocks.
 * Structured output: output_config.format json_schema (fallback: prompt-embedded).
 * opus-4.7/4.8 reject temperature — omitted for those models.
 * usage: {input_tokens, output_tokens}.
 */

const NO_TEMPERATURE = /^claude-opus-4-(7|8)/;

export function createAnthropicProvider({ apiKey, baseURL = 'https://api.anthropic.com', fetchImpl = fetch }) {
  if (!apiKey) throw new Error('anthropic provider requires an API key (config.apiKeys.anthropic or ANTHROPIC_API_KEY)');

  return {
    name: 'anthropic',
    /**
     * @param {{model: string, systemPrompt?: string, prompt: string, maxTokens?: number,
     *          temperature?: number, schema?: object}} job
     * @param {{signal?: AbortSignal}} [opts]
     */
    async call(job, opts = {}) {
      const body = {
        model: job.model,
        max_tokens: job.maxTokens ?? 4096,
        messages: [{ role: 'user', content: job.prompt }],
      };
      if (job.systemPrompt) body.system = job.systemPrompt;
      if (job.temperature !== undefined && !NO_TEMPERATURE.test(job.model)) {
        body.temperature = job.temperature;
      }
      if (job.schema) {
        body.output_config = { format: { type: 'json_schema', schema: job.schema } };
      }

      const res = await fetchImpl(`${baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        throw httpError('anthropic', res.status, errorBody);
      }

      const data = await res.json();
      const text = (data.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return {
        text,
        tokensInput: data.usage?.input_tokens ?? 0,
        tokensOutput: data.usage?.output_tokens ?? 0,
        raw: data,
      };
    },
  };
}

export function httpError(provider, status, body) {
  const err = new Error(`${provider} HTTP ${status}: ${String(body).slice(0, 300)}`);
  err.status = status;
  err.code =
    status === 429 ? 'rate_limit'
    : status === 408 || status === 504 ? 'timeout'
    : status >= 500 ? 'service_unavailable'
    : 'request_failed';
  return err;
}
