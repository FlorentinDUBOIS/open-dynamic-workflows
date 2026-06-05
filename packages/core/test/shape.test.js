import { test } from 'node:test';
import assert from 'node:assert/strict';

// P3 scaffolding test: the public surface exists with the contracted names.
// Behavior tests land in P4.

test('odw-core exports the contracted public surface', async () => {
  const core = await import('../src/index.js');
  for (const name of [
    'detectTrigger', 'selectTopology', 'buildRoles', 'defaultStrategy',
    'mergeStrategy', 'decompose', 'generateScript', 'estimate',
    'costFor', 'validateAgainstSchema', 'compileSchema', 'createPlan',
  ]) {
    assert.equal(typeof core[name], 'function', `${name} must be a function`);
  }
  assert.equal(typeof core.PRICING, 'object');
  assert.equal(typeof core.BUILTIN_ROLES, 'object');
});

test('pricing table covers the documented model families', async () => {
  const { PRICING } = await import('../src/pricing.js');
  assert.ok(PRICING['claude-sonnet-4-6']);
  assert.ok(PRICING['gpt-4o-mini']);
  assert.ok(PRICING['default']);
});
