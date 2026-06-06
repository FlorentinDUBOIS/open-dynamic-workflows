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

import { estimateTokens } from 'odw-core';

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
      const text = typeof res === 'string' ? res : String(res?.text ?? '');

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
  };
}
