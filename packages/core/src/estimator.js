/**
 * Pre-execution resource estimation: agents, tokens, cost, wall-clock.
 *
 * @param {import('./types.js').TaskGraph} taskGraph
 * @param {import('./types.js').ExecutionStrategy} strategy
 * @returns {{totalAgents: number, maxConcurrent: number, tokens: number, costUSD: number, minutes: number}}
 */
export function estimate(taskGraph, strategy) {
  void taskGraph; void strategy;
  throw new Error('not implemented (P4)');
}
