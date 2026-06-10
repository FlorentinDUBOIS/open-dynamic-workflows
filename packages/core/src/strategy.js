/**
 * Execution strategy defaults + merging of user overrides.
 * Hard limits are clamped: nothing a caller passes can exceed the ceilings.
 */

const CEILINGS = {
  maxConcurrency: 100,
  maxTokens: 10_000_000,
  maxCostUSD: 500,
  totalSeconds: 6 * 3600,
  maxReplans: 5,
  replanDepth: 2,
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
    // Context-window management. The guard is a pure pass-through whenever the
    // input already fits, and proactive compaction is skipped entirely for
    // unknown-window models (reactive self-heal still protects them on a real
    // provider overflow) — so enabling it by default changes no observable
    // output for today's large-window deployments.
    context: { enabled: true, safetyFactor: 0.9, reservedOutputTokens: 4096, maxCompactAttempts: 3, overflowRetry: true },
    timeouts: { perAgent: 120, perPhase: 600, total: 3600 },
    // Mid-execution replanning bounds: maxReplans caps total replan() calls per
    // run; maxDepth caps nesting (1 = the root script may replan, its sub-script
    // may not). Both are run-wide hard stops enforced by the runtime bridge.
    replan: { maxReplans: 2, maxDepth: 1 },
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
  merged.context.safetyFactor = clamp(merged.context.safetyFactor, 0.5, 0.99);
  merged.context.reservedOutputTokens = clamp(merged.context.reservedOutputTokens, 256, CEILINGS.maxTokens);
  merged.context.maxCompactAttempts = clamp(merged.context.maxCompactAttempts, 1, 5);
  merged.replan.maxReplans = clamp(merged.replan.maxReplans, 0, CEILINGS.maxReplans);
  merged.replan.maxDepth = clamp(merged.replan.maxDepth, 0, CEILINGS.replanDepth);
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
