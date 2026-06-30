'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

test('canonical skill folder exists with frontmatter', () => {
  const skill = readFileSync(join(__dirname, '..', 'skills', 'odw', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: odw\r?\n/);
});

test('canonical Antigravity plugin bundle declares ODW skill, MCP, and rule surfaces', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
  assert.equal(manifest.name, 'odw');
  assert.match(manifest.description, /Open Dynamic Workflows/);

  const rule = readFileSync(join(__dirname, '..', 'plugin', 'rules', 'odw.md'), 'utf8');
  assert.match(rule, /odw_run/);
  assert.match(rule, /ultracode/);
  assert.ok(existsSync(join(__dirname, '..', 'skills', 'odw', 'SKILL.md')));
});
