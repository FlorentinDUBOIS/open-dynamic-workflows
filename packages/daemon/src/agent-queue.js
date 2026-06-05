/**
 * Agent request queue: p-queue manages concurrent HTTP requests to LLM APIs
 * (network I/O — NOT worker_threads). Retries with backoff on retryable
 * errors, per-agent wall-clock timeout, AbortSignal propagation.
 */

import PQueue from 'p-queue';
import { extractJson, compileSchema, normalizeSchema } from 'odw-core';

/** Error codes classified as retryable. */
export const RETRYABLE = new Set(['rate_limit', 'timeout', 'service_unavailable']);

/**
 * @param {{maxConcurrency: number,
 *          retry?: {maxAttempts?: number, backoff?: "exponential"|"linear"},
 *          perAgentTimeout?: number,
 *          resolveProvider: (model: string) => {provider: object, model: string},
 *          onUsage?: (model: string, tokensInput: number, tokensOutput: number) => void,
 *          logger?: object}} options
 */
export function createAgentQueue(options) {
  const queue = new PQueue({ concurrency: Math.max(1, options.maxConcurrency), autoStart: true });
  const maxAttempts = options.retry?.maxAttempts ?? 3;
  const backoff = options.retry?.backoff ?? 'exponential';
  const perAgentTimeoutMs = (options.perAgentTimeout ?? 120) * 1000;
  const log = options.logger ?? { debug() {}, info() {}, warn() {}, error() {} };

  /**
   * @param {{model: string, systemPrompt?: string, prompt: string, schema?: object,
   *          maxTokens?: number, temperature?: number, priority?: number}} job
   * @param {AbortSignal} [signal]
   * @returns {Promise<{output: any, text: string, tokensInput: number, tokensOutput: number, durationMs: number}>}
   */
  async function executeAgent(job, signal) {
    return queue.add(
      async () => {
        const started = Date.now();
        let lastError;
        // Correction hint fed back into the NEXT attempt when the model returned
        // unparseable or schema-invalid output — turns a blind retry into a
        // self-correcting one, which matters a lot for weaker/free models.
        let correction = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (signal?.aborted) throw abortError();
          try {
            const result = await callOnce(job, signal, correction);
            return { ...result, durationMs: Date.now() - started };
          } catch (error) {
            lastError = error;
            if (signal?.aborted || error.name === 'AbortError') throw abortError();
            const retryable = RETRYABLE.has(error.code) || error.code === 'schema_invalid';
            if (!retryable || attempt === maxAttempts) throw error;
            correction = error.code === 'schema_invalid'
              ? { errors: error.validationErrors ?? [error.message], badOutput: error.rawOutput }
              : null;
            const delay = backoff === 'linear' ? attempt * 1000 : 2 ** (attempt - 1) * 1000;
            log.warn(`agent retry ${attempt}/${maxAttempts} in ${delay}ms`, { code: error.code });
            await sleep(delay, signal);
          }
        }
        throw lastError;
      },
      { priority: job.priority ?? 0 }
    );
  }

  async function callOnce(job, signal, correction) {
    const { provider, model } = options.resolveProvider(job.model);

    // combine caller signal with the per-agent timeout
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), perAgentTimeoutMs);

    // Schema handling that works across ALL providers (including free models
    // with no native structured-output support): normalize the schema, embed
    // it in the prompt as an instruction, and parse the result with the
    // tolerant extractJson cascade. Native structured-output (response_format /
    // output_config / format) is only requested when explicitly enabled, since
    // many free/open models reject it.
    let effectiveJob = { ...job, model };
    if (job.schema) {
      const schema = normalizeSchema(job.schema);
      let instruction =
        `${job.prompt}\n\nRespond with ONLY a single JSON object matching this schema — no prose, no explanation, no markdown code fences:\n${JSON.stringify(schema)}`;
      if (correction) {
        // Self-correction pass: show the model exactly what was wrong.
        instruction +=
          `\n\nYour PREVIOUS reply was rejected: ${correction.errors.join('; ')}.` +
          (correction.badOutput ? `\nIt was:\n${String(correction.badOutput).slice(0, 1500)}` : '') +
          `\nReturn corrected JSON now — only the JSON object.`;
      }
      effectiveJob.prompt = instruction;
      effectiveJob.schema = options.nativeStructuredOutput ? schema : undefined;
    }

    try {
      const response = await provider.call(effectiveJob, { signal: controller.signal });
      options.onUsage?.(job.model, response.tokensInput, response.tokensOutput);

      let output = response.text;
      if (job.schema) {
        const parsed = extractJson(response.text);
        const verdict = parsed === undefined
          ? { valid: false, errors: ['the reply was not valid JSON'] }
          : compileSchema(job.schema)(parsed);
        if (!verdict.valid) {
          const err = new Error(`the model's reply did not match the required JSON shape (${verdict.errors.slice(0, 3).join('; ')})`);
          err.code = 'schema_invalid';
          err.validationErrors = verdict.errors;
          err.rawOutput = response.text;
          throw err;
        }
        output = parsed;
      }
      return { output, text: response.text, tokensInput: response.tokensInput, tokensOutput: response.tokensOutput };
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        const err = new Error(`agent call exceeded ${perAgentTimeoutMs / 1000}s timeout`);
        err.code = 'timeout';
        throw err;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    executeAgent,
    size: () => queue.size,
    pending: () => queue.pending,
    clear: () => queue.clear(),
    onIdle: () => queue.onIdle(),
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(abortError());
      },
      { once: true }
    );
  });
}

function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  err.code = 'aborted';
  return err;
}
