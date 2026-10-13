import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChildLedger, sweepStaleChildren } from '../src/stale-sweep.js';
import { createFakeHost } from './fake-host.js';

const lockOptions = () => ({ root: `/tmp/odw-sweep-${process.pid}-${Math.random().toString(16).slice(2)}` });

test('stale sweep removes only recorded ODW children after owning their parent lock', async () => {
  const fake = createFakeHost();
  const ledger = createChildLedger(fake.ctx.storage);
  const child = await fake.ctx.session.create({ parentID: 'parent' });
  const other = await fake.ctx.session.create({ parentID: 'parent' });
  await ledger.add('parent', child.id);
  const result = await sweepStaleChildren(fake.ctx, ledger, { lockOptions: lockOptions() });
  assert.deepEqual(result.deleted, [child.id]);
  assert.deepEqual(fake.calls.remove, [child.id]);
  assert.ok(fake.sessions.has(other.id), 'sessions the plugin never recorded are untouched');
  assert.deepEqual(await ledger.entries(), [], 'a removed child leaves the ledger');
});

test('stale sweep skips a parent that another process owns', async () => {
  const fake = createFakeHost();
  const ledger = createChildLedger(fake.ctx.storage);
  const child = await fake.ctx.session.create({ parentID: 'busy' });
  await ledger.add('busy', child.id);
  const options = lockOptions();
  const { acquireSessionLock } = await import('../src/session-lock.js');
  const held = await acquireSessionLock('busy', options);
  try {
    const result = await sweepStaleChildren(fake.ctx, ledger, { lockOptions: options });
    assert.deepEqual(result.contended, ['busy']);
    assert.deepEqual(fake.calls.remove, []);
    assert.equal((await ledger.entries()).length, 1);
  } finally {
    await held.release();
  }
});

test('stale sweep treats an already-deleted child as removed and keeps a ledger entry it cannot remove', async () => {
  const fake = createFakeHost();
  const ledger = createChildLedger(fake.ctx.storage);
  await ledger.add('parent', 'ses_gone');
  const stuck = await fake.ctx.session.create({ parentID: 'parent' });
  await ledger.add('parent', stuck.id);
  fake.ctx.session.remove = async () => { throw new Error('remove failed'); };
  const result = await sweepStaleChildren(fake.ctx, ledger, { lockOptions: lockOptions() });
  assert.deepEqual(result.deleted, ['ses_gone']);
  assert.deepEqual(result.failed, [stuck.id]);
  assert.deepEqual((await ledger.entries()).map((entry) => entry.childID), [stuck.id]);
});

test('child ledger pages through every entry', async () => {
  const fake = createFakeHost();
  const ledger = createChildLedger(fake.ctx.storage);
  for (let index = 0; index < 250; index++) await ledger.add(`parent-${index % 3}`, `ses_${String(index).padStart(4, '0')}`);
  assert.equal((await ledger.entries()).length, 250);
});
