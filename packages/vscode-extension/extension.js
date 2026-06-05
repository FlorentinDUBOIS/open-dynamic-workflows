/**
 * Open Dynamic Workflows — VS Code extension (plain CJS, no bundler).
 * Tree view + webview dashboard + status bar, backed by the local odw
 * daemon's HTTP API. Also works in VS Code forks (Antigravity).
 */

'use strict';

const vscode = require('vscode');

const POLL_MS = 5000;

function daemonPort() {
  const configured = vscode.workspace.getConfiguration('odw').get('daemonPort');
  if (configured) return Number(configured);
  if (process.env.ODW_DAEMON_PORT) return Number(process.env.ODW_DAEMON_PORT);
  return 7345;
}

function createDaemonClient() {
  const base = () => `http://127.0.0.1:${daemonPort()}`;
  const request = async (method, path, body) => {
    const res = await fetch(base() + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'GET' ? 4000 : 30000),
    });
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
    return res.json();
  };
  return {
    health: async () => {
      try {
        return await request('GET', '/health');
      } catch {
        return null;
      }
    },
    plan: (prompt) => request('POST', '/workflows/plan', { prompt }),
    exec: (plan, cwd) => request('POST', '/workflows/exec', { plan, cwd }),
    list: async () => {
      try {
        return (await request('GET', '/workflows')).workflows;
      } catch {
        return [];
      }
    },
    get: (id) => request('GET', `/workflows/${id}`),
    script: async (id) => {
      const res = await fetch(`${base()}/workflows/${id}/script`);
      return res.text();
    },
    control: (id, action) => request('POST', `/workflows/${id}/ctl`, { action }),
  };
}

const STATUS_ICONS = {
  running: 'sync~spin',
  completed: 'check',
  failed: 'error',
  paused: 'debug-pause',
  cancelled: 'circle-slash',
  pending: 'clock',
  planning: 'lightbulb',
};

class WorkflowTreeProvider {
  constructor(client) {
    this.client = client;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this.workflows = [];
  }
  refresh() {
    this._emitter.fire(undefined);
  }
  async getChildren(element) {
    if (element) return [];
    this.workflows = await this.client.list();
    return this.workflows;
  }
  getTreeItem(workflow) {
    const item = new vscode.TreeItem(
      `${workflow.workflow_id}  ·  ${workflow.status}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.id = workflow.workflow_id;
    item.description = `${workflow.completed_agents}/${workflow.total_agents} agents · $${Number(workflow.cost_usd ?? 0).toFixed(4)}`;
    item.tooltip = String(workflow.root_prompt ?? '').slice(0, 300);
    item.iconPath = new vscode.ThemeIcon(STATUS_ICONS[workflow.status] ?? 'question');
    item.contextValue = `odwWorkflow-${workflow.status}`;
    return item;
  }
}

function dashboardHtml(workflows, health) {
  const rows = workflows
    .map(
      (w) => `<tr>
        <td><code>${w.workflow_id}</code></td>
        <td><span class="badge ${w.status}">${w.status}</span></td>
        <td>${w.completed_agents}/${w.total_agents}${w.failed_agents ? ` <span class="fail">(${w.failed_agents} failed)</span>` : ''}</td>
        <td>$${Number(w.cost_usd ?? 0).toFixed(4)}</td>
        <td class="prompt">${escapeHtml(String(w.root_prompt ?? '').slice(0, 90))}</td>
      </tr>`
    )
    .join('');
  return `<!DOCTYPE html>
<html><head><style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); padding: 16px; }
  h2 { font-weight: 600; }
  .meta { opacity: 0.75; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid color-mix(in oklab, currentColor 15%, transparent); }
  .badge { padding: 1px 8px; border-radius: 8px; font-size: 0.85em; border: 1px solid currentColor; }
  .badge.running { color: oklch(0.72 0.17 155); }
  .badge.completed { color: oklch(0.585 0.207 277); }
  .badge.failed, .fail { color: oklch(0.6 0.21 25); }
  .badge.paused { color: oklch(0.8 0.16 85); }
  .prompt { opacity: 0.8; }
  code { font-size: 0.9em; }
</style></head>
<body>
  <h2>Dynamic Workflows</h2>
  <div class="meta">${
    health
      ? `daemon healthy · ${health.activeWorkflows} active · ${health.activeAgents}/${health.maxConcurrency} agents busy`
      : 'daemon offline — install from github.com/Suraj1235/open-dynamic-workflows, then run <code>odw-daemon start</code>'
  }</div>
  <table>
    <tr><th>id</th><th>status</th><th>agents</th><th>cost</th><th>prompt</th></tr>
    ${rows || '<tr><td colspan="5">no workflows yet</td></tr>'}
  </table>
</body></html>`;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
  const client = createDaemonClient();
  const tree = new WorkflowTreeProvider(client);
  let dashboardPanel = null;

  context.subscriptions.push(vscode.window.registerTreeDataProvider('odwWorkflows', tree));

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'odw.showDashboard';
  context.subscriptions.push(statusBar);

  const refreshAll = async () => {
    const health = await client.health();
    if (health) {
      statusBar.text = `$(rocket) odw ${health.activeWorkflows ? `· ${health.activeWorkflows} running` : ''}`;
      statusBar.tooltip = `odw daemon · ${health.activeAgents}/${health.maxConcurrency} agents busy`;
    } else {
      statusBar.text = '$(rocket) odw offline';
      statusBar.tooltip = 'odw daemon is not running';
    }
    statusBar.show();
    tree.refresh();
    if (dashboardPanel) {
      dashboardPanel.webview.html = dashboardHtml(await client.list(), health);
    }
  };

  const poll = setInterval(() => refreshAll().catch(() => {}), POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  refreshAll().catch(() => {});

  const workflowIdFrom = async (target) => {
    if (typeof target === 'string') return target;
    if (target?.id) return target.id;
    const items = (await client.list()).map((w) => ({ label: w.workflow_id, description: w.status }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'select a workflow' });
    return picked?.label;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('odw.runWorkflow', async () => {
      if (!(await client.health())) {
        const choice = await vscode.window.showWarningMessage('odw daemon is not running.', 'Install / Start Daemon');
        if (choice) vscode.commands.executeCommand('odw.installDaemon');
        return;
      }
      const prompt = await vscode.window.showInputBox({
        prompt: 'Describe the workflow',
        placeHolder: 'audit all API endpoints for missing auth checks',
      });
      if (!prompt) return;

      const { plan } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'odw: planning…' },
        () => client.plan(prompt)
      );
      const e = plan.estimate;
      const choice = await vscode.window.showInformationMessage(
        `${plan.topology} · ~${e.totalAgents} agents · ~$${e.costUSD} · ~${e.minutes} min`,
        { modal: true, detail: 'Execute this workflow?' },
        'Run',
        'View Script'
      );
      if (choice === 'View Script') {
        const doc = await vscode.workspace.openTextDocument({ content: plan.script, language: 'javascript' });
        await vscode.window.showTextDocument(doc);
        return;
      }
      if (choice !== 'Run') return;
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const { workflowId } = await client.exec(plan, cwd);
      vscode.window.showInformationMessage(`odw workflow ${workflowId} started`);
      refreshAll();
    }),

    vscode.commands.registerCommand('odw.showDashboard', async () => {
      if (dashboardPanel) {
        dashboardPanel.reveal();
      } else {
        dashboardPanel = vscode.window.createWebviewPanel('odwDashboard', 'Dynamic Workflows', vscode.ViewColumn.One, {});
        dashboardPanel.onDidDispose(() => (dashboardPanel = null));
      }
      dashboardPanel.webview.html = dashboardHtml(await client.list(), await client.health());
    }),

    vscode.commands.registerCommand('odw.pauseWorkflow', async (target) => {
      const id = await workflowIdFrom(target);
      if (id) {
        await client.control(id, 'pause');
        refreshAll();
      }
    }),

    vscode.commands.registerCommand('odw.resumeWorkflow', async (target) => {
      const id = await workflowIdFrom(target);
      if (id) {
        await client.control(id, 'resume');
        refreshAll();
      }
    }),

    vscode.commands.registerCommand('odw.stopWorkflow', async (target) => {
      const id = await workflowIdFrom(target);
      if (id) {
        await client.control(id, 'stop');
        refreshAll();
      }
    }),

    vscode.commands.registerCommand('odw.installDaemon', () => {
      const terminal = vscode.window.createTerminal('odw daemon');
      terminal.sendText('git clone https://github.com/Suraj1235/open-dynamic-workflows && cd open-dynamic-workflows && npm install && npm run setup');
      terminal.show();
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate, _internal: { dashboardHtml, escapeHtml, STATUS_ICONS } };
