/**
 * Host provider — the agent-execution backend that routes an agent() call to the
 * HOST HARNESS's own configured model instead of an external API. It implements
 * the exact provider contract the queue expects ({ name, call(job,{signal}) ->
 * { text, tokensInput, tokensOutput, raw } }), so everything above it (sandbox,
 * planner, parallel/verify, budget, context guard, retries) is reused unchanged.
 *
 * You supply an `invoke(job, { signal }) -> string | { text, usage? }` that calls
 * the host (e.g. OpenCode's client.session.prompt). This is the ONLY model-aware
 * line that differs from the anthropic/openai/ollama providers.
 */

import { estimateTokens, extractJson } from 'odw-core';

const TEXT_TOOL_PROTOCOL = 'ODW_TEXT_TOOL_PROTOCOL';

/**
 * @param {{ invoke: (job: object, opts: {signal?: AbortSignal}) => Promise<string|{text: string, usage?: {input?: number, output?: number}}>,
 *           name?: string }} options
 */
export function createHostProvider({ invoke, name = 'host' }) {
  if (typeof invoke !== 'function') {
    throw new Error('createHostProvider requires an invoke(job, opts) function');
  }
  return {
    name,
    async call(job, opts = {}) {
      const res = await invoke(job, opts);
      const text = textOf(res);

      // Host model APIs frequently DO NOT report token usage. If we passed 0/0 up,
      // budget.track would add nothing, costFor(...,0,0) would be ~0, and the
      // budget hard-stop (percentUsed >= 100%) would NEVER trip — an embedded run
      // could then loop on the user's own host auth unbounded. So when usage is
      // absent we ESTIMATE it from the prompt + reply, keeping the cost/runaway
      // safety rail meaningful even though the host hides real counts.
      const usage = res && typeof res === 'object' ? res.usage : null;
      const tokensInput = usage && Number.isFinite(usage.input)
        ? usage.input
        : estimateTokens((job.systemPrompt ? job.systemPrompt + '\n\n' : '') + String(job.prompt ?? ''));
      const tokensOutput = usage && Number.isFinite(usage.output)
        ? usage.output
        : estimateTokens(text);

      return { text, tokensInput, tokensOutput, raw: res };
    },

    /**
     * Tool-loop variant for host APIs that only accept/return plain text.
     * When tools are present, the model is asked to emit a strict JSON protocol;
     * when tools are absent (final schema turn), this degrades to a transcript
     * prompt and returns raw text so queue-level schema validation still works.
     *
     * @param {{model: string, systemPrompt?: string, messages: object[],
     *          tools?: Array<{name: string, description: string, inputSchema: object}>,
     *          maxTokens?: number, temperature?: number, schema?: object}} job
     * @param {{signal?: AbortSignal}} [opts]
     */
    async callWithTools(job, opts = {}) {
      const hasTools = Array.isArray(job.tools) && job.tools.length > 0;
      const prompt = hasTools ? textToolPrompt(job) : transcriptPrompt(job);
      const hostJob = { ...job, prompt };
      delete hostJob.messages;
      delete hostJob.tools;
      delete hostJob.schema;
      delete hostJob.systemPrompt;

      const res = await invoke(hostJob, opts);
      const rawText = textOf(res);
      const usage = usageOf(res, prompt, rawText);

      if (!hasTools) {
        return { text: rawText, ...usage, raw: res };
      }

      const parsed = extractJson(rawText);
      const toolCalls = normalizeTextToolCalls(parsed?.toolCalls);
      const text = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.text === 'string'
        ? parsed.text
        : rawText;

      return {
        text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        ...usage,
        raw: res,
      };
    },
  };
}

function textOf(res) {
  return typeof res === 'string' ? res : String(res?.text ?? '');
}

function usageOf(res, prompt, text) {
  const usage = res && typeof res === 'object' ? res.usage : null;
  return {
    tokensInput: usage && Number.isFinite(usage.input) ? usage.input : estimateTokens(prompt),
    tokensOutput: usage && Number.isFinite(usage.output) ? usage.output : estimateTokens(text),
  };
}

function textToolPrompt(job) {
  const toolNames = job.tools.map((t) => t.name).join(', ');
  return [
    TEXT_TOOL_PROTOCOL,
    'You are inside ODW host-model tool mode. Return exactly one JSON object and no markdown.',
    'If you need tools, return {"text":"optional short note","toolCalls":[{"id":"call_1","name":"tool_name","args":{}}]}.',
    'If you can answer without another tool, return {"text":"final answer"} or the exact JSON object requested by the latest user instruction.',
    `Available tool names: ${toolNames}`,
    'Tool catalog:',
    job.tools.map(formatTool).join('\n\n'),
    job.systemPrompt ? `System instructions:\n${job.systemPrompt}` : '',
    'Transcript:',
    formatTranscript(job.messages ?? []),
  ].filter(Boolean).join('\n\n');
}

function transcriptPrompt(job) {
  return [
    job.systemPrompt ? `System instructions:\n${job.systemPrompt}` : '',
    'Transcript:',
    formatTranscript(job.messages ?? []),
  ].filter(Boolean).join('\n\n');
}

function formatTool(tool) {
  return [
    `- ${tool.name}: ${tool.description ?? ''}`.trim(),
    `  inputSchema: ${JSON.stringify(tool.inputSchema ?? { type: 'object' })}`,
  ].join('\n');
}

function formatTranscript(messages) {
  return messages.map((m, i) => {
    const lines = [`[${i + 1}] role=${m.role}`];
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      lines.push(`toolCalls=${JSON.stringify(m.toolCalls)}`);
    }
    if (m.role === 'tool') {
      lines.push(`toolCallId=${m.toolCallId ?? ''}`);
      if (m.name) lines.push(`name=${m.name}`);
      if (m.isError) lines.push('isError=true');
    }
    lines.push('content:');
    lines.push(String(m.content ?? ''));
    return lines.join('\n');
  }).join('\n\n');
}

function normalizeTextToolCalls(calls) {
  if (!Array.isArray(calls)) return [];
  const out = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call || typeof call !== 'object') continue;
    const name = typeof call.name === 'string' ? call.name.trim() : '';
    if (!name) continue;
    const parsed = normalizeArgs(call.args);
    const normalized = {
      id: String(call.id ?? `host_call_${i}`),
      name,
      args: parsed.args,
    };
    if (parsed.parseError) normalized.parseError = parsed.parseError;
    out.push(normalized);
  }
  return out;
}

function normalizeArgs(raw) {
  if (raw == null || raw === '') return { args: {} };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { args: raw };
  if (typeof raw === 'string') {
    const parsed = extractJson(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed };
    return { args: {}, parseError: `tool arguments must be a JSON object, got: ${raw.slice(0, 200)}` };
  }
  return { args: {}, parseError: `tool arguments must be a JSON object, got: ${String(raw).slice(0, 200)}` };
}
