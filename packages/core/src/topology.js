/**
 * Topology selection — maps a TaskGraph to the SIMPLEST topology that fits.
 * Order of preference: mapreduce < pipeline < adversarial < consensus < treesearch < hybrid.
 *
 * @param {import('./types.js').TaskGraph} taskGraph
 * @returns {import('./types.js').Topology}
 */
export function selectTopology(taskGraph) {
  void taskGraph;
  throw new Error('not implemented (P4)');
}
