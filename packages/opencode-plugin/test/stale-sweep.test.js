import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepStaleChildren } from '../src/stale-sweep.js';

test('stale sweep deletes only ODW children after owning their parent lock', async () => {
  const deleted = [];
  const client = { session: {
    list: async () => ([
      { id: 'odw-child', parentID: 'parent', metadata: { odw: true } },
      { id: 'normal-child', parentID: 'parent', metadata: {} },
    ]),
    delete: async ({ path }) => { deleted.push(path.id); },
  } };
  const result = await sweepStaleChildren(client, {
    lockOptions: { root: `/tmp/odw-sweep-${process.pid}-${Math.random().toString(16).slice(2)}` },
  });
  assert.deepEqual(result.deleted, ['odw-child']);
  assert.deepEqual(deleted, ['odw-child']);
});
