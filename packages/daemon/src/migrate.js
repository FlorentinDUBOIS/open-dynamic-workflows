/**
 * Versioned migrations driven by PRAGMA user_version.
 * MIGRATIONS[i].version must be strictly increasing; each applies in a transaction.
 */

/** @type {Array<{version: number, name: string, sql?: string, file?: string}>} */
export const MIGRATIONS = [
  { version: 1, name: 'initial-schema', file: 'schema.sql' },
];

/**
 * Apply pending migrations (> user_version).
 * @param {import('better-sqlite3').Database} db
 * @returns {{applied: string[], userVersion: number}}
 */
export function migrate(db) {
  void db;
  throw new Error('not implemented (P4)');
}
