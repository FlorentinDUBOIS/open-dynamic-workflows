/**
 * Ollama local adapter. POST {baseURL}/api/chat (no auth, $0 cost).
 * format: full JSON Schema object directly (or "json").
 * usage: prompt_eval_count / eval_count — may be 0 on cache hit (treated as 0).
 */

import { httpError } from './anthropic.js';

export function createOllamaProvider({ baseURL = 'http://localhost:11434', fetchImpl = fetch }) {
  // Shared request plumbing for call() and callWithTools().
  const baseBody = (job, messages) => {
    const body = {
      model: job.model.replace(/^ollama[:/]/, ''),
      messages,
      stream: false,
    };
    if (job.temperature !== undefined) body.options = { temperature: job.temperature };
    return body;
  };

  const post = async (body, opts) => {
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
    return res.json();
  };

  const usageOf = (data) => ({
    tokensInput: data.prompt_eval_count ?? 0,
    tokensOutput: data.eval_count ?? 0,
  });

  return {
    name: 'ollama',
    async call(job, opts = {}) {
      const messages = [];
      if (job.systemPrompt) messages.push({ role: 'system', content: job.systemPrompt });
      messages.push({ role: 'user', content: job.prompt });

      const body = baseBody(job, messages);
      if (job.schema) body.format = job.schema;

      const data = await post(body, opts);
      return { text: data.message?.content ?? '', ...usageOf(data), raw: data };
    },

    /**
     * Tool-loop variant: neutral transcript in, {text, toolCalls?} out.
     * format is only sent on tool-FREE calls (the queue's final schema turn) —
     * a forced format on a tool call suppresses tool_calls on most models.
     * @param {{model: string, systemPrompt?: string, messages: object[],
     *          tools?: Array<{name: string, description: string, inputSchema: object}>,
     *          maxTokens?: number, temperature?: number, schema?: object}} job
     * @param {{signal?: AbortSignal}} [opts]
     */
    async callWithTools(job, opts = {}) {
      const messages = [];
      if (job.systemPrompt) messages.push({ role: 'system', content: job.systemPrompt });
      messages.push(...toOllamaMessages(job.messages ?? []));

      const body = baseBody(job, messages);
      if (job.tools?.length) {
        body.tools = job.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        }));
      } else if (job.schema) {
        body.format = job.schema;
      }

      const data = await post(body, opts);
      const message = data.message ?? {};
      let toolCalls;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        toolCalls = message.tool_calls.map((call, i) => parseOllamaToolCall(call, i));
      }
      return { text: message.content ?? '', toolCalls, ...usageOf(data), raw: data };
    },
  };
}

/**
 * Ollama is OpenAI-ish but NOT identical: function.arguments usually arrives as
 * an OBJECT already (some builds emit a JSON string) — handle both. Calls carry
 * no id, so synthesize one for the neutral transcript.
 */
function parseOllamaToolCall(call, index) {
  const name = call.function?.name;
  const id = call.id ?? `ollama_call_${index}`;
  const raw = call.function?.arguments;
  if (raw == null || raw === '') return { id, name, args: {} };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { id, name, args: raw };
  try {
    const args = JSON.parse(String(raw));
    if (args && typeof args === 'object' && !Array.isArray(args)) return { id, name, args };
    return { id, name, args: {}, parseError: `tool arguments must be a JSON object, got: ${String(raw).slice(0, 200)}` };
  } catch (error) {
    return { id, name, args: {}, parseError: `unparseable tool arguments (${error.message}): ${String(raw).slice(0, 200)}` };
  }
}

/** Neutral transcript → ollama chat messages (arguments stay objects; results carry tool_name). */
function toOllamaMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content ?? '' };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.args ?? {} },
        }));
      }
      return msg;
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_name: m.name, content: String(m.content ?? '') };
    }
    return { role: 'user', content: m.content };
  });
}
