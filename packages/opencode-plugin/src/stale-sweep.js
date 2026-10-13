import { acquireSessionLock } from './session-lock.js';

const PREFIX = 'child/';
const PAGE = 100;

/**
 * Durable ledger of the child sessions this plugin created, kept in the plugin's own
 * storage. OpenCode 2 gives a plugin no way to enumerate sessions (`ctx.session` has
 * no `list`), so the sweep works from this record instead of scanning metadata. One
 * key per child makes every write independent: no read-modify-write races between the
 * parallel children of one workflow or between OpenCode processes.
 */
export function createChildLedger(storage) {
  return {
    add: (parentID, childID) => storage.set(`${PREFIX}${childID}`, { parentID, createdAt: Date.now() }),
    forget: (childID) => storage.remove(`${PREFIX}${childID}`),
    async entries() {
      const entries = [];
      for (let after; ;) {
        const page = await storage.scan({ prefix: PREFIX, after, limit: PAGE });
        for (const entry of page.entries) {
          if (typeof entry.value?.parentID === 'string') entries.push({ childID: entry.key.slice(PREFIX.length), parentID: entry.value.parentID });
        }
        if (!page.next || !page.entries.length) return entries;
        after = page.next;
      }
    },
  };
}

/** Deletes the recorded children of parents that no live OpenCode process owns. */
export async function sweepStaleChildren(host, ledger, options = {}) {
  const byParent = new Map();
  for (const { childID, parentID } of await ledger.entries()) {
    const children = byParent.get(parentID) ?? [];
    children.push(childID);
    byParent.set(parentID, children);
  }
  const result = { deleted: [], contended: [], failed: [] };
  for (const [parentID, children] of byParent) {
    const lock = await acquireSessionLock(parentID, options.lockOptions);
    if (!lock) {
      result.contended.push(parentID);
      continue;
    }
    try {
      for (const childID of children) {
        if (await removeSession(host, childID)) {
          await ledger.forget(childID);
          result.deleted.push(childID);
        } else {
          result.failed.push(childID);
        }
      }
    } finally {
      await lock.release();
    }
  }
  return result;
}

// A session that is already gone counts as removed; any other failure keeps the ledger entry for the next sweep.
async function removeSession(host, sessionID) {
  try {
    await host.session.remove({ sessionID });
    return true;
  } catch {
    try {
      await host.session.get({ sessionID });
      return false;
    } catch {
      return true;
    }
  }
}
