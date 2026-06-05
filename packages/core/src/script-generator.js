/**
 * Orchestration-script generation — compiles a TaskGraph + topology + roles
 * into the JavaScript `async function execute(context)` source executed by the
 * daemon's sandbox. The script is the orchestrator; the LLM is not.
 *
 * Generated scripts use only the sandbox primitives:
 *   agent, parallel, pipeline, verify, loop, phase, log, checkpoint,
 *   budget, args, context.tools — and end with `module.exports = { execute }`.
 */

/**
 * @param {import('./types.js').TaskGraph} taskGraph
 * @param {import('./types.js').Topology} topology
 * @param {import('./types.js').AgentRole[]} roles
 * @param {import('./types.js').ExecutionStrategy} strategy
 * @returns {string}
 */
export function generateScript(taskGraph, topology, roles, strategy) {
  const ordered = topoSort(taskGraph.tasks);
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const header = [
    '/**',
    ' * open-dynamic-workflows orchestration script',
    ` * topology: ${topology}`,
    ` * prompt: ${escapeComment(taskGraph.root.prompt)}`,
    ' */',
    '',
    'async function execute(context) {',
    '  const results = {};',
    '',
  ];

  const body = ordered.map((task) => emitTask(task, roleById, strategy)).join('\n');

  const lastId = ordered[ordered.length - 1]?.id ?? 'synthesize';
  const footer = [
    '',
    `  return results[${JSON.stringify(lastId)}];`,
    '}',
    '',
    'module.exports = { execute };',
    '',
  ];

  return header.join('\n') + body + footer.join('\n');
}

function emitTask(task, roleById, strategy) {
  const role = roleById.get(task.role);
  const phaseName = titleCase(task.id);
  const schema = JSON.stringify(task.expectedOutputSchema ?? { result: 'string' });
  const baseAgentCall = (promptExpr) => {
    const opts = [
      `role: ${JSON.stringify(task.role)}`,
      `prompt: ${promptExpr}`,
      `schema: ${schema}`,
      role?.model ? `model: ${JSON.stringify(role.model)}` : null,
      `maxTokens: ${role?.maxTokens ?? 4000}`,
      `timeout: ${strategy.timeouts.perAgent}`,
    ].filter(Boolean);
    return `agent({ ${opts.join(', ')} })`;
  };

  const lines = [];
  lines.push(`  // ─── ${phaseName} (${task.type}) ───`);
  lines.push(`  phase(${JSON.stringify(phaseName)}, { estimatedAgents: ${task.parallelizable ? 'undefined' : 1} });`);

  if (task.parallelizable && task.fanoutSource) {
    const [sourceTask, sourceField] = task.fanoutSource.split('.');
    const itemsExpr = sourceField
      ? `(results[${JSON.stringify(sourceTask)}] && results[${JSON.stringify(sourceTask)}].${sourceField}) || []`
      : `results[${JSON.stringify(sourceTask)}] || []`;
    const v = sanitizeKey(task.id);
    lines.push(`  {`);
    lines.push(`    const items = ${itemsExpr};`);
    lines.push(`    log('${phaseName}: fanning out over ' + items.length + ' items');`);
    // Per-item resilience: a single flaky agent must not sink the whole batch.
    // Each call catches its own failure into a sentinel; we keep the successes
    // and report how many items dropped (matches how resilient swarms behave).
    lines.push(`    const ${v}_raw = await parallel(`);
    lines.push(`      items.map((item) => () => ${baseAgentCall(
      `${JSON.stringify(task.description + ' Item: ')} + JSON.stringify(item)`
    )}.catch((e) => ({ __odw_failed: true, error: String((e && e.message) || e) }))),`);
    lines.push(`      { maxConcurrency: ${strategy.concurrency.max} }`);
    lines.push(`    );`);
    lines.push(`    const ${v}_ok = ${v}_raw.filter((r) => !(r && r.__odw_failed));`);
    lines.push(`    const ${v}_dropped = ${v}_raw.length - ${v}_ok.length;`);
    lines.push(`    if (${v}_dropped > 0) log('${phaseName}: ' + ${v}_dropped + '/' + ${v}_raw.length + ' items failed and were dropped', 'warn');`);
    lines.push(`    results[${JSON.stringify(task.id)}] = ${v}_ok;`);
    lines.push(`  }`);
  } else if (task.type === 'verification') {
    const upstream = task.dependencies[0] ?? 'work';
    lines.push(`  results[${JSON.stringify(task.id)}] = await verify({`);
    lines.push(`    target: results[${JSON.stringify(upstream)}],`);
    lines.push(`    mode: 'adversarial',`);
    lines.push(`    critics: [`);
    lines.push(`      { role: 'false-positive-hunter', prompt: 'Find false positives in these findings. Assume some are wrong.' },`);
    lines.push(`      { role: 'severity-validator', prompt: 'Challenge the severity ratings of these findings.' },`);
    lines.push(`      { role: 'completeness-checker', prompt: 'What is MISSING from these findings?' },`);
    lines.push(`    ],`);
    lines.push(`    consensusThreshold: 2,`);
    lines.push(`    minConfidence: 0.8,`);
    lines.push(`  });`);
  } else {
    const depsContext = task.dependencies.length
      ? ` + ' Context: ' + JSON.stringify({ ${task.dependencies
          .map((d) => `${sanitizeKey(d)}: results[${JSON.stringify(d)}]`)
          .join(', ')} }).slice(0, 20000)`
      : '';
    lines.push(`  results[${JSON.stringify(task.id)}] = await ${baseAgentCall(
      `${JSON.stringify(task.description)}${depsContext}`
    )};`);
  }

  lines.push(`  await checkpoint({ phase: ${JSON.stringify(task.id)}, data: results[${JSON.stringify(task.id)}] });`);
  lines.push('');
  return lines.join('\n');
}

/** Stable topological sort honoring dependencies. */
function topoSort(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set();
  const out = [];
  const visit = (task, stack = new Set()) => {
    if (visited.has(task.id)) return;
    if (stack.has(task.id)) throw new Error(`script-generator: dependency cycle at "${task.id}"`);
    stack.add(task.id);
    for (const dep of task.dependencies) {
      const depTask = byId.get(dep);
      if (depTask) visit(depTask, stack);
    }
    stack.delete(task.id);
    visited.add(task.id);
    out.push(task);
  };
  for (const task of tasks) visit(task);
  return out;
}

function titleCase(s) {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function sanitizeKey(s) {
  return s.replace(/[^a-zA-Z0-9_$]/g, '_');
}

function escapeComment(s) {
  return String(s).replace(/\*\//g, '*\\/').slice(0, 300);
}
