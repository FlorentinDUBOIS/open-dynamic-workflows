/**
 * Daemon configuration: ~/.odw/config.json with env-var fallbacks.
 * API keys are NEVER logged and never serialized into state rows.
 */

/**
 * @typedef {object} DaemonConfig
 * @property {{port: number, maxConcurrency: number, checkpointInterval: number, logLevel: string}} daemon
 * @property {Record<string, string>} apiKeys
 * @property {{planning: string, default: string, fallback: string}} models
 * @property {{defaultMaxTokens: number, defaultMaxCostUSD: number, alertAtPercent: number}} budget
 * @property {{requireApprovalFor: string[], autoApproveReadOnly: boolean, dryRun: boolean, blockedCommands: string[]}} safety
 * @property {{autoCreateBranch: boolean, branchPrefix: string, commitCheckpoints: boolean}} git
 */

/** @returns {string} the odw home directory (ODW_HOME override for tests/containers) */
export function odwHome() {
  throw new Error('not implemented (P4)');
}

/** @returns {DaemonConfig} merged defaults ← file ← env */
export function loadConfig() {
  throw new Error('not implemented (P4)');
}

/**
 * Resolve an API key for a provider: config.apiKeys[provider] → env.
 * @param {DaemonConfig} config
 * @param {string} provider
 * @returns {string|undefined}
 */
export function apiKeyFor(config, provider) {
  void config; void provider;
  throw new Error('not implemented (P4)');
}
