/**
 * Token/cost budget tracker. Per-workflow caps; alert at alertAtPercent (80),
 * hard stop at 100% (workflow → paused). Real-time cost via odw-core pricing.
 */

/**
 * @param {{maxTokens: number, maxCostUSD: number, alertAtPercent: number,
 *          onAlert: (type: "warning"|"exceeded", usage: object) => void}} options
 * @returns {{track: (model: string, tokensInput: number, tokensOutput: number) => void,
 *           snapshot: () => {tokensUsed: number, costUSD: number, maxTokens: number,
 *                            maxCostUSD: number, percentUsed: number},
 *           exceeded: () => boolean}}
 */
export function createBudget(options) {
  void options;
  throw new Error('not implemented (P4)');
}
