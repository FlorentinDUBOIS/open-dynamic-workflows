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

test('Cursor adapter intentionally reuses the zero-dependency daemon bridge at install time', () => {
  assert.ok(existsSync(join(root, '..', 'codex-adapter', 'scripts', 'daemon-bridge.js')));
});
