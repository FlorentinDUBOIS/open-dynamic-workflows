/**
 * Resumability facade: list interrupted workflows and hand them back to the
 * runtime. The heavy lifting (orphan requeue, cache rebuild, deterministic
 * node identity) lives in runtime.js + db.js; this module is the API the CLI
 * and server use.
 */

/**
 * @param {{store: object, runtime: object, logger: object}} deps
 */
export function createResumability(deps) {
  const { store, runtime, logger } = deps;
  return {
    /** @param {string} workflowId */
    async resumeWorkflow(workflowId) {
      const ok = await runtime.resumeWorkflow(workflowId);
      if (ok) logger.info(`resumed workflow ${workflowId}`);
      return ok;
    },
    listInterrupted() {
      return store.listInterrupted();
    },
    async resumeAll() {
      const ids = await runtime.resumeInterrupted();
      if (ids.length) logger.info(`resumed ${ids.length} interrupted workflow(s)`, { ids });
      return ids;
    },
  };
}
