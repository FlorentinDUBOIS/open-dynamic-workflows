import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('workspace test scripts use the shared cross-version runner', () => {
  const packageDirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, 'packages', entry.name));

  for (const dir of packageDirs) {
    const raw = readFileSync(join(dir, 'package.json'), 'utf8');
    const packageJson = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    for (const [name, script] of Object.entries(packageJson.scripts ?? {})) {
      if (name !== 'test' && name !== 'coverage') continue;
      assert.doesNotMatch(
        script,
        /\bnode --test\b/,
        `${packageJson.name} ${name} script should use scripts/run-node-tests.mjs for cross-version file discovery`
      );
      assert.match(
        script,
        /scripts\/run-node-tests\.mjs/,
        `${packageJson.name} ${name} script should use scripts/run-node-tests.mjs`
      );
    }
  }
});

test('root external test script uses the shared cross-version runner', () => {
  const raw = readFileSync(join(root, 'package.json'), 'utf8');
  const packageJson = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  const script = packageJson.scripts?.['test:external'] ?? '';

  assert.doesNotMatch(
    script,
    /\bnode --test\b/,
    'root test:external should use scripts/run-node-tests.mjs for cross-version file discovery'
  );
  assert.match(
    script,
    /scripts\/run-node-tests\.mjs/,
    'root test:external should use scripts/run-node-tests.mjs'
  );
});

test('packages that embed the daemon require its Node runtime floor', () => {
  for (const relativePath of [
    'packages/mcp-server/package.json',
    'packages/opencode-plugin/package.json',
  ]) {
    const packageJson = JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
    assert.equal(
      packageJson.engines?.node,
      '>=22.12.0',
      `${packageJson.name} embeds odw-daemon and must require its Node runtime floor`
    );
  }
});
