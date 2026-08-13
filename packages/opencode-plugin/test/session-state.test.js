import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionState } from '../src/session-state.js';

test('isolates ultracode and workflows by parent session', async () => {
  const state = createSessionState();
  state.setUltracode('one', true);
  state.addWorkflow('one', { id: 'wf-one' });
  state.addWorkflow('two', { id: 'wf-two' });
  assert.equal(state.ultracode('one'), true);
  assert.equal(state.ultracode('two'), false);
  assert.deepEqual(state.workflows('one').map((item) => item.id), ['wf-one']);
  await state.dispose();
});

test('guards children and consumes one-shot fallback markers', async () => {
  const state = createSessionState();
  state.registerChild('child');
  assert.equal(state.isChild('child'), true);
  state.markFallback('message');
  assert.equal(state.consumeFallback('message'), true);
  assert.equal(state.consumeFallback('message'), false);
  state.unregisterChild('child');
  assert.equal(state.isChild('child'), false);
  await state.dispose();
});
