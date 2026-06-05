/**
 * Trigger detection — decides whether a user prompt asks for a dynamic workflow.
 * Intent-phrase based rather than bare keyword hits, so prompts like
 * "explain my git workflow" do not fire.
 */

const ULTRACODE = /(^|\W)ultracode(\W|$)/i;
const DEEP_RESEARCH = /(^|\s)\/?deep-research(\s|$|:)/i;

// Phrases that signal workflow INTENT, not mere mention.
const WORKFLOW_INTENT = [
  /^\s*workflow\s*:/i,                                  // "workflow: audit ..."
  /\brun\s+(a\s+|the\s+)?workflow\b/i,                  // "run a workflow"
  /\bstart\s+(a\s+|the\s+)?workflow\b/i,
  /\blaunch\s+(a\s+|the\s+)?workflow\b/i,
  /\buse\s+(a\s+|the\s+)?workflow\b/i,
  /\bas\s+a\s+workflow\b/i,
  /\bdynamic\s+workflow\b/i,
  /\bworkflow\s+to\b/i,                                 // "workflow to migrate..."
  /\bcreate\s+(a\s+|the\s+)?workflow\b/i,
];

// Phrases that look like the keyword but are NOT a request to orchestrate.
const NEGATIVE = [
  /\b(my|our|the team's|git|ci|release|approval)\s+workflows?\b/i,
  /\bworkflows?\s+(file|yaml|yml|engine|tab|view)\b/i,
];

/**
 * @param {string} prompt
 * @returns {import('./types.js').TriggerResult}
 */
export function detectTrigger(prompt) {
  const text = String(prompt ?? '');
  const none = { triggered: false, mode: null, cleanPrompt: text.trim() };
  if (!text.trim()) return none;

  if (DEEP_RESEARCH.test(text)) {
    return {
      triggered: true,
      mode: 'deep-research',
      cleanPrompt: text.replace(DEEP_RESEARCH, ' ').replace(/\s+/g, ' ').trim(),
    };
  }

  if (ULTRACODE.test(text)) {
    return {
      triggered: true,
      mode: 'ultracode',
      cleanPrompt: text.replace(/(^|\W)ultracode(\W|$)/gi, '$1$2').replace(/\s+/g, ' ').trim(),
    };
  }

  const positive = WORKFLOW_INTENT.some((re) => re.test(text));
  const negative = NEGATIVE.some((re) => re.test(text)) && !/^\s*workflow\s*:/i.test(text);
  if (positive && !negative) {
    return {
      triggered: true,
      mode: 'workflow',
      cleanPrompt: text.replace(/^\s*workflow\s*:\s*/i, '').trim(),
    };
  }
  return none;
}
