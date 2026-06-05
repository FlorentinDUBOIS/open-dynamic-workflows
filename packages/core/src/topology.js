/**
 * Topology selection — maps a TaskGraph to the SIMPLEST topology that fits.
 * Preference order (simplest first): mapreduce, pipeline, adversarial,
 * consensus, treesearch, hybrid. Don't over-engineer.
 */

/**
 * @param {import('./types.js').TaskGraph} taskGraph
 * @returns {import('./types.js').Topology}
 */
export function selectTopology(taskGraph) {
  const tasks = taskGraph?.tasks ?? [];
  if (!tasks.length) return 'pipeline';

  const types = new Set(tasks.map((t) => t.type));
  const hasVerification = types.has('verification');
  const hasMutation = types.has('mutation');
  const fanout = tasks.some((t) => t.parallelizable && t.fanoutSource);
  const sequentialChain = tasks.every(
    (t, i) => i === 0 || t.dependencies.includes(tasks[i - 1].id)
  );
  const phaseCount = countPhases(tasks);

  // Exploration shape: many alternative branches scored against each other.
  const branching = tasks.filter((t) => t.type === 'analysis' && !t.parallelizable).length >= 4 && !fanout;
  if (branching && hasVerification) return 'treesearch';

  // Multiple independent evaluators converging on one answer → consensus.
  const evaluators = tasks.filter((t) => t.type === 'verification').length;
  if (evaluators >= 3 && !hasMutation && !fanout) return 'consensus';

  if (fanout && hasVerification && phaseCount > 3) return 'hybrid';
  if (fanout) return 'mapreduce';
  if (hasMutation && hasVerification) return 'adversarial';
  if (sequentialChain) return 'pipeline';
  return 'hybrid';
}

function countPhases(tasks) {
  // Longest dependency chain length approximates phase count.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map();
  const depth = (task, seen = new Set()) => {
    if (memo.has(task.id)) return memo.get(task.id);
    if (seen.has(task.id)) return 1; // cycle guard
    seen.add(task.id);
    const d = 1 + Math.max(0, ...task.dependencies.map((id) => (byId.has(id) ? depth(byId.get(id), seen) : 0)));
    memo.set(task.id, d);
    return d;
  };
  return Math.max(0, ...tasks.map((t) => depth(t)));
}
