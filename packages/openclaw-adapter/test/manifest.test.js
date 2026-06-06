'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const skill = join(root, 'skills', 'open-dynamic-workflows');

test('ClawHub skill folder exists with valid SKILL.md frontmatter', () => {
  const md = readFileSync(join(skill, 'SKILL.md'), 'utf8');
  // ClawHub reads name/description/version + metadata.openclaw from frontmatter
  assert.match(md, /^---\r?\nname: open-dynamic-workflows\r?\n/);
  assert.match(md, /\ndescription: .+/);
  assert.match(md, /\nversion: \d/);
  assert.match(md, /metadata:\s*\r?\n\s*openclaw:/);
  assert.match(md, /primaryEnv:/);
});

test('the skill ships its zero-dependency daemon bridge', () => {
  assert.ok(existsSync(join(skill, 'scripts', 'daemon-bridge.js')));
  assert.ok(existsSync(join(skill, '.clawhubignore')));
});

test('package.json declares the OpenClaw plugin-api compat', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'odw-openclaw');
  assert.equal(pkg.openclaw.compat.pluginApi, '1');
});
