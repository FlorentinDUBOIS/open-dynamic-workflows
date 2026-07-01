import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('workspace test scripts use explicit file globs, not a test directory argument', () => {
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
        /\bnode --test test\/?\b/,
        `${packageJson.name} ${name} script should use node --test "test/*.js" for Windows/Node 24 compatibility`
      );
    }
  }
});
