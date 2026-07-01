/**
 * In-memory store — a zero-dependency, pure-JS implementation of the same facade
 * createStore (db.js) exposes, for the EMBEDDED orchestrator (running inside a
 * host plugin such as OpenCode, where the native better-sqlite3 addon may be
 * unavailable, e.g. under Bun). It keeps exactly the methods runtime.js needs;
 * persistence/cross-restart resume are daemon-only features and intentionally
 * absent here (an embedded run lives for the duration of the host session).
 */

export function createMemoryStore() {
  /** @type {Map<string, any>} */
  const workflows = new Map();
  /** @type {Map<string, any>} */
  const nodes = new Map();
  /** @type {any[]} */
  const checkpoints = [];
  /** @type {any[]} */
  const journalRows = [];
  let journalSeq = 0;

  return {
    insertWorkflow(row) {
      workflows.set(row.workflow_id, {
        completed_agents: 0, failed_agents: 0, tokens_input: 0, tokens_output: 0,
        cost_usd: 0, budget_alerted: false, result: null,
        ...row,
      });
    },
    getWorkflow: (id) => workflows.get(id),
    listWorkflows: () => [...workflows.values()],
    // Embedded runs never resume across host sessions.
    listInterrupted: () => [],
    setWorkflowStatus(id, status) {
      const w = workflows.get(id);
      if (w) w.status = status;
    },
    setWorkflowResult(id, status, result) {
      const w = workflows.get(id);
      if (w) { w.status = status; w.result = JSON.stringify(result ?? null); }
    },
    bumpWorkflowTotals({ workflow_id, completed = 0, failed = 0, tokens_input = 0, tokens_output = 0, cost_usd = 0 }) {
      const w = workflows.get(workflow_id);
      if (!w) return;
      w.completed_agents += completed;
      w.failed_agents += failed;
      w.tokens_input += tokens_input;
      w.tokens_output += tokens_output;
      w.cost_usd += cost_usd;
    },
    setTotalAgents(id, n) { const w = workflows.get(id); if (w) w.total_agents = n; },
    setBudgetAlerted(id) { const w = workflows.get(id); if (w) w.budget_alerted = true; },

    upsertNode(row) {
      const existing = nodes.get(row.node_id);
      nodes.set(row.node_id, { retry_count: 0, ...(existing ?? {}), ...row });
    },
    getNode: (id) => nodes.get(id),
    completeNode({ node_id, output, tokens_input, tokens_output, cost_usd, duration_ms }) {
      const n = nodes.get(node_id);
      if (n) Object.assign(n, { status: 'completed', output, tokens_input, tokens_output, cost_usd, duration_ms });
    },
    failNode({ node_id, status, error }) {
      const n = nodes.get(node_id);
      if (n) { n.status = status; n.error = error; n.retry_count = (n.retry_count ?? 0) + 1; }
    },
    nodesByWorkflow: (id) => [...nodes.values()].filter((n) => n.workflow_id === id),
    completedNodes: (id) => [...nodes.values()]
      .filter((n) => n.workflow_id === id && n.status === 'completed')
      .map((n) => ({ node_id: n.node_id, output: n.output, tokens_input: n.tokens_input, tokens_output: n.tokens_output, cost_usd: n.cost_usd, duration_ms: n.duration_ms })),
    requeueOrphans(id) {
      let changes = 0;
      for (const n of nodes.values()) {
        if (n.workflow_id === id && ['running', 'failed', 'retrying'].includes(n.status) && (n.retry_count ?? 0) < (n.max_retries ?? 3)) {
          n.status = 'queued'; n.retry_count = (n.retry_count ?? 0) + 1; changes++;
        }
      }
      return changes;
    },
    nodeStats(id) {
      const out = {};
      for (const n of nodes.values()) if (n.workflow_id === id) out[n.status] = (out[n.status] ?? 0) + 1;
      return out;
    },

    insertCheckpoint(row) { checkpoints.push(row); },
    latestCheckpoint: (id) => [...checkpoints].reverse().find((c) => c.workflow_id === id) ?? null,
    checkpointByKey: (id, key) =>
      [...checkpoints].reverse().find((c) => c.workflow_id === id && c.checkpoint_key === key) ?? null,

    journal(workflowId, operation, payload) {
      journalRows.push({ journal_id: ++journalSeq, workflow_id: workflowId, operation, payload: JSON.stringify(payload ?? {}), timestamp: 0 });
    },
    journalAfter: (workflowId, afterId) => journalRows.filter((r) => r.workflow_id === workflowId && r.journal_id > afterId),

    close() { /* nothing to release */ },
  };
}
