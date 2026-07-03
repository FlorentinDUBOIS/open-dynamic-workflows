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
  const cap = taskGraph.root?.agentCap?.maxAgents;
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
    ...agentBudgetPreamble(cap),
  ];

  const body = ordered.map((task, index) => emitTask(task, roleById, strategy, serialAgentsAfter(ordered, index), cap !== undefined)).join('\n');

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

function agentBudgetPreamble(cap) {
  if (cap === undefined) return [];
  return [
    `  const __odw_agentCap = ${Math.floor(Number(cap))};`,
    '  let __odw_agentsStarted = 0;',
    '  function __odw_takeAgentSlots(requested, label, reserve = 0) {',
    '    const wanted = Math.max(0, Math.floor(Number(requested) || 0));',
    '    const reserved = Math.max(0, Math.floor(Number(reserve) || 0));',
    '    const remaining = Math.max(0, __odw_agentCap - __odw_agentsStarted - reserved);',
    '    const slots = Math.min(wanted, remaining);',
    '    __odw_agentsStarted += slots;',
    "    if (slots < wanted) log('agent cap: ' + label + ' limited from ' + wanted + ' to ' + slots + ' agent(s)', 'warn');",
    "    if (wanted > 0 && slots < 1) throw new Error('agent cap exhausted before ' + label);",
    '    return slots;',
    '  }',
    '',
  ];
}

function serialAgentsAfter(tasks, index) {
  return tasks.slice(index + 1).reduce((sum, task) => sum + serialAgentCount(task), 0);
}

function serialAgentCount(task) {
  if (task.type === 'verification') return 3;
  if (task.parallelizable && (task.fanoutSource || task.fanoutItems?.length)) return 0;
  return 1;
}

function emitTask(task, roleById, strategy, serialReserveAfter = 0, agentCapEnabled = false) {
  const role = roleById.get(task.role);
  const phaseName = titleCase(task.id);
  const schema = JSON.stringify(task.expectedOutputSchema ?? { result: 'string' });
  const baseAgentCall = (promptExpr) => {
    const opts = [
      `role: ${JSON.stringify(task.role)}`,
      `prompt: ${promptExpr}`,
      `schema: ${schema}`,
      role?.allowedTools?.length ? `tools: ${JSON.stringify(role.allowedTools)}` : null,
      role?.model ? `model: ${JSON.stringify(role.model)}` : null,
      `maxTokens: ${role?.maxTokens ?? 4000}`,
      `timeout: ${strategy.timeouts.perAgent}`,
    ].filter(Boolean);
    return `agent({ ${opts.join(', ')} })`;
  };

  const lines = [];
  lines.push(`  // ─── ${phaseName} (${task.type}) ───`);
  lines.push(`  phase(${JSON.stringify(phaseName)}, { estimatedAgents: ${task.parallelizable ? 'undefined' : 1} });`);

  if (task.parallelizable && (task.fanoutSource || task.fanoutItems?.length)) {
    const preserveFanoutFailures = !!task.fanoutItems?.length;
    let itemsExpr;
    if (task.fanoutItems?.length) {
      itemsExpr = JSON.stringify(task.fanoutItems);
    } else {
      const [sourceTask, sourceField] = task.fanoutSource.split('.');
      itemsExpr = sourceField
        ? `(results[${JSON.stringify(sourceTask)}] && results[${JSON.stringify(sourceTask)}].${sourceField}) || []`
        : `results[${JSON.stringify(sourceTask)}] || []`;
    }
    const v = sanitizeKey(task.id);
    lines.push(`  {`);
    if (agentCapEnabled) {
      lines.push(`    const ${v}_items_all = ${itemsExpr};`);
      lines.push(`    const ${v}_slots = __odw_takeAgentSlots(${v}_items_all.length, ${JSON.stringify(phaseName)}, ${serialReserveAfter});`);
      lines.push(`    const items = ${v}_items_all.slice(0, ${v}_slots);`);
    } else {
      lines.push(`    const items = ${itemsExpr};`);
    }
    lines.push(`    log('${phaseName}: fanning out over ' + items.length + ' items');`);
    // Per-item resilience: a single flaky agent must not sink the whole batch.
    // Each call catches its own failure into a sentinel; we keep the successes
    // and report how many items dropped (matches how resilient swarms behave).
    lines.push(`    const ${v}_raw = await parallel(`);
    lines.push(`      items.map((item) => () => ${baseAgentCall(
      `${JSON.stringify(task.description + ' Item: ')} + JSON.stringify(item)`
    )}.catch((e) => (${preserveFanoutFailures
      ? '{ __odw_failed: true, label: item && item.label, item, error: String((e && e.message) || e) }'
      : '{ __odw_failed: true, error: String((e && e.message) || e) }'
    }))),`);
    lines.push(`      { maxConcurrency: ${strategy.concurrency.max} }`);
    lines.push(`    );`);
    if (preserveFanoutFailures) {
      lines.push(`    const ${v}_failed = ${v}_raw.filter((r) => r && r.__odw_failed).length;`);
      lines.push(`    if (${v}_failed > 0) log('${phaseName}: ' + ${v}_failed + '/' + ${v}_raw.length + ' explicit fanout items failed and were preserved', 'warn');`);
      lines.push(`    results[${JSON.stringify(task.id)}] = ${v}_raw;`);
    } else {
      lines.push(`    const ${v}_ok = ${v}_raw.filter((r) => !(r && r.__odw_failed));`);
      lines.push(`    const ${v}_dropped = ${v}_raw.length - ${v}_ok.length;`);
      lines.push(`    if (${v}_dropped > 0) log('${phaseName}: ' + ${v}_dropped + '/' + ${v}_raw.length + ' items failed and were dropped', 'warn');`);
      lines.push(`    results[${JSON.stringify(task.id)}] = ${v}_ok;`);
    }
    lines.push(`  }`);
  } else if (task.type === 'verification') {
    const upstream = task.dependencies[0] ?? 'work';
    if (agentCapEnabled) {
      const v = sanitizeKey(task.id);
      lines.push(`  {`);
      lines.push(`    const ${v}_critics = [`);
      lines.push(`      { role: 'false-positive-hunter', tools: ['read_file'], prompt: 'Find false positives in these findings. Assume some are wrong.' },`);
      lines.push(`      { role: 'severity-validator', tools: ['read_file'], prompt: 'Challenge the severity ratings of these findings.' },`);
      lines.push(`      { role: 'completeness-checker', tools: ['read_file', 'search'], prompt: 'What is MISSING from these findings?' },`);
      lines.push(`    ];`);
      lines.push(`    const ${v}_criticSlots = __odw_takeAgentSlots(${v}_critics.length, ${JSON.stringify(`${phaseName} critics`)}, ${serialReserveAfter});`);
      lines.push(`    const ${v}_activeCritics = ${v}_critics.slice(0, ${v}_criticSlots);`);
      lines.push(`    results[${JSON.stringify(task.id)}] = await verify({`);
      lines.push(`      target: results[${JSON.stringify(upstream)}],`);
      lines.push(`      mode: 'adversarial',`);
      lines.push(`      critics: ${v}_activeCritics,`);
      lines.push(`      consensusThreshold: Math.min(2, ${v}_activeCritics.length),`);
      lines.push(`      minConfidence: 0.8,`);
      lines.push(`    });`);
      lines.push(`  }`);
    } else {
      lines.push(`  results[${JSON.stringify(task.id)}] = await verify({`);
      lines.push(`    target: results[${JSON.stringify(upstream)}],`);
      lines.push(`    mode: 'adversarial',`);
      lines.push(`    critics: [`);
      lines.push(`      { role: 'false-positive-hunter', tools: ['read_file'], prompt: 'Find false positives in these findings. Assume some are wrong.' },`);
      lines.push(`      { role: 'severity-validator', tools: ['read_file'], prompt: 'Challenge the severity ratings of these findings.' },`);
      lines.push(`      { role: 'completeness-checker', tools: ['read_file', 'search'], prompt: 'What is MISSING from these findings?' },`);
      lines.push(`    ],`);
      lines.push(`    consensusThreshold: 2,`);
      lines.push(`    minConfidence: 0.8,`);
      lines.push(`  });`);
    }
  } else {
    // Inject upstream results as context, compacted to a char budget by DROPPING
    // WHOLE elements (structure-preserving) rather than the old blind
    // .slice(0, 20000) that could cut mid-JSON. compact() is identity when the
    // serialized deps already fit 20000 chars, so small payloads are unchanged.
    const depsContext = task.dependencies.length
      ? ` + ' Context: ' + JSON.stringify(await compact({ ${task.dependencies
          .map((d) => `${sanitizeKey(d)}: results[${JSON.stringify(d)}]`)
          .join(', ')} }, { maxChars: 20000 }))`
      : '';
    const call = `${baseAgentCall(`${JSON.stringify(task.description)}${depsContext}`)}`;
    if (agentCapEnabled) {
      lines.push(`  __odw_takeAgentSlots(1, ${JSON.stringify(phaseName)}, ${serialReserveAfter});`);
    }
    if (task.type === 'synthesis') {
      // The terminal synthesis step must never hard-fail the whole run just
      // because the model returned prose instead of JSON. Degrade to a
      // best-effort result built from the upstream data so the workflow
      // always completes with something useful.
      const upstream = task.dependencies[0];
      const fallbackData = upstream ? `results[${JSON.stringify(upstream)}]` : 'null';
      lines.push(`  try {`);
      lines.push(`    results[${JSON.stringify(task.id)}] = await ${call};`);
      lines.push(`  } catch (e) {`);
      lines.push(`    if (e && (e.code === 'aborted' || e.code === 'paused')) throw e;`);
      lines.push(`    log('synthesis could not produce structured output (' + e.message + ') — returning partial results', 'warn');`);
      lines.push(`    results[${JSON.stringify(task.id)}] = { summary: 'Workflow completed with partial results; the final synthesis step could not be formatted by the model.', partial: ${fallbackData}, synthesisError: String(e.message) };`);
      lines.push(`  }`);
    } else {
      lines.push(`  results[${JSON.stringify(task.id)}] = await ${call};`);
    }
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
