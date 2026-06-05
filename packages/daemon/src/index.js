/**
 * Composition root: wire config → db → queue → runtime → server.
 * Used by cli.js (start --foreground) and by integration tests directly.
 */

/**
 * @param {{port?: number, host?: string, dbPath?: string, configOverrides?: object}} [options]
 * @returns {Promise<{server: object, runtime: object, store: object, close: () => Promise<void>, port: number}>}
 */
export async function startDaemon(options) {
  void options;
  throw new Error('not implemented (P4)');
}
