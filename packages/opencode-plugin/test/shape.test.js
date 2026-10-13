import { test } from 'node:test';
import assert from 'node:assert/strict';

test('legacy daemon plugin module exports a Plugin-shaped async function', async () => {
  const mod = await import('../src/index.js');
  assert.equal(typeof mod.OdwPlugin, 'function');
  assert.equal(mod.default, mod.OdwPlugin);
});

test('server bundle entry is a single default OpenCode 2 plugin definition', async () => {
  const mod = await import('../src/server-entry.js');
  assert.deepEqual(Object.keys(mod), ['default']);
  assert.equal(mod.default.id, 'open-dynamic-workflows');
  assert.equal(typeof mod.default.setup, 'function');
});
