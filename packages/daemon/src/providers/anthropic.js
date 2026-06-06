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

/**
 * Provider-spanning phrases that signal a context-window overflow on an HTTP 400.
 * Anthropic exposes NO machine-readable code — 'prompt is too long' is the only
 * signal — and self-hosted OpenAI-compatible servers (vLLM/sglang/Gemini) ship
 * their own phrasings, so the set is broad and lives in one editable place.
 */
export const CONTEXT_OVERFLOW_PHRASES = [
  'context_length_exceeded',
  'context length',
  'maximum context length',
  'context window',
  'context size',
  'too many tokens',
  'token limit',
  'prompt is too long',
  'input is too long',
  'input length and max_tokens exceed context limit',
  'input token count exceeds',
  'is longer than the model',
  'reduce the length of the messages',
];

export function httpError(provider, status, body) {
  const text = String(body ?? '');
  const err = new Error(`${provider} HTTP ${status}: ${text.slice(0, 300)}`);
  err.status = status;

  if (status === 429) err.code = 'rate_limit';
  else if (status === 408 || status === 504) err.code = 'timeout';
  else if (status >= 500) err.code = 'service_unavailable';
  else if ((status === 400 || status === 413) && isContextOverflow(text)) {
    // Sub-classify the recoverable 400 so the queue self-heals (compact + retry)
    // instead of treating it as a generic non-retryable failure (the hermes-agent
    // #813 bug). Auth/schema 400s stay 'request_failed' and never enter the loop.
    err.code = 'context_overflow';
    const nums = parseOverflowTokens(text);
    if (nums.requestedTokens) err.requestedTokens = nums.requestedTokens;
    if (nums.limitTokens) err.limitTokens = nums.limitTokens;
  } else err.code = 'request_failed';

  return err;
}

function isContextOverflow(body) {
  const lower = body.toLowerCase();
  return CONTEXT_OVERFLOW_PHRASES.some((p) => lower.includes(p));
}

/**
 * Best-effort extraction of the limit + requested token counts from the error
 * message, enabling a single corrective trim instead of blind halving. Brittle
 * by nature (phrasing varies by provider) so callers MUST tolerate undefined.
 */
function parseOverflowTokens(body) {
  // Anthropic: "prompt is too long: 233153 tokens > 200000 maximum"
  const gt = body.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)/i);
  if (gt) return { requestedTokens: toInt(gt[1]), limitTokens: toInt(gt[2]) };
  // OpenAI: "maximum context length is 128000 tokens. However, you requested 130000 tokens"
  const max = body.match(/maximum context length is (\d[\d,]*)/i);
  const req = body.match(/you requested (\d[\d,]*)/i);
  return { limitTokens: max ? toInt(max[1]) : undefined, requestedTokens: req ? toInt(req[1]) : undefined };
}

function toInt(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}
