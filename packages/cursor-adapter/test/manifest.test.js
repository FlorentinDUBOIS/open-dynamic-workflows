'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');

test('canonical Cursor skill exists with frontmatter and daemon steps', () => {
  const skillPath = join(root, 'skills', 'odw', 'SKILL.md');
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /^---\r?\nname: odw\r?\n/);
  assert.match(skill, /Cursor Agent/);
  assert.match(skill, /daemon-bridge\.js --check/);
  assert.match(skill, /odw_run/);
});

test('canonical Cursor ultracode alias skill exists with frontmatter and daemon steps', () => {
  const skillPath = join(root, 'skills', 'ultracode', 'SKILL.md');
  const skill = readFileSync(skillPath, 'utf8');
  assert.match(skill, /^---\r?\nname: ultracode\r?\n/);
  assert.match(skill, /Cursor Agent/);
  assert.match(skill, /daemon-bridge\.js --check/);
  assert.match(skill, /odw_run/);
});

test('canonical Cursor subagent exists with orchestrator frontmatter', () => {
  const subagentPath = join(root, 'agents', 'odw-orchestrator.md');
  const subagent = readFileSync(subagentPath, 'utf8');
  assert.match(subagent, /^---\r?\nname: odw-orchestrator\r?\n/);
  assert.match(subagent, /description: .*ultracode/);
  assert.match(subagent, /model: inherit/);
  assert.match(subagent, /odw_run/);
});

test('Cursor adapter intentionally reuses the zero-dependency daemon bridge at install time', () => {
  assert.ok(existsSync(join(root, '..', 'codex-adapter', 'scripts', 'daemon-bridge.js')));
});
