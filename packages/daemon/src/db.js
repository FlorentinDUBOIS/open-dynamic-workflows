/**
 * SQLite state store (better-sqlite3, WAL). All daemon persistence flows
 * through this module — no other module touches the database file.
 */

/**
 * Open (or create) the database, enable WAL, run migrations.
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(dbPath) {
  void dbPath;
  throw new Error('not implemented (P4)');
}

/**
 * Prepared-statement facade used by runtime/resumability/server.
 * @param {import('better-sqlite3').Database} db
 */
export function createStore(db) {
  void db;
  throw new Error('not implemented (P4)');
}
