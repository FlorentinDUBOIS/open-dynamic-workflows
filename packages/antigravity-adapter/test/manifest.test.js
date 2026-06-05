'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('canonical skill folder exists with frontmatter', () => {
  const skill = readFileSync(join(__dirname, '..', 'skills', 'odw', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: odw\n/);
});
