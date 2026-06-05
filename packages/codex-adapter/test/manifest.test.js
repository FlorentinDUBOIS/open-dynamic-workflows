'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const root = join(__dirname, '..');

test('plugin.json metadata is valid JSON with required fields', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'odw');
  assert.equal(manifest.license, 'MIT');
});

test('canonical skill folder exists with frontmatter and daemon steps', () => {
  const skill = readFileSync(join(root, 'skills', 'odw', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: odw\n/);
  assert.match(skill, /daemon-bridge\.js --check/);
  assert.match(skill, /daemon-bridge\.js plan/);
  assert.ok(existsSync(join(root, 'AGENTS.md')));
});

test('daemon-bridge --check exits 1 with a helpful message when daemon is down', () => {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'daemon-bridge.js'), '--check'], {
      encoding: 'utf8',
      env: { ...process.env, ODW_DAEMON_PORT: '59998' },
      timeout: 15000,
    });
    assert.fail('expected non-zero exit');
  } catch (error) {
    assert.equal(error.status, 1);
    assert.match(String(error.stderr), /not reachable|Start it/);
  }
});

test('daemon-bridge with no args prints usage and exits 2', () => {
  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'daemon-bridge.js')], { encoding: 'utf8', timeout: 15000 });
    assert.fail('expected non-zero exit');
  } catch (error) {
    assert.equal(error.status, 2);
    assert.match(String(error.stderr), /usage/);
  }
});
