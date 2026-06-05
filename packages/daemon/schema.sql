-- open-dynamic-workflows daemon state (SQLite, WAL).
-- Applied transactionally at boot; versioned via PRAGMA user_version (see src/migrate.js).

CREATE TABLE IF NOT EXISTS workflows (
    workflow_id TEXT PRIMARY KEY,
    status TEXT CHECK(status IN ('pending', 'planning', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    root_prompt TEXT NOT NULL,
    compiled_script TEXT NOT NULL,
    execution_strategy TEXT NOT NULL,
    topology TEXT NOT NULL,
    total_agents INTEGER DEFAULT 0,
    completed_agents INTEGER DEFAULT 0,
    failed_agents INTEGER DEFAULT 0,
    tokens_input INTEGER DEFAULT 0,
    tokens_output INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0.0,
    budget_max_usd REAL DEFAULT 0.0,
    budget_alerted BOOLEAN DEFAULT FALSE,
    result TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_nodes (
    node_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    phase_name TEXT NOT NULL,
    role_id TEXT NOT NULL,
    status TEXT CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'retrying')),
    prompt TEXT NOT NULL,
    output TEXT,
    error TEXT,
    tokens_input INTEGER DEFAULT 0,
    tokens_output INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0.0,
    duration_ms INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    started_at INTEGER,
    completed_at INTEGER,
    FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS checkpoints (
    checkpoint_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    phase_name TEXT NOT NULL,
    checkpoint_key TEXT NOT NULL,
    state_data TEXT NOT NULL,
    agent_results TEXT,
    committed_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS journal (
    journal_id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_workflow ON agent_nodes(workflow_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON agent_nodes(status);
CREATE INDEX IF NOT EXISTS idx_checkpoints_workflow ON checkpoints(workflow_id);
CREATE INDEX IF NOT EXISTS idx_journal_workflow ON journal(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
