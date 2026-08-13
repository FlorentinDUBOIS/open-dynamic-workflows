export const RECONCILIATION_VERDICTS = Object.freeze(['replay', 'skip']);

export function reconciliationVerdict(value) {
  const verdict = String(value?.verdict ?? '');
  const evidence = String(value?.evidence ?? '').trim();
  if (!RECONCILIATION_VERDICTS.includes(verdict)) {
    throw new Error('reconciliation verdict must be replay or skip');
  }
  if (!evidence) throw new Error('reconciliation evidence is required');
  return { verdict, evidence };
}

export async function reconcileInterruptedNode(input, reconstruct) {
  const verdict = reconciliationVerdict(input);
  if (verdict.verdict === 'replay') return { ...verdict, output: undefined };
  if (typeof reconstruct !== 'function') throw new Error('skip reconciliation requires reconstruction');
  const output = await reconstruct({ evidence: verdict.evidence, schema: input.schema, observation: input.observation });
  if (typeof input.validate === 'function' && !input.validate(output)) {
    throw new Error('reconstructed output does not match node schema');
  }
  return { ...verdict, output };
}
