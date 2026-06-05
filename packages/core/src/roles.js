/**
 * Built-in specialist roles. Each is hyper-scoped: rigid system prompt,
 * minimal tools, structured output. No role knows the grand plan.
 * @type {Record<string, import('./types.js').AgentRole>}
 */
export const BUILTIN_ROLES = {
  'discovery-agent': {
    id: 'discovery-agent',
    title: 'Discovery Agent',
    systemPrompt:
      'You enumerate targets for a larger task you cannot see. Return ONLY JSON matching the requested schema: a list of concrete items (files, endpoints, modules, questions). Do not explain. Do not solve.',
    allowedTools: ['read_file', 'search', 'glob'],
    temperature: 0,
    maxTokens: 4000,
    outputSchema: { items: 'array' },
  },
  'analysis-agent': {
    id: 'analysis-agent',
    title: 'Analysis Agent',
    systemPrompt:
      'You analyze EXACTLY ONE item handed to you. Be thorough but concise. Return ONLY JSON matching the requested schema. Never invent facts; mark uncertainty with a confidence number between 0 and 1.',
    allowedTools: ['read_file', 'search'],
    temperature: 0,
    maxTokens: 4000,
    outputSchema: { findings: 'array', confidence: 'number' },
  },
  'mutation-agent': {
    id: 'mutation-agent',
    title: 'Mutation Agent',
    systemPrompt:
      'You apply EXACTLY ONE focused change. Describe the change as structured JSON output matching the requested schema. Make the smallest change that satisfies the instruction.',
    allowedTools: ['read_file', 'write_file'],
    temperature: 0,
    maxTokens: 8000,
    outputSchema: { changed: 'boolean', summary: 'string' },
  },
  'false-positive-hunter': {
    id: 'false-positive-hunter',
    title: 'False-Positive Hunter',
    systemPrompt:
      'You are a skeptic reviewing findings produced by another agent. Assume a meaningful fraction are wrong. For each finding decide keep/reject with a reason. Return ONLY JSON matching the requested schema.',
    allowedTools: ['read_file'],
    temperature: 0.1,
    maxTokens: 4000,
    outputSchema: { verdicts: 'array', confidence: 'number' },
  },
  'severity-validator': {
    id: 'severity-validator',
    title: 'Severity Validator',
    systemPrompt:
      'You challenge severity/priority ratings on findings. Downgrade anything not provably impactful; upgrade anything understated, with reasons. Return ONLY JSON matching the requested schema.',
    allowedTools: ['read_file'],
    temperature: 0.1,
    maxTokens: 4000,
    outputSchema: { verdicts: 'array', confidence: 'number' },
  },
  'completeness-checker': {
    id: 'completeness-checker',
    title: 'Completeness Checker',
    systemPrompt:
      'You look for what is MISSING from a set of findings: cases not covered, items skipped, questions unasked. Return ONLY JSON matching the requested schema.',
    allowedTools: ['read_file', 'search'],
    temperature: 0.2,
    maxTokens: 4000,
    outputSchema: { missing: 'array', confidence: 'number' },
  },
  'synthesis-agent': {
    id: 'synthesis-agent',
    title: 'Synthesis Agent',
    systemPrompt:
      'You merge verified results into one final deliverable. Cite which inputs support each conclusion. Return ONLY JSON matching the requested schema.',
    allowedTools: [],
    temperature: 0.2,
    maxTokens: 8000,
    outputSchema: { summary: 'string', details: 'array' },
  },
};

/**
 * Build the role set for a plan: every role referenced by the task graph,
 * resolved from built-ins or generated generically by task type.
 *
 * @param {import('./types.js').TaskGraph} taskGraph
 * @returns {import('./types.js').AgentRole[]}
 */
export function buildRoles(taskGraph) {
  const FALLBACK_BY_TYPE = {
    discovery: 'discovery-agent',
    analysis: 'analysis-agent',
    mutation: 'mutation-agent',
    verification: 'false-positive-hunter',
    synthesis: 'synthesis-agent',
  };
  const roles = new Map();
  for (const task of taskGraph?.tasks ?? []) {
    const roleId = task.role || FALLBACK_BY_TYPE[task.type] || 'analysis-agent';
    if (roles.has(roleId)) continue;
    const builtin = BUILTIN_ROLES[roleId];
    if (builtin) {
      roles.set(roleId, { ...builtin, outputSchema: task.expectedOutputSchema ?? builtin.outputSchema });
    } else {
      roles.set(roleId, {
        id: roleId,
        title: roleId.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        systemPrompt: `You perform one narrow task: ${task.description}. Return ONLY JSON matching the requested schema. Do not explain.`,
        allowedTools: task.type === 'mutation' ? ['read_file', 'write_file'] : ['read_file', 'search'],
        temperature: 0,
        maxTokens: 4000,
        outputSchema: task.expectedOutputSchema ?? { result: 'string' },
      });
    }
  }
  return [...roles.values()];
}
