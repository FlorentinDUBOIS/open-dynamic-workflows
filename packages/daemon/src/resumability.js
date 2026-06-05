/**
 * Resumability engine: load latest checkpoint + completed-node cache,
 * re-queue orphaned ('running') and retryable 'failed' nodes, then re-run the
 * script — completed agent() calls resolve instantly from cache.
 */

/**
 * @param {{store: object, runtime: object, logger: object}} deps
 * @returns {{
 *   resumeWorkflow: (workflowId: string) => Promise<boolean>,
 *   listInterrupted: () => Array<{workflow_id: string, status: string}>,
 * }}
 */
export function createResumability(deps) {
  void deps;
  throw new Error('not implemented (P4)');
}
