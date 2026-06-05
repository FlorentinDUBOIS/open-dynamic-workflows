'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const Module = require('node:module');

// Stub the 'vscode' host module so the extension can be loaded under node:test.
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
  window: {
    registerTreeDataProvider: () => ({ dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    createWebviewPanel: () => ({ webview: {}, onDidDispose() {}, reveal() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => undefined,
    createTerminal: () => ({ sendText() {}, show() {} }),
    withProgress: (_o, fn) => fn(),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => {} },
  EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  StatusBarAlignment: { Left: 1 },
  ProgressLocation: { Notification: 15 },
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...rest);
};

test('extension manifest declares the contracted commands and view', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.main, './extension.js');
  const commands = pkg.contributes.commands.map((c) => c.command);
  for (const cmd of ['odw.runWorkflow', 'odw.showDashboard', 'odw.pauseWorkflow', 'odw.resumeWorkflow', 'odw.stopWorkflow', 'odw.installDaemon']) {
    assert.ok(commands.includes(cmd), `missing ${cmd}`);
  }
  assert.equal(pkg.contributes.views.odw[0].id, 'odwWorkflows');
});

test('extension activates against the stub host and registers everything', () => {
  const ext = require('../extension.js');
  assert.equal(typeof ext.activate, 'function');
  assert.equal(typeof ext.deactivate, 'function');
  const subscriptions = [];
  ext.activate({ subscriptions });
  assert.ok(subscriptions.length >= 8, `subscriptions registered: ${subscriptions.length}`);
  for (const sub of subscriptions) sub.dispose?.();
});

test('dashboard html renders workflows and escapes content', () => {
  const { _internal } = require('../extension.js');
  const html = _internal.dashboardHtml(
    [{ workflow_id: 'wf_1', status: 'running', completed_agents: 2, total_agents: 5, failed_agents: 0, cost_usd: 0.12, root_prompt: '<script>alert(1)</script>' }],
    { activeWorkflows: 1, activeAgents: 2, maxConcurrency: 16 }
  );
  assert.match(html, /wf_1/);
  assert.match(html, /daemon healthy/);
  assert.ok(!html.includes('<script>alert'), 'prompt must be escaped');
  assert.match(_internal.dashboardHtml([], null), /daemon offline/);
});
