import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('canonical Zed Agent skill exists with frontmatter and daemon steps', () => {
  const skill = readFileSync(join(root, 'skills', 'odw', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: odw\r?\n/);
  assert.match(skill, /Zed Agent/);
  assert.match(skill, /daemon-bridge\.js --check/);
  assert.match(skill, /odw_run/);
});

test('canonical Zed ultracode alias skill exists with frontmatter and daemon steps', () => {
  const skill = readFileSync(join(root, 'skills', 'ultracode', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: ultracode\r?\n/);
  assert.match(skill, /Zed Agent/);
  assert.match(skill, /daemon-bridge\.js --check/);
  assert.match(skill, /odw_run/);
});

test('Zed adapter intentionally reuses the zero-dependency daemon bridge at install time', () => {
  assert.ok(existsSync(join(root, '..', 'codex-adapter', 'scripts', 'daemon-bridge.js')));
});
