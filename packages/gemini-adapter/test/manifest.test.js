import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Gemini custom commands route slash commands through ODW MCP tools', () => {
  const odw = readFileSync(join(root, 'commands', 'odw.toml'), 'utf8');
  const ultracode = readFileSync(join(root, 'commands', 'ultracode.toml'), 'utf8');

  assert.match(odw, /description = "Run a task through Open Dynamic Workflows"/);
  assert.match(odw, /mcp_odw_odw_run/);
  assert.match(odw, /\{\{args\}\}/);
  assert.match(ultracode, /description = "Run an ultracode workflow through Open Dynamic Workflows"/);
  assert.match(ultracode, /mcp_odw_odw_run/);
  assert.match(ultracode, /\{\{args\}\}/);
});
