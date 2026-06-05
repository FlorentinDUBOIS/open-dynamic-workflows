/**
 * Agent request queue: p-queue manages concurrent HTTP requests to LLM APIs
 * (network I/O — NOT worker_threads). Retry with backoff on retryable errors,
 * per-agent wall-clock timeout, AbortSignal propagation for user stop.
 */

/** Errors classified as retryable. */
export const RETRYABLE = new Set(['rate_limit', 'timeout', 'service_unavailable']);

/**
 * @param {{maxConcurrency: number, retry: {maxAttempts: number, backoff: string},
 *          perAgentTimeout: number, resolveProvider: Function, validateOutput: Function,
 *          onUsage: Function, logger: object}} options
 * @returns {{executeAgent: (job: object, signal: AbortSignal) => Promise<import('odw-core/src/types.js').AgentResult>,
 *           size: () => number, pending: () => number}}
 */
export function createAgentQueue(options) {
  void options;
  throw new Error('not implemented (P4)');
}
