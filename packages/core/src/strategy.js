/**
 * Execution strategy defaults + merging of user overrides.
 */

/**
 * @returns {import('./types.js').ExecutionStrategy}
 */
export function defaultStrategy() {
  throw new Error('not implemented (P4)');
}

/**
 * Deep-merge user overrides over defaults (hard limits clamped).
 * @param {Partial<import('./types.js').ExecutionStrategy>} [overrides]
 * @returns {import('./types.js').ExecutionStrategy}
 */
export function mergeStrategy(overrides) {
  void overrides;
  throw new Error('not implemented (P4)');
}
