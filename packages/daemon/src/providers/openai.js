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

  // Shared request plumbing for call() and callWithTools().
  const baseBody = (job, messages) => {
    const body = { model: job.model, messages };
    if (NEW_TOKEN_PARAM.test(job.model)) body.max_completion_tokens = job.maxTokens ?? 4096;
    else body.max_tokens = job.maxTokens ?? 4096;
    if (job.temperature !== undefined) body.temperature = job.temperature;
    return body;
  };

  const post = async (body, opts) => {
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
    return res.json();
  };

  const usageOf = (data) => ({
    tokensInput: data.usage?.prompt_tokens ?? 0,
    tokensOutput: data.usage?.completion_tokens ?? 0,
  });

  return {
    name,
    async call(job, opts = {}) {
      const messages = [];
      if (job.systemPrompt) messages.push({ role: 'system', content: job.systemPrompt });
      messages.push({ role: 'user', content: job.prompt });

      const body = baseBody(job, messages);
      if (job.schema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: { name: 'output', strict: false, schema: job.schema },
        };
      }

      const data = await post(body, opts);
      return { text: data.choices?.[0]?.message?.content ?? '', ...usageOf(data), raw: data };
    },

    /**
     * Tool-loop variant: neutral transcript in, {text, toolCalls?} out.
     * NEVER sends response_format — many endpoints reject it together with
     * tools, and the queue enforces schemas on the final turn via prompt +
     * extractJson instead.
     * @param {{model: string, systemPrompt?: string, messages: object[],
     *          tools?: Array<{name: string, description: string, inputSchema: object}>,
     *          maxTokens?: number, temperature?: number, schema?: object}} job
     * @param {{signal?: AbortSignal}} [opts]
     */
    async callWithTools(job, opts = {}) {
      const messages = [];
      if (job.systemPrompt) messages.push({ role: 'system', content: job.systemPrompt });
      messages.push(...toChatMessages(job.messages ?? []));

      const body = baseBody(job, messages);
      if (job.tools?.length) {
        body.tools = job.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }));
      }

      const data = await post(body, opts);
      const message = data.choices?.[0]?.message ?? {};
      let toolCalls;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        toolCalls = message.tool_calls.map((call, i) => parseToolCall(call, i));
      }
      return {
        text: typeof message.content === 'string' ? message.content : '',
        toolCalls,
        ...usageOf(data),
        raw: data,
      };
    },
  };
}

/**
 * Parse one wire tool_call defensively: function.arguments is a JSON STRING the
 * model wrote, and weak models emit broken JSON. A parse failure becomes a
 * {parseError} marker — the queue feeds it back to the model as an error tool
 * result instead of throwing away the whole agent run.
 */
function parseToolCall(call, index) {
  const name = call.function?.name;
  const id = call.id ?? `call_${index}`;
  const raw = call.function?.arguments;
  if (raw == null || raw === '') return { id, name, args: {} };
  if (typeof raw === 'object') return { id, name, args: raw }; // some compatible servers pre-parse
  try {
    const args = JSON.parse(raw);
    if (args && typeof args === 'object' && !Array.isArray(args)) return { id, name, args };
    return { id, name, args: {}, parseError: `tool arguments must be a JSON object, got: ${String(raw).slice(0, 200)}` };
  } catch (error) {
    return { id, name, args: {}, parseError: `unparseable tool arguments (${error.message}): ${String(raw).slice(0, 200)}` };
  }
}

/** Neutral transcript → OpenAI chat messages (tool calls/results become tool_calls / role:tool). */
function toChatMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content ?? null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }));
      }
      return msg;
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') };
    }
    return { role: 'user', content: m.content };
  });
}
