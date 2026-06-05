/**
 * Built-in specialist roles. Each is hyper-scoped: no role knows the grand plan.
 * @type {Record<string, import('./types.js').AgentRole>}
 */
export const BUILTIN_ROLES = {};

/**
 * Build the role set for a plan: built-ins referenced by the task graph
 * plus generated roles for novel task types.
 *
 * @param {import('./types.js').TaskGraph} taskGraph
 * @returns {import('./types.js').AgentRole[]}
 */
export function buildRoles(taskGraph) {
  void taskGraph;
  throw new Error('not implemented (P4)');
}
