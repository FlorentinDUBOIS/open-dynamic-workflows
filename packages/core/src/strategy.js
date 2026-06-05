/**
 * Execution strategy defaults + merging of user overrides.
 * Hard limits are clamped: nothing a caller passes can exceed the ceilings.
 */

const CEILINGS = {
  maxConcurrency: 100,
  maxTokens: 10_000_000,
  maxCostUSD: 500,
  totalSeconds: 6 * 3600,
};

/**
 * @returns {import('./types.js').ExecutionStrategy}
 */
export function defaultStrategy() {
  return {
    concurrency: { max: 16, default: 16 },
    checkpoint: { intervalSeconds: 30, onPhaseComplete: true },
    retry: {
      maxAttempts: 3,
      backoff: 'exponential',
      retryableErrors: ['rate_limit', 'timeout', 'service_unavailable'],
    },
    budget: { maxTokens: 1_000_000, maxCostUSD: 50, alertAtPercent: 80, model: 'claude-sonnet-4-6' },
    timeouts: { perAgent: 120, perPhase: 600, total: 3600 },
    safety: {
      requireApprovalFor: ['write_file', 'run_bash', 'git_commit'],
      autoApproveReadOnly: true,
      dryRun: false,
    },
    git: { createBranch: true, branchPrefix: 'odw/', commitCheckpoints: false },
  };
}

/**
 * Deep-merge overrides over defaults, clamped to ceilings.
 * @param {object} [overrides]
 * @returns {import('./types.js').ExecutionStrategy}
 */
export function mergeStrategy(overrides) {
  const base = defaultStrategy();
  const merged = deepMerge(base, overrides ?? {});
  merged.concurrency.max = clamp(merged.concurrency.max, 1, CEILINGS.maxConcurrency);
  merged.concurrency.default = clamp(merged.concurrency.default, 1, merged.concurrency.max);
  merged.budget.maxTokens = clamp(merged.budget.maxTokens, 1000, CEILINGS.maxTokens);
  merged.budget.maxCostUSD = clamp(merged.budget.maxCostUSD, 0, CEILINGS.maxCostUSD);
  merged.budget.alertAtPercent = clamp(merged.budget.alertAtPercent, 1, 100);
  merged.retry.maxAttempts = clamp(merged.retry.maxAttempts, 1, 10);
  merged.timeouts.perAgent = clamp(merged.timeouts.perAgent, 1, CEILINGS.totalSeconds);
  merged.timeouts.perPhase = clamp(merged.timeouts.perPhase, merged.timeouts.perAgent, CEILINGS.totalSeconds);
  merged.timeouts.total = clamp(merged.timeouts.total, merged.timeouts.perPhase, CEILINGS.totalSeconds);
  return merged;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function deepMerge(base, overrides) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof base?.[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
