'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('extension manifest declares the contracted commands and view', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.main, './extension.js');
  const commands = pkg.contributes.commands.map((c) => c.command);
  for (const cmd of ['odw.runWorkflow', 'odw.showDashboard', 'odw.pauseWorkflow', 'odw.resumeWorkflow', 'odw.stopWorkflow']) {
    assert.ok(commands.includes(cmd), `missing ${cmd}`);
  }
  assert.equal(pkg.contributes.views.odw[0].id, 'odwWorkflows');
});

test('extension module loads and exports activate/deactivate', () => {
  const ext = require('../extension.js');
  assert.equal(typeof ext.activate, 'function');
  assert.equal(typeof ext.deactivate, 'function');
});
