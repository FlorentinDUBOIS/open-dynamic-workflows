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
import { toolDefinitionsFor, positionalToolArgs } from './tools.js';

/** Error codes classified as retryable by the GENERIC retry path. */
export const RETRYABLE = new Set(['rate_limit', 'timeout', 'service_unavailable']);

/** Tool-loop bounds: default and hard cap on model⇄tool round trips per agent. */
const DEFAULT_TOOL_ITERATIONS = 8;
const MAX_TOOL_ITERATIONS = 16;
/** Mid-loop overflow recovery: bounded retries before deferring to Layer 2. */
const MAX_TOOL_OVERFLOW_RETRIES = 2;
/** Never compact a tool result below this many chars (keeps SOME signal). */
const MIN_TOOL_RESULT_CHARS = 256;

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
  let highWaterPending = 0;

  /**
   * @param {{model: string, systemPrompt?: string, prompt: string, schema?: object,
   *          maxTokens?: number, temperature?: number, priority?: number,
   *          context?: object,
   *          tools?: string[], toolExecutor?: (payload: {tool: string, args: any[]}) => Promise<any>,
   *          maxToolIterations?: number}} job  job.context carries the per-workflow
   *          strategy.context; job.tools (manifest names) + job.toolExecutor activate
   *          the model-side tool loop on providers that support callWithTools
   * @param {AbortSignal} [signal]
   * @returns {Promise<{output: any, text: string, tokensInput: number, tokensOutput: number, durationMs: number}>}
   */
  async function executeAgent(job, signal) {
    const ctx = { ...DEFAULT_CONTEXT, ...(job.context ?? {}) };
    return queue.add(
      async () => {
        highWaterPending = Math.max(highWaterPending, queue.pending);
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

            // Errors flagged noRetry (tool-loop final-turn schema failures) must
            // NOT re-enter callOnce — a blind outer retry would re-run the whole
            // loop and replay side-effectful tools from scratch.
            if (error.noRetry) throw error;

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

  // Providers already warned about (once per provider, not per call).
  const warnedNoToolLoop = new Set();

  async function callOnce(job, signal, correction, ctx, windowShrink) {
    const { provider, model } = options.resolveProvider(job.model);

    // ── tool-use loop dispatch ──
    if (Array.isArray(job.tools) && job.tools.length > 0) {
      if (typeof provider.callWithTools === 'function') {
        return runToolLoop(job, provider, model, signal, ctx, windowShrink);
      }
      // Provider has a text-only contract (host/embedded path): preserve
      // today's behavior — the tools key is dropped and the agent runs as a
      // single call. Warn once per provider so the degradation is visible
      // instead of silent, but NEVER throw (examples already pass tools).
      const key = provider.name ?? 'unknown';
      if (!warnedNoToolLoop.has(key)) {
        warnedNoToolLoop.add(key);
        log.warn(`provider "${key}" has no tool-use support — running agent({tools}) as a single call with tools stripped`, { model: job.model });
      }
    }

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
      schemaSuffix = `\n\n${schemaInstruction(schema)}`;
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
    // Loop-only keys must never leak to a provider's single-call wire format
    // (no-op deletes on plain jobs — behavior is byte-identical).
    delete effectiveJob.tools;
    delete effectiveJob.toolExecutor;
    delete effectiveJob.maxToolIterations;

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
   * Model-side tool-use loop. The queue OWNS the neutral transcript format —
   * {role:'user'|'assistant'|'tool', ...} — and providers map it to their
   * native wire shape in callWithTools. The schema suffix is withheld until
   * the FINAL tool-free turn so the model doesn't answer in JSON while it
   * still needs tools, and so the tool portion is never replayed on a
   * schema-correction retry.
   */
  async function runToolLoop(job, provider, model, signal, ctx, windowShrink) {
    const tools = toolDefinitionsFor(job.tools);
    const maxIterations = Math.min(MAX_TOOL_ITERATIONS, Math.max(1, Math.floor(job.maxToolIterations ?? DEFAULT_TOOL_ITERATIONS)));

    // Layer-1 guard applies to the SEED prompt only; grown tool results are
    // handled by the mid-loop overflow recovery below.
    let userContent = job.prompt;
    if (ctx.enabled) {
      const userCharBudget = userContentCharBudget(model, ctx, windowShrink, job.systemPrompt, '', job.maxTokens);
      if (userCharBudget !== null && userContent.length > userCharBudget) {
        const before = userContent.length;
        userContent = compactText(userContent, userCharBudget);
        options.onCompact?.({ model, fromChars: before, toChars: userContent.length, reason: windowShrink < 1 ? 'overflow_retry' : 'pre_call' });
        log.warn(`agent prompt compacted to fit context (${before}→${userContent.length} chars)`, { model });
      }
    }

    const transcript = [{ role: 'user', content: userContent }];
    // Usage is SUMMED across EVERY provider call — runtime budget.track and the
    // workflow totals consume the summed figures; undercounting would let a
    // tool-looping agent sail past the budget hard-stop.
    let tokensInput = 0;
    let tokensOutput = 0;

    // One provider call. The per-attempt AbortController timeout resets PER
    // CALL — a multi-turn loop with one long run_bash would otherwise
    // spuriously hit the per-agent cap and replay every side-effectful tool.
    const callProvider = async (withTools, finalSchema) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), perAgentTimeoutMs);
      try {
        const response = await provider.callWithTools(
          {
            model,
            systemPrompt: job.systemPrompt,
            messages: transcript,
            tools: withTools ? tools : undefined,
            maxTokens: job.maxTokens,
            temperature: job.temperature,
            // only set on the final tool-free turn, where ollama applies format
            schema: finalSchema,
          },
          { signal: controller.signal }
        );
        tokensInput += response.tokensInput ?? 0;
        tokensOutput += response.tokensOutput ?? 0;
        options.onUsage?.(job.model, response.tokensInput ?? 0, response.tokensOutput ?? 0);
        return response;
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
    };

    // Mid-loop context-overflow self-heal: compact the LARGEST tool result in
    // the transcript and retry the SAME call — bounded, then rethrown so the
    // outer Layer 2 restarts from scratch (accepted documented fallback).
    const callWithOverflowRecovery = async (withTools, finalSchema) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callProvider(withTools, finalSchema);
        } catch (error) {
          if (error.code !== 'context_overflow' || !ctx.enabled || !ctx.overflowRetry) throw error;
          if (attempt >= MAX_TOOL_OVERFLOW_RETRIES || !compactLargestToolResult(transcript)) throw error;
          log.warn(`tool loop context overflow — compacted largest tool result, retrying (${attempt + 1}/${MAX_TOOL_OVERFLOW_RETRIES})`, { model });
        }
      }
    };

    for (let iteration = 0; ; iteration++) {
      if (signal?.aborted) throw abortError();
      if (iteration >= maxIterations) {
        // Cap reached with the model still requesting tools: force an answer.
        transcript.push({ role: 'user', content: 'Tool budget exhausted — answer now with what you have.' });
        break;
      }
      const response = await callWithOverflowRecovery(true);
      if (!response.toolCalls?.length) {
        if (!job.schema) {
          // plain job: the model's last text IS the output
          return { output: response.text, text: response.text, tokensInput, tokensOutput };
        }
        const parsed = extractJson(response.text);
        if (parsed !== undefined) {
          const verdict = compileSchema(job.schema)(parsed);
          if (verdict.valid) {
            return { output: parsed, text: response.text, tokensInput, tokensOutput };
          }
        }
        transcript.push({ role: 'assistant', content: response.text || null });
        break;
      }
      transcript.push({
        role: 'assistant',
        content: response.text || null,
        toolCalls: response.toolCalls.map(({ id, name, args }) => ({ id, name, args })),
      });
      // Sequential execution: tools share working-directory state, and a
      // failure (including an approval-gate error) feeds back to the model as
      // an isError tool result — NEVER a thrown error that kills the agent.
      for (const call of response.toolCalls) {
        if (signal?.aborted) throw abortError();
        transcript.push(await executeToolCall(job, call));
      }
    }

    // ── final tool-free turn ──
    if (!job.schema) {
      const response = await callWithOverflowRecovery(false);
      return { output: response.text, text: response.text, tokensInput, tokensOutput };
    }

    const schema = normalizeSchema(job.schema);
    const validate = compileSchema(job.schema);
    transcript.push({ role: 'user', content: schemaInstruction(schema) });
    let lastErrors = ['no final attempt completed'];
    let lastText = '';
    // schema_invalid retries the FINAL TURN ONLY (correction appended to the
    // SAME transcript) up to the queue's maxAttempts — the tool portion is
    // never replayed.
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw abortError();
      const response = await callWithOverflowRecovery(false, schema);
      const parsed = extractJson(response.text);
      const verdict = parsed === undefined
        ? { valid: false, errors: ['the reply was not valid JSON'] }
        : validate(parsed);
      if (verdict.valid) {
        return { output: parsed, text: response.text, tokensInput, tokensOutput };
      }
      lastErrors = verdict.errors;
      lastText = response.text;
      transcript.push({ role: 'assistant', content: response.text || null });
      transcript.push({
        role: 'user',
        content:
          `Your PREVIOUS reply was rejected: ${verdict.errors.join('; ')}.` +
          `\nIt was:\n${String(response.text).slice(0, 1500)}` +
          `\nReturn corrected JSON now — only the JSON object.`,
      });
      log.warn(`tool loop final turn schema-invalid — retrying final turn ${attempt}/${maxAttempts}`, { model });
    }
    const err = new Error(`the model's reply did not match the required JSON shape (${lastErrors.slice(0, 3).join('; ')})`);
    err.code = 'schema_invalid';
    err.validationErrors = lastErrors;
    err.rawOutput = lastText;
    // noRetry: the outer retry loop must NOT re-run callOnce — that would
    // replay the side-effectful tool portion from scratch.
    err.noRetry = true;
    throw err;
  }

  /**
   * Execute one model-requested tool call, mapping named args to the
   * positional order createToolExecutor expects. ANY failure — unknown tool,
   * unparseable provider args, approval gate, executor throw — becomes an
   * isError tool result the model can react to.
   */
  async function executeToolCall(job, call) {
    const base = { role: 'tool', toolCallId: call.id, name: call.name };
    if (call.parseError) {
      return { ...base, content: call.parseError, isError: true };
    }
    if (typeof job.toolExecutor !== 'function') {
      return { ...base, content: 'no tool executor is available for this run', isError: true };
    }
    try {
      const args = positionalToolArgs(call.name, call.args);
      const result = await job.toolExecutor({ tool: call.name, args });
      return { ...base, content: typeof result === 'string' ? result : JSON.stringify(result ?? null) };
    } catch (error) {
      return { ...base, content: String(error?.message ?? error), isError: true };
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
    highWaterPending: () => highWaterPending,
    clear: () => queue.clear(),
    onIdle: () => queue.onIdle(),
  };
}

/** The one schema instruction BOTH paths use (suffix-embedded or final-turn message). */
function schemaInstruction(schema) {
  return `Respond with ONLY a single JSON object matching this schema — no prose, no explanation, no markdown code fences:\n${JSON.stringify(schema)}`;
}

/**
 * Truncate the LARGEST tool result in the transcript in place (ties go to the
 * OLDEST via strict >). Returns false when nothing is left worth cutting, so
 * the overflow recovery can stop instead of spinning.
 */
function compactLargestToolResult(transcript) {
  let target = null;
  for (const message of transcript) {
    if (message.role === 'tool' && typeof message.content === 'string' &&
        (!target || message.content.length > target.content.length)) {
      target = message;
    }
  }
  if (!target || target.content.length <= MIN_TOOL_RESULT_CHARS) return false;
  target.content = compactText(target.content, Math.max(MIN_TOOL_RESULT_CHARS, Math.floor(target.content.length / 2)));
  return true;
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
