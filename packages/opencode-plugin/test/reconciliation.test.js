import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileInterruptedNode } from '../src/reconciliation.js';

test('replay requires evidence and never reconstructs', async () => {
  let called = false;
  const result = await reconcileInterruptedNode({ verdict: 'replay', evidence: 'remote ref is absent' }, async () => { called = true; });
  assert.equal(called, false);
  assert.equal(result.verdict, 'replay');
  await assert.rejects(() => reconcileInterruptedNode({ verdict: 'replay', evidence: '' }), /evidence/);
});

test('skip reconstructs and validates the lost output', async () => {
  const result = await reconcileInterruptedNode(
    { verdict: 'skip', evidence: 'file contains expected bytes', schema: {}, validate: (value) => value.applied === true },
    async () => ({ applied: true }),
  );
  assert.deepEqual(result.output, { applied: true });
  await assert.rejects(
    () => reconcileInterruptedNode({ verdict: 'skip', evidence: 'observed', validate: () => false }, async () => ({})),
    /does not match/,
  );
});
