/**
 * Task decomposition — turns a natural-language prompt into a TaskGraph.
 * When an LLM planner is available (daemon), it drives this; the heuristic
 * decomposer here is the deterministic fallback and the shape validator.
 *
 * @param {string} prompt
 * @param {{complexityHint?: import('./types.js').Complexity}} [options]
 * @returns {import('./types.js').TaskGraph}
 */
export function decompose(prompt, options) {
  void prompt; void options;
  throw new Error('not implemented (P4)');
}
