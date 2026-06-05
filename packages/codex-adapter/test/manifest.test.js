'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');

test('plugin.json metadata is valid JSON with required fields', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'odw');
  assert.equal(manifest.license, 'MIT');
});

test('canonical skill folder exists with frontmatter', () => {
  const skill = readFileSync(join(root, 'skills', 'odw', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: odw\n/);
  assert.ok(existsSync(join(root, 'scripts', 'daemon-bridge.js')));
});
