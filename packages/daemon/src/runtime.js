/**
 * Workflow runtime — glues sandbox + agent queue + store + budget + ws events.
 * Owns the workflow lifecycle: exec, checkpoint, pause/resume/stop, completion.
 *
 * Deterministic node identity (resume cache): node_id = sha1(workflowId|phase|roleId|prompt).
 * On resume, completed nodes return cached output; 'running'/'failed' nodes
 * (< max_retries) are re-queued.
 */

/**
 * @param {{store: object, queue: object, config: object, events: object, logger: object}} deps
 * @returns {{
 *   execWorkflow: (plan: object, strategyOverrides?: object) => Promise<string>,
 *   control: (workflowId: string, action: "pause"|"resume"|"stop") => Promise<object>,
 *   resumeInterrupted: () => Promise<string[]>,
 * }}
 */
export function createRuntime(deps) {
  void deps;
  throw new Error('not implemented (P4)');
}
