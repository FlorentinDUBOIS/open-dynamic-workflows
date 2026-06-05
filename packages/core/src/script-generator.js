/**
 * Orchestration-script generation — compiles a TaskGraph + topology + roles
 * into the JavaScript `async function execute(context)` source that the
 * daemon's sandbox runs. The script is the orchestrator; the LLM is not.
 *
 * @param {import('./types.js').TaskGraph} taskGraph
 * @param {import('./types.js').Topology} topology
 * @param {import('./types.js').AgentRole[]} roles
 * @param {import('./types.js').ExecutionStrategy} strategy
 * @returns {string} JavaScript source ending in `module.exports = { execute }`
 */
export function generateScript(taskGraph, topology, roles, strategy) {
  void taskGraph; void topology; void roles; void strategy;
  throw new Error('not implemented (P4)');
}
