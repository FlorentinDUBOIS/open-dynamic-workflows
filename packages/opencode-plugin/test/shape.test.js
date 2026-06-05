import { test } from 'node:test';
import assert from 'node:assert/strict';

test('plugin module exports a Plugin-shaped async function', async () => {
  const mod = await import('../src/index.js');
  assert.equal(typeof mod.OdwPlugin, 'function');
  assert.equal(mod.default, mod.OdwPlugin);
});
