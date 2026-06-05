/**
 * Task decomposition — turns a natural-language prompt into a TaskGraph.
 * The daemon can hand this an LLM-produced graph for validation/normalization;
 * the heuristic decomposer is the deterministic fallback and keeps the engine
 * usable with zero planning-model calls.
 */

const ESTIMATED_TOKENS_PER_AGENT = 6000;

/**
 * Heuristic complexity score from prompt shape.
 * @param {string} prompt
 * @returns {import('./types.js').Complexity}
 */
function inferComplexity(prompt) {
  const text = prompt.toLowerCase();
  if (/\b(entire|all|every|whole|codebase|monorepo|migrate|audit)\b/.test(text) && text.length > 120) return 'massive';
  if (/\b(all|every|each|audit|migrate|refactor|security)\b/.test(text)) return 'high';
  if (text.length > 200 || /\b(and|then|after|verify)\b/.test(text)) return 'medium';
  return 'low';
}

/**
 * @param {string} prompt
 * @param {{complexityHint?: import('./types.js').Complexity, graph?: object}} [options]
 * @returns {import('./types.js').TaskGraph}
 */
export function decompose(prompt, options = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('decompose: prompt is required');

  // An externally produced graph (LLM planner) is validated + normalized.
  if (options.graph) return normalizeGraph(options.graph, text);

  const complexity = options.complexityHint ?? inferComplexity(text);
  const wantsVerification = complexity === 'high' || complexity === 'massive' || /\b(verify|correct|security|audit|critical)\b/i.test(text);
  const wantsMutation = /\b(fix|migrate|refactor|convert|update|rewrite|apply|implement)\b/i.test(text);
  const fanout = complexity !== 'low';

  /** @type {import('./types.js').TaskNode[]} */
  const tasks = [];
  tasks.push({
    id: 'discover',
    description: `Enumerate the concrete targets for: ${text}`,
    type: 'discovery',
    dependencies: [],
    parallelizable: false,
    role: 'discovery-agent',
    expectedOutputSchema: { items: 'array' },
    estimatedTokens: ESTIMATED_TOKENS_PER_AGENT,
  });

  const workType = wantsMutation ? 'mutation' : 'analysis';
  tasks.push({
    id: 'work',
    description: wantsMutation
      ? `Apply the requested change to ONE target: ${text}`
      : `Analyze ONE target for: ${text}`,
    type: workType,
    dependencies: ['discover'],
    parallelizable: fanout,
    fanoutSource: fanout ? 'discover.items' : undefined,
    role: wantsMutation ? 'mutation-agent' : 'analysis-agent',
    expectedOutputSchema: wantsMutation
      ? { changed: 'boolean', summary: 'string' }
      : { findings: 'array', confidence: 'number' },
    estimatedTokens: ESTIMATED_TOKENS_PER_AGENT,
  });

  if (wantsVerification) {
    tasks.push({
      id: 'verify',
      description: 'Adversarially verify the aggregated results: hunt false positives, challenge severity, find gaps.',
      type: 'verification',
      dependencies: ['work'],
      parallelizable: false,
      role: 'false-positive-hunter',
      expectedOutputSchema: { verdicts: 'array', confidence: 'number' },
      estimatedTokens: ESTIMATED_TOKENS_PER_AGENT,
    });
  }

  tasks.push({
    id: 'synthesize',
    description: 'Merge verified results into the final deliverable.',
    type: 'synthesis',
    dependencies: [wantsVerification ? 'verify' : 'work'],
    parallelizable: false,
    role: 'synthesis-agent',
    expectedOutputSchema: { summary: 'string', details: 'array' },
    estimatedTokens: ESTIMATED_TOKENS_PER_AGENT,
  });

  const fanoutFactor = { low: 1, medium: 8, high: 20, massive: 60 }[complexity];
  const verificationAgents = wantsVerification ? 3 : 0;
  const totalAgents = 1 + fanoutFactor + verificationAgents + 1;

  return {
    root: {
      id: 'root',
      prompt: text,
      complexity,
      estimatedTotalAgents: totalAgents,
      estimatedCostUSD: 0, // filled by estimator
      estimatedDurationMinutes: 0, // filled by estimator
    },
    tasks,
  };
}

/** Validate/normalize an externally produced graph. */
function normalizeGraph(graph, prompt) {
  if (!graph || !Array.isArray(graph.tasks) || !graph.tasks.length) {
    throw new Error('decompose: external graph must contain tasks[]');
  }
  const ids = new Set();
  const tasks = graph.tasks.map((t, i) => {
    const id = String(t.id ?? `task-${i}`);
    if (ids.has(id)) throw new Error(`decompose: duplicate task id "${id}"`);
    ids.add(id);
    return {
      id,
      description: String(t.description ?? ''),
      type: ['discovery', 'analysis', 'mutation', 'verification', 'synthesis'].includes(t.type) ? t.type : 'analysis',
      dependencies: Array.isArray(t.dependencies) ? t.dependencies.map(String) : [],
      parallelizable: !!t.parallelizable,
      fanoutSource: t.fanoutSource ? String(t.fanoutSource) : undefined,
      role: String(t.role ?? ''),
      expectedOutputSchema: t.expectedOutputSchema && typeof t.expectedOutputSchema === 'object' ? t.expectedOutputSchema : { result: 'string' },
      estimatedTokens: Number(t.estimatedTokens) || ESTIMATED_TOKENS_PER_AGENT,
    };
  });
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!ids.has(dep)) throw new Error(`decompose: task "${t.id}" depends on unknown "${dep}"`);
    }
  }
  const root = graph.root ?? {};
  return {
    root: {
      id: 'root',
      prompt: String(root.prompt ?? prompt),
      complexity: ['low', 'medium', 'high', 'massive'].includes(root.complexity) ? root.complexity : 'medium',
      estimatedTotalAgents: Number(root.estimatedTotalAgents) || tasks.length,
      estimatedCostUSD: Number(root.estimatedCostUSD) || 0,
      estimatedDurationMinutes: Number(root.estimatedDurationMinutes) || 0,
    },
    tasks,
  };
}
