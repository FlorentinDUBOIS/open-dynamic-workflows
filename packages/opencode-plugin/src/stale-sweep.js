import { acquireSessionLock } from './session-lock.js';

export async function sweepStaleChildren(client, options = {}) {
  const response = await client.session.list();
  const sessions = response?.data ?? response ?? [];
  const byParent = new Map();
  for (const session of sessions) {
    if (session?.metadata?.odw !== true || !session.parentID) continue;
    const children = byParent.get(session.parentID) ?? [];
    children.push(session.id);
    byParent.set(session.parentID, children);
  }
  const result = { deleted: [], contended: [] };
  for (const [parentID, children] of byParent) {
    const lock = await acquireSessionLock(parentID, options.lockOptions);
    if (!lock) {
      result.contended.push(parentID);
      continue;
    }
    try {
      for (const childID of children) {
        await client.session.delete({ path: { id: childID } });
        result.deleted.push(childID);
      }
    } finally {
      await lock.release();
    }
  }
  return result;
}
