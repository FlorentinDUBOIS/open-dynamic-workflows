export const DEFAULT_PROFILE = 'balanced';
export const PROFILE_NAMES = Object.freeze(['balanced', 'quality', 'economy']);

const SOL = Object.freeze({ model: 'openai/gpt-5.6-sol', variant: 'max' });
const LUNA = Object.freeze({ model: 'openai/gpt-5.6-luna' });
const AUTHORITY_ROLES = new Set(['mutation', 'verification', 'synthesis', 'reconstruction']);
const PLANNING_ROLES = new Set(['planner', 'replan', 'repair']);

export function routeModel(profile = DEFAULT_PROFILE, role) {
  if (!PROFILE_NAMES.includes(profile)) throw new Error(`unknown ODW profile: ${profile}`);
  const normalizedRole = normalizeRole(role);
  if (profile === 'quality') return SOL;
  if (AUTHORITY_ROLES.has(normalizedRole)) return SOL;
  if (profile === 'balanced' && PLANNING_ROLES.has(normalizedRole)) return SOL;
  return LUNA;
}

function normalizeRole(role) {
  const value = String(role ?? 'analysis');
  for (const type of ['mutation', 'verification', 'synthesis', 'reconstruction', 'planner', 'replan', 'repair', 'discovery', 'analysis']) {
    if (value === type || value.startsWith(`${type}-`)) return type;
  }
  if (value.includes('verify') || value.includes('hunter') || value.includes('challenger')) return 'verification';
  return value;
}

export function parseOdwArguments(value) {
  const input = String(value ?? '').trim();
  let profile = DEFAULT_PROFILE;
  let task = input;
  const matches = [...input.matchAll(/(?:^|\s)--profile(?:=|\s+)([^\s]+)/g)];
  if (matches.length > 1) throw new Error('ODW profile may be specified only once');
  if (matches.length === 1) {
    profile = matches[0][1];
    if (!PROFILE_NAMES.includes(profile)) {
      throw new Error(`ODW profile must be one of: ${PROFILE_NAMES.join(', ')}`);
    }
    task = `${input.slice(0, matches[0].index)} ${input.slice(matches[0].index + matches[0][0].length)}`.trim();
  }
  if (!task) throw new Error('ODW task is required');
  return { profile, task };
}
