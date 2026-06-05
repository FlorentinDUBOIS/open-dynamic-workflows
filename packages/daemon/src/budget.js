/**
 * Token/cost budget tracker. Per-workflow caps; alert at alertAtPercent,
 * hard stop at 100%. Real-time cost via odw-core pricing.
 */

import { costFor } from 'odw-core';

/**
 * @param {{maxTokens: number, maxCostUSD: number, alertAtPercent: number,
 *          onAlert?: (type: "warning"|"exceeded", usage: object) => void}} options
 */
export function createBudget(options) {
  const maxTokens = Math.max(1, options.maxTokens);
  const maxCostUSD = Math.max(0, options.maxCostUSD);
  const alertAt = (options.alertAtPercent ?? 80) / 100;
  let tokensUsed = 0;
  let costUSD = 0;
  let warned = false;
  let stopped = false;

  const percentUsed = () => {
    const byTokens = tokensUsed / maxTokens;
    const byCost = maxCostUSD > 0 ? costUSD / maxCostUSD : 0;
    return Math.max(byTokens, byCost);
  };

  return {
    /** Record usage from one completed call. */
    track(model, tokensInput, tokensOutput) {
      tokensUsed += (Number(tokensInput) || 0) + (Number(tokensOutput) || 0);
      costUSD += costFor(model, tokensInput, tokensOutput);
      const used = percentUsed();
      if (used >= 1 && !stopped) {
        stopped = true;
        options.onAlert?.('exceeded', this.snapshot());
      } else if (used >= alertAt && !warned) {
        warned = true;
        options.onAlert?.('warning', this.snapshot());
      }
    },
    snapshot() {
      return {
        tokensUsed,
        costUSD: Math.round(costUSD * 10000) / 10000,
        maxTokens,
        maxCostUSD,
        percentUsed: Math.round(percentUsed() * 1000) / 10,
      };
    },
    exceeded: () => stopped,
    /** Seed from persisted workflow totals on resume. */
    seed(tokens, cost) {
      tokensUsed = Number(tokens) || 0;
      costUSD = Number(cost) || 0;
    },
  };
}
