import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGeneratedTests } from './test-runner.mjs';

test('runGeneratedTests executes generated project tests on current Node', async () => {
  const projectDir = await mkdtemp(join(tmpdir(), 'odw-generated-project-'));
  await mkdir(join(projectDir, 'src'), { recursive: true });
  await mkdir(join(projectDir, 'test'), { recursive: true });
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(projectDir, 'src', 'index.js'), 'export function ok(){ return true; }\n');
  await writeFile(join(projectDir, 'test', 'index.test.js'), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ok } from '../src/index.js';

test('generated test passes', () => {
  assert.equal(ok(), true);
});
`);

  const result = await runGeneratedTests(projectDir);

  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /generated test passes/);
  assert.doesNotMatch(result.stdout + result.stderr, /Cannot find module/);
});
