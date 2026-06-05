import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// P3 scaffolding tests: module surface + schema contract. Behavior lands in P4.

test('daemon modules export the contracted surface', async () => {
  const mods = {
    './src/config.js': ['odwHome', 'loadConfig', 'apiKeyFor'],
    './src/logger.js': ['createLogger', 'REDACTION_PATTERNS'],
    './src/db.js': ['openDatabase', 'createStore'],
    './src/migrate.js': ['migrate', 'MIGRATIONS'],
    './src/budget.js': ['createBudget'],
    './src/agent-queue.js': ['createAgentQueue'],
    './src/sandbox.js': ['createSandbox'],
    './src/runtime.js': ['createRuntime'],
    './src/resumability.js': ['createResumability'],
    './src/server.js': ['createServer'],
    './src/process.js': ['daemonPaths', 'spawnDetached', 'daemonStatusFromPidFile', 'stopDaemon', 'installShutdownHandlers'],
    './src/providers/index.js': ['resolveProvider'],
  };
  for (const [path, names] of Object.entries(mods)) {
    const mod = await import(new URL(path, new URL('..', import.meta.url).href + '/').href);
    for (const name of names) {
      assert.ok(name in mod, `${path} must export ${name}`);
    }
  }
});

test('schema.sql defines the four contracted tables and five indexes', () => {
  const sql = readFileSync(join(root, 'schema.sql'), 'utf8');
  for (const table of ['workflows', 'agent_nodes', 'checkpoints', 'journal']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  const indexCount = (sql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length;
  assert.equal(indexCount, 5);
});
