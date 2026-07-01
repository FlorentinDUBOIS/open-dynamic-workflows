/**
 * SQLite state store (better-sqlite3, WAL). All daemon persistence flows
 * through this module — no other module touches the database file.
 */

import { createRequire } from 'node:module';
import { migrate } from './migrate.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/**
 * Open (or create) the database, enable WAL, run migrations.
 * @param {string} dbPath
 * @returns {import('better-sqlite3').Database}
 */
export function openDatabase(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Prepared-statement facade used by runtime/resumability/server.
 * @param {import('better-sqlite3').Database} db
 */
export function createStore(db) {
  const stmts = {
    insertWorkflow: db.prepare(`
      INSERT INTO workflows (workflow_id, status, root_prompt, compiled_script, execution_strategy, topology, total_agents, budget_max_usd)
      VALUES (@workflow_id, @status, @root_prompt, @compiled_script, @execution_strategy, @topology, @total_agents, @budget_max_usd)`),
    getWorkflow: db.prepare('SELECT * FROM workflows WHERE workflow_id = ?'),
    listWorkflows: db.prepare('SELECT workflow_id, status, root_prompt, topology, total_agents, completed_agents, failed_agents, cost_usd, created_at, updated_at, completed_at FROM workflows ORDER BY created_at DESC'),
    listByStatus: db.prepare('SELECT workflow_id, status FROM workflows WHERE status IN (?, ?) ORDER BY created_at'),
    setWorkflowStatus: db.prepare("UPDATE workflows SET status = ?, updated_at = unixepoch() WHERE workflow_id = ?"),
    setWorkflowResult: db.prepare("UPDATE workflows SET status = ?, result = ?, completed_at = unixepoch(), updated_at = unixepoch() WHERE workflow_id = ?"),
    bumpWorkflowTotals: db.prepare(`
      UPDATE workflows SET completed_agents = completed_agents + @completed, failed_agents = failed_agents + @failed,
        tokens_input = tokens_input + @tokens_input, tokens_output = tokens_output + @tokens_output,
        cost_usd = cost_usd + @cost_usd, updated_at = unixepoch()
      WHERE workflow_id = @workflow_id`),
    setTotalAgents: db.prepare('UPDATE workflows SET total_agents = ?, updated_at = unixepoch() WHERE workflow_id = ?'),
    setBudgetAlerted: db.prepare('UPDATE workflows SET budget_alerted = TRUE WHERE workflow_id = ?'),

    upsertNode: db.prepare(`
      INSERT INTO agent_nodes (node_id, workflow_id, phase_name, role_id, status, prompt, max_retries, started_at)
      VALUES (@node_id, @workflow_id, @phase_name, @role_id, @status, @prompt, @max_retries, unixepoch())
      ON CONFLICT(node_id) DO UPDATE SET status = excluded.status, started_at = unixepoch()`),
    getNode: db.prepare('SELECT * FROM agent_nodes WHERE node_id = ?'),
    completeNode: db.prepare(`
      UPDATE agent_nodes SET status = 'completed', output = @output, tokens_input = @tokens_input,
        tokens_output = @tokens_output, cost_usd = @cost_usd, duration_ms = @duration_ms, completed_at = unixepoch()
      WHERE node_id = @node_id`),
    failNode: db.prepare(`
      UPDATE agent_nodes SET status = @status, error = @error, retry_count = retry_count + 1, completed_at = unixepoch()
      WHERE node_id = @node_id`),
    nodesByWorkflow: db.prepare('SELECT * FROM agent_nodes WHERE workflow_id = ?'),
    completedNodes: db.prepare("SELECT node_id, output, tokens_input, tokens_output, cost_usd, duration_ms FROM agent_nodes WHERE workflow_id = ? AND status = 'completed'"),
    requeueOrphans: db.prepare(`
      UPDATE agent_nodes SET status = 'queued', retry_count = retry_count + 1
      WHERE workflow_id = ? AND status IN ('running', 'failed', 'retrying') AND retry_count < max_retries`),
    nodeStats: db.prepare(`
      SELECT status, COUNT(*) AS n FROM agent_nodes WHERE workflow_id = ? GROUP BY status`),

    insertCheckpoint: db.prepare(`
      INSERT INTO checkpoints (checkpoint_id, workflow_id, phase_name, checkpoint_key, state_data, agent_results)
      VALUES (@checkpoint_id, @workflow_id, @phase_name, @checkpoint_key, @state_data, @agent_results)`),
    latestCheckpoint: db.prepare('SELECT * FROM checkpoints WHERE workflow_id = ? ORDER BY committed_at DESC, checkpoint_id DESC LIMIT 1'),
    // rowid tiebreak = insertion-order latest within the same second (checkpoint_id is random).
    checkpointByKey: db.prepare('SELECT * FROM checkpoints WHERE workflow_id = ? AND checkpoint_key = ? ORDER BY committed_at DESC, rowid DESC LIMIT 1'),

    journal: db.prepare('INSERT INTO journal (workflow_id, operation, payload) VALUES (?, ?, ?)'),
    journalAfter: db.prepare('SELECT journal_id, operation, payload, timestamp FROM journal WHERE workflow_id = ? AND journal_id > ? ORDER BY journal_id'),
  };

  return {
    db,
    insertWorkflow: (row) => stmts.insertWorkflow.run(row),
    getWorkflow: (id) => stmts.getWorkflow.get(id),
    listWorkflows: () => stmts.listWorkflows.all(),
    listInterrupted: () => stmts.listByStatus.all('running', 'paused'),
    setWorkflowStatus: (id, status) => stmts.setWorkflowStatus.run(status, id),
    setWorkflowResult: (id, status, result) => stmts.setWorkflowResult.run(status, JSON.stringify(result ?? null), id),
    bumpWorkflowTotals: (row) => stmts.bumpWorkflowTotals.run(row),
    setTotalAgents: (id, n) => stmts.setTotalAgents.run(n, id),
    setBudgetAlerted: (id) => stmts.setBudgetAlerted.run(id),

    upsertNode: (row) => stmts.upsertNode.run(row),
    getNode: (id) => stmts.getNode.get(id),
    completeNode: (row) => stmts.completeNode.run(row),
    failNode: (row) => stmts.failNode.run(row),
    nodesByWorkflow: (id) => stmts.nodesByWorkflow.all(id),
    completedNodes: (id) => stmts.completedNodes.all(id),
    requeueOrphans: (id) => stmts.requeueOrphans.run(id).changes,
    nodeStats: (id) => Object.fromEntries(stmts.nodeStats.all(id).map((r) => [r.status, r.n])),

    insertCheckpoint: (row) => stmts.insertCheckpoint.run(row),
    latestCheckpoint: (id) => stmts.latestCheckpoint.get(id),
    checkpointByKey: (id, key) => stmts.checkpointByKey.get(id, key),

    journal: (workflowId, operation, payload) =>
      stmts.journal.run(workflowId, operation, JSON.stringify(payload ?? {})),
    journalAfter: (workflowId, afterId) => stmts.journalAfter.all(workflowId, afterId),

    close: () => db.close(),
  };
}
