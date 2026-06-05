/**
 * The 5-phase planning pipeline:
 *   1 decompose → 2 selectTopology → 3 buildRoles → 4 mergeStrategy → 5 plan summary
 * Produces the full Plan artifact (including the generated orchestration script).
 *
 * @param {string} prompt
 * @param {{strategy?: object, llmDecompose?: (prompt: string) => Promise<import('./types.js').TaskGraph>}} [options]
 * @returns {Promise<import('./types.js').Plan>}
 */
export async function createPlan(prompt, options) {
  void prompt; void options;
  throw new Error('not implemented (P4)');
}
