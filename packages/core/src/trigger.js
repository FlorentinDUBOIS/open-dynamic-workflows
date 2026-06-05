/**
 * Trigger detection — decides whether a user prompt asks for a dynamic workflow.
 * Intent-phrase based (not bare keyword hits) per Apex P1 finding.
 *
 * @param {string} prompt
 * @returns {import('./types.js').TriggerResult}
 */
export function detectTrigger(prompt) {
  void prompt;
  throw new Error('not implemented (P4)');
}
