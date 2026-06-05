/**
 * Versioned migrations driven by PRAGMA user_version.
 * Each migration applies inside a transaction; user_version bumps with it.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Array<{version: number, name: string, sql: () => string}>} */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-schema',
    sql: () => readFileSync(join(pkgRoot, 'schema.sql'), 'utf8'),
  },
];

/**
 * Apply pending migrations (> user_version).
 * @param {import('better-sqlite3').Database} db
 * @returns {{applied: string[], userVersion: number}}
 */
export function migrate(db) {
  const applied = [];
  let current = db.pragma('user_version', { simple: true });
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql());
      db.pragma(`user_version = ${migration.version}`);
    });
    run();
    current = migration.version;
    applied.push(migration.name);
  }
  return { applied, userVersion: current };
}
