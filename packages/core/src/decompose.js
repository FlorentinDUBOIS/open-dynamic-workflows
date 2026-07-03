/**
 * Task decomposition — turns a natural-language prompt into a TaskGraph.
 * The daemon can hand this an LLM-produced graph for validation/normalization;
 * the heuristic decomposer is the deterministic fallback and keeps the engine
 * usable with zero planning-model calls.
 */

const ESTIMATED_TOKENS_PER_AGENT = 6000;
const MAX_EXPLICIT_FANOUT = 100;

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

  const explicitFanout = parseExplicitFanout(text);
  const complexity = options.complexityHint ?? (explicitFanout ? complexityForFanout(explicitFanout.count) : inferComplexity(text));
  // Verification (the adversarial safety net) fires for high-stakes work AND for
  // any scrutiny-class prompt — review, audit, find bugs, check, inspect — so the
  // most natural phrasings get a verification pass instead of a silent plain run.
  const scrutinyClass = /\b(verif|correct|secur|audit|critical|review|bug|vulnerab|inspect|check|quality|flaw|issue|lint)\w*/i.test(text);
  const wantsVerification =
    scrutinyClass ||
    (!explicitFanout && (complexity === 'high' || complexity === 'massive'));
  const wantsMutation = /\b(fix|migrate|refactor|convert|update|rewrite|apply|implement)\b/i.test(text);
  const fanout = complexity !== 'low';

  /** @type {import('./types.js').TaskNode[]} */
  const tasks = [];
  if (explicitFanout) {
    const workType = wantsMutation ? 'mutation' : 'analysis';
    tasks.push({
      id: 'work',
      description: wantsMutation
        ? `Apply the requested change with ONE requested agent for: ${text}`
        : `Run ONE requested agent for: ${text}`,
      type: workType,
      dependencies: [],
      parallelizable: true,
      fanoutItems: explicitFanout.items,
      role: wantsMutation ? 'mutation-agent' : 'analysis-agent',
      expectedOutputSchema: wantsMutation
        ? { label: 'string', changed: 'boolean', summary: 'string' }
        : { label: 'string', result: 'string', confidence: 'number' },
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
      description: 'Merge aggregated results into the final deliverable.',
      type: 'synthesis',
      dependencies: [wantsVerification ? 'verify' : 'work'],
      parallelizable: false,
      role: 'synthesis-agent',
      expectedOutputSchema: { summary: 'string', details: 'array' },
      estimatedTokens: ESTIMATED_TOKENS_PER_AGENT,
    });

    const verificationAgents = wantsVerification ? 3 : 0;
    return {
      root: {
        id: 'root',
        prompt: text,
        complexity,
        explicitFanout: {
          count: explicitFanout.count,
          labels: explicitFanout.items.map((item) => item.label),
        },
        estimatedTotalAgents: explicitFanout.count + verificationAgents + 1,
        estimatedCostUSD: 0,
        estimatedDurationMinutes: 0,
      },
      tasks,
    };
  }

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

function complexityForFanout(count) {
  if (count >= 40) return 'massive';
  if (count >= 12) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}

function parseExplicitFanout(prompt) {
  const text = String(prompt ?? '');
  const countMatch =
    text.match(/\b(?:split\s+into|spawn|spin(?:\s+up)?|fan\s+out|run|launch|create|use)\s+(?:exactly\s+)?(\d{1,3})\s+(?:independent\s+)?(?:micro[-\s]?)?(?:agents?|workers?|subagents?)\b/i) ||
    text.match(/\bexactly\s+(\d{1,3})\s+(?:independent\s+)?(?:micro[-\s]?)?(?:agents?|workers?|subagents?)\b/i) ||
    text.match(/\b(\d{1,3})\s+(?:independent\s+)?(?:micro[-\s]?)?(?:agents?|workers?|subagents?)\b/i);
  const range = text.match(/\blabel(?:ed|led)?\s+([a-z])\s+(?:through|to|-)\s+([a-z])\b/i);
  const rangeLabels = range ? letterRange(range[1], range[2]) : [];
  const count = countMatch ? Number(countMatch[1]) : rangeLabels.length;
  if (!Number.isInteger(count) || count < 2 || count > MAX_EXPLICIT_FANOUT) return null;

  const labels = rangeLabels.length === count
    ? rangeLabels
    : defaultLabels(count);
  return {
    count,
    items: labels.map((label, index) => ({
      label,
      index: index + 1,
      instruction: `agent ${label}`,
    })),
  };
}

function letterRange(start, end) {
  const a = String(start).toUpperCase().charCodeAt(0);
  const b = String(end).toUpperCase().charCodeAt(0);
  if (a < 65 || a > 90 || b < 65 || b > 90 || b < a) return [];
  return Array.from({ length: b - a + 1 }, (_, i) => String.fromCharCode(a + i));
}

function defaultLabels(count) {
  return Array.from({ length: count }, (_, i) => (
    i < 26 ? String.fromCharCode(65 + i) : `agent-${i + 1}`
  ));
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
