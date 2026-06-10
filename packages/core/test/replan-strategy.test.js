import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultStrategy, mergeStrategy } from '../src/strategy.js';

// ── replan strategy block ─────────────────────────────────────────────────────

test('replan: defaults present (maxReplans 2, maxDepth 1)', () => {
  assert.deepEqual(defaultStrategy().replan, { maxReplans: 2, maxDepth: 1 });
  assert.deepEqual(mergeStrategy().replan, { maxReplans: 2, maxDepth: 1 }, 'no overrides → defaults survive the merge');
});

test('replan: ceilings clamp — maxReplans > 5 → 5, maxDepth > 2 → 2', () => {
  const s = mergeStrategy({ replan: { maxReplans: 99, maxDepth: 99 } });
  assert.equal(s.replan.maxReplans, 5);
  assert.equal(s.replan.maxDepth, 2);
});

test('replan: floor clamps at 0 and non-numeric input falls to the floor', () => {
  const s = mergeStrategy({ replan: { maxReplans: -3, maxDepth: 'lots' } });
  assert.equal(s.replan.maxReplans, 0, 'negative clamps to 0 (replan disabled)');
  assert.equal(s.replan.maxDepth, 0, 'non-finite clamps to the floor');
});

test('replan: overrides merge deep — untouched fields keep their defaults', () => {
  const s = mergeStrategy({ replan: { maxReplans: 1 }, budget: { maxTokens: 5000 } });
  assert.equal(s.replan.maxReplans, 1);
  assert.equal(s.replan.maxDepth, 1, 'maxDepth default survives a partial replan override');
  assert.equal(s.budget.maxTokens, 5000, 'sibling overrides unaffected');
});
