import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRemoteTrigger } from '../src/remote.js';

test('remote trigger recognizes workflow modes and rejects incidental mentions', () => {
  assert.deepEqual(detectRemoteTrigger('workflow: audit auth'), { mode: 'workflow', prompt: 'audit auth' });
  assert.equal(detectRemoteTrigger('ultracode inspect this').mode, 'ultracode');
  assert.equal(detectRemoteTrigger('/deep-research: storage').mode, 'deep-research');
  assert.equal(detectRemoteTrigger('describe our CI workflows'), null);
});
