import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSessionLock } from '../src/session-lock.js';

test('same session contends while independent sessions overlap and release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'odw-lock-'));
  try {
    const first = await acquireSessionLock('session-one', { root });
    assert.ok(first);
    assert.equal(await acquireSessionLock('session-one', { root }), null);
    const other = await acquireSessionLock('session-two', { root });
    assert.ok(other);
    await first.release();
    const reacquired = await acquireSessionLock('session-one', { root });
    assert.ok(reacquired);
    await Promise.all([other.release(), reacquired.release()]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects session ids that can escape the lock root', async () => {
  await assert.rejects(() => acquireSessionLock('../escape', { root: '/tmp' }), /invalid ODW session id/);
});

test('fails explicitly when flock is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'odw-lock-'));
  try {
    await assert.rejects(
      () => acquireSessionLock('session-one', { root, flock: 'missing-odw-flock' }),
      /spawn missing-odw-flock ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
