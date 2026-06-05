import { costFor } from './pricing.js';

/**
 * Pre-execution resource estimation: agents, tokens, cost, wall-clock.
 *
 * @param {import('./types.js').TaskGraph} taskGraph
 * @param {import('./types.js').ExecutionStrategy} strategy
 * @returns {{totalAgents: number, maxConcurrent: number, tokens: number, costUSD: number, minutes: number}}
 */
export function estimate(taskGraph, strategy) {
  const totalAgents = Math.max(1, taskGraph?.root?.estimatedTotalAgents ?? taskGraph?.tasks?.length ?? 1);
  const maxConcurrent = Math.min(strategy.concurrency.max, totalAgents);

  const perAgentTokens = average(
    (taskGraph?.tasks ?? []).map((t) => t.estimatedTokens || 6000)
  );
  const tokens = Math.round(totalAgents * perAgentTokens);

  // assume ~60% input / 40% output split for estimation
  const costUSD = round2(costFor(strategy.budget.model, tokens * 0.6, tokens * 0.4));

  // ~30s per agent wall-clock, divided by effective concurrency, plus startup overhead
  const waves = Math.ceil(totalAgents / Math.max(1, maxConcurrent));
  const minutes = Math.max(1, Math.round((waves * 30 + 15) / 60));

  return { totalAgents, maxConcurrent, tokens, costUSD, minutes };
}

function average(values) {
  if (!values.length) return 6000;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
