/**
 * Agent request queue: p-queue manages concurrent HTTP requests to LLM APIs
 * (network I/O — NOT worker_threads). Retries with backoff on retryable
 * errors, per-agent wall-clock timeout, AbortSignal propagation.
 *
 * Context-window safety (the small-model lifeline) lives here too, in two layers:
 *  - PRE-CALL GUARD: before sending, estimate the input against the model's
 *    window and, if it would overflow, compact the USER-CONTENT portion to fit
 *    (the system prompt + schema instruction are reserved and never cut). For
 *    UNKNOWN-window models the proactive guard is skipped on the first try, so
 *    today's send-everything behavior is preserved; reactive recovery still
 *    protects them. When the input already fits, the guard is a pure pass-through
 *    — byte-identical to the legacy path.
 *  - REACTIVE SELF-HEAL: a real provider 'context_overflow' 400 is caught in a
 *    SEPARATE bounded loop that shrinks the assumed window and re-compacts before
 *    retrying — distinct from the generic retry path, never added to RETRYABLE
 *    (which would blindly resend the same oversized prompt).
 */

import PQueue from 'p-queue';
import { extractJson, compileSchema, normalizeSchema, contextWindowFor, estimateTokens, compactText, TOKEN_SAFETY_MARGIN } from 'odw-core';

/** Error codes classified as retryable by the GENERIC retry path. */
export const RETRYABLE = new Set(['rate_limit', 'timeout', 'service_unavailable']);

/** Per-message overhead, matching odw-core's estimator (PER_MESSAGE_OVERHEAD 4 + REPLY_PRIMING 3). */
const MESSAGE_OVERHEAD_TOKENS = 7;
/** Floor so a pathological reserve never compacts the user prompt to nothing. */
const MIN_USER_TOKENS = 64;
/** Densest char/token divisor — converting a token budget to chars with it
 *  guarantees the resulting text fits the budget for ANY content kind. */
const SAFE_DIVISOR = 3;

const DEFAULT_CONTEXT = { enabled: true, safetyFactor: 0.9, reservedOutputTokens: 4096, maxCompactAttempts: 3, overflowRetry: true };

/**
 * @param {{maxConcurrency: number,
 *          retry?: {maxAttempts?: number, backoff?: "exponential"|"linear"},
 *          perAgentTimeout?: number,
 *          nativeStructuredOutput?: boolean,
 *          resolveProvider: (model: string) => {provider: object, model: string},
 *          onUsage?: (model: string, tokensInput: number, tokensOutput: number) => void,
 *          onCompact?: (info: {model: string, fromChars: number, toChars: number, reason: string}) => void,
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
   *          maxTokens?: number, temperature?: number, priority?: number,
   *          context?: object}} job  job.context carries the per-workflow strategy.context
   * @param {AbortSignal} [signal]
   * @returns {Promise<{output: any, text: string, tokensInput: number, tokensOutput: number, durationMs: number}>}
   */
  async function executeAgent(job, signal) {
    const ctx = { ...DEFAULT_CONTEXT, ...(job.context ?? {}) };
    return queue.add(
      async () => {
        const started = Date.now();
        let lastError;
        // Correction hint fed back into the NEXT attempt when the model returned
        // unparseable or schema-invalid output — turns a blind retry into a
        // self-correcting one, which matters a lot for weaker/free models.
        let correction = null;
        // Reactive context-overflow self-heal: a multiplier on the assumed window
        // that shrinks each time the provider reports a real overflow.
        let windowShrink = 1.0;
        let genericAttempt = 0;
        let overflowAttempt = 0;

        for (;;) {
          if (signal?.aborted) throw abortError();
          try {
            const result = await callOnce(job, signal, correction, ctx, windowShrink);
            return { ...result, durationMs: Date.now() - started };
          } catch (error) {
            lastError = error;
            if (signal?.aborted || error.name === 'AbortError') throw abortError();

            // ── Layer 2: reactive context-overflow self-heal (separate counter) ──
            if (error.code === 'context_overflow') {
              if (!ctx.enabled || !ctx.overflowRetry) throw error;
              overflowAttempt++;
              if (overflowAttempt > ctx.maxCompactAttempts) throw error; // bounded — never loops
              // Shrink the assumed window: a real overflow proves the estimate was
              // low. When the provider reports the actual limit we trust it and
              // apply a light 0.9 trim; with NO reported limit we know less, so a
              // more aggressive 0.8 step converges faster (the asymmetry is
              // intentional — both ratios are bounded by maxCompactAttempts).
              if (error.limitTokens) {
                const { window } = contextWindowFor(job.model);
                windowShrink = Math.min(windowShrink, (error.limitTokens / window)) * 0.9;
              } else {
                windowShrink *= 0.8;
              }
              log.warn(`agent context overflow — compacting and retrying (${overflowAttempt}/${ctx.maxCompactAttempts})`, { model: job.model });
              continue; // no backoff sleep; re-enter callOnce with a smaller budget
            }

            // ── generic retry path (unchanged semantics) ──
            const retryable = RETRYABLE.has(error.code) || error.code === 'schema_invalid';
            genericAttempt++;
            if (!retryable || genericAttempt >= maxAttempts) throw error;
            correction = error.code === 'schema_invalid'
              ? { errors: error.validationErrors ?? [error.message], badOutput: error.rawOutput }
              : null;
            const delay = backoff === 'linear' ? genericAttempt * 1000 : 2 ** (genericAttempt - 1) * 1000;
            log.warn(`agent retry ${genericAttempt}/${maxAttempts} in ${delay}ms`, { code: error.code });
            await sleep(delay, signal);
          }
        }
        // unreachable; the loop only exits via return or throw
        // eslint-disable-next-line no-unreachable
        throw lastError;
      },
      { priority: job.priority ?? 0 }
    );
  }

  async function callOnce(job, signal, correction, ctx, windowShrink) {
    const { provider, model } = options.resolveProvider(job.model);

    // combine caller signal with the per-agent timeout
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), perAgentTimeoutMs);

    // Schema handling that works across ALL providers (including free models with
    // no native structured-output support): normalize the schema and embed it in
    // the prompt as an instruction (the SUFFIX), parse with the tolerant
    // extractJson cascade. Native structured-output is only requested when
    // explicitly enabled, since many free/open models reject it.
    let userContent = job.prompt;
    let schemaSuffix = '';
    let nativeSchema;
    if (job.schema) {
      const schema = normalizeSchema(job.schema);
      schemaSuffix =
        `\n\nRespond with ONLY a single JSON object matching this schema — no prose, no explanation, no markdown code fences:\n${JSON.stringify(schema)}`;
      if (correction) {
        schemaSuffix +=
          `\n\nYour PREVIOUS reply was rejected: ${correction.errors.join('; ')}.` +
          (correction.badOutput ? `\nIt was:\n${String(correction.badOutput).slice(0, 1500)}` : '') +
          `\nReturn corrected JSON now — only the JSON object.`;
      }
      nativeSchema = options.nativeStructuredOutput ? schema : undefined;
    }

    // ── Layer 1: pre-call context-fit guard (compacts USER CONTENT only) ──
    // The schema suffix + system prompt are reserved and never cut, so the
    // actually-sent wire payload fits the budget by construction even on retry.
    if (ctx.enabled) {
      const userCharBudget = userContentCharBudget(model, ctx, windowShrink, job.systemPrompt, schemaSuffix, job.maxTokens);
      if (userCharBudget !== null && userContent.length > userCharBudget) {
        const before = userContent.length;
        userContent = compactText(userContent, userCharBudget);
        options.onCompact?.({ model, fromChars: before, toChars: userContent.length, reason: windowShrink < 1 ? 'overflow_retry' : 'pre_call' });
        log.warn(`agent prompt compacted to fit context (${before}→${userContent.length} chars)`, { model });
      }
    }

    const effectiveJob = { ...job, model, prompt: userContent + schemaSuffix, schema: nativeSchema };

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

  /**
   * Char budget for the user-content portion of the prompt, or null when no
   * proactive compaction should happen (disabled, fits, or an unknown-window
   * model on its first attempt). Returns a char budget derived from the model's
   * token window minus reserved output and the fixed system+schema overhead.
   */
  function userContentCharBudget(model, ctx, windowShrink, systemPrompt, schemaSuffix, jobMaxTokens) {
    const { window, outputSharesWindow, known } = contextWindowFor(model);
    // Unknown-window model, first try: send everything as-is (no regression for
    // custom/local endpoints). Reactive self-heal handles a genuine overflow.
    if (!known && windowShrink >= 1) return null;

    const effWindow = Math.floor(window * windowShrink);
    const reserved = outputSharesWindow ? (jobMaxTokens ?? ctx.reservedOutputTokens) : 0;
    const budgetTokens = Math.floor((effWindow - reserved) * ctx.safetyFactor);
    // Apply the estimator's 1.15x safety margin to the FIXED (uncuttable) overhead
    // too — the same margin estimateMessageTokens uses — so a mildly under-counted
    // system prompt or schema suffix can never silently eat into the user budget.
    const fixedTokens = Math.ceil(
      (estimateTokens(systemPrompt ?? '') + estimateTokens(schemaSuffix ?? '') + MESSAGE_OVERHEAD_TOKENS) * TOKEN_SAFETY_MARGIN
    );
    if (fixedTokens >= budgetTokens) {
      // The uncuttable parts alone exceed the window; trimming user content cannot
      // recover this. Warn loudly rather than silently ship an over-budget call.
      log.warn(`fixed prompt overhead (~${fixedTokens} tok) meets/exceeds the context budget (~${budgetTokens} tok) for ${model} — system prompt/schema may be too large`, { model });
    }
    const userTokens = Math.max(MIN_USER_TOKENS, budgetTokens - fixedTokens);
    return userTokens * SAFE_DIVISOR;
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
