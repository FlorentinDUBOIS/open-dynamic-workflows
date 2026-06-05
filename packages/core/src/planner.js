import { randomUUID } from 'node:crypto';
import { decompose } from './decompose.js';
import { selectTopology } from './topology.js';
import { buildRoles } from './roles.js';
import { mergeStrategy } from './strategy.js';
import { generateScript } from './script-generator.js';
import { estimate } from './estimator.js';

/**
 * The 5-phase planning pipeline:
 *   1 decompose → 2 selectTopology → 3 buildRoles → 4 mergeStrategy → 5 estimate+script
 * Produces the full Plan artifact.
 *
 * @param {string} prompt
 * @param {{strategy?: object,
 *          llmDecompose?: (prompt: string) => Promise<object>,
 *          complexityHint?: import('./types.js').Complexity}} [options]
 * @returns {Promise<import('./types.js').Plan>}
 */
export async function createPlan(prompt, options = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('createPlan: prompt is required');

  // Phase 1 — task decomposition (LLM planner when available, heuristic otherwise)
  let taskGraph;
  if (options.llmDecompose) {
    try {
      const graph = await options.llmDecompose(text);
      taskGraph = decompose(text, { graph });
    } catch {
      taskGraph = decompose(text, { complexityHint: options.complexityHint });
    }
  } else {
    taskGraph = decompose(text, { complexityHint: options.complexityHint });
  }

  // Phase 2 — topology selection (simplest that fits)
  const topology = selectTopology(taskGraph);

  // Phase 3 — role definition (hyper-scoped specialists)
  const roles = buildRoles(taskGraph);

  // Phase 4 — execution strategy (hard limits)
  const strategy = mergeStrategy(options.strategy);

  // Phase 5 — estimate + compiled orchestration script
  const est = estimate(taskGraph, strategy);
  taskGraph.root.estimatedCostUSD = est.costUSD;
  taskGraph.root.estimatedDurationMinutes = est.minutes;
  const script = generateScript(taskGraph, topology, roles, strategy);

  return {
    planId: `plan_${randomUUID().slice(0, 12)}`,
    prompt: text,
    taskGraph,
    topology,
    roles,
    strategy,
    script,
    estimate: est,
    createdAt: new Date().toISOString(),
  };
}
