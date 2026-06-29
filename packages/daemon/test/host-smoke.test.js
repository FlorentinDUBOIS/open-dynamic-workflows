import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

test('root package exposes a safe live host smoke command', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['smoke:hosts'], 'node scripts/smoke-agent-hosts.mjs');
});

test('smoke-agent-hosts validates temp integrations and daemon readiness as JSON', () => {
  const output = execFileSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'smoke-agent-hosts.mjs'), '--json', '--skip-host-probes'],
    { encoding: 'utf8', cwd: repoRoot }
  );
  const report = JSON.parse(output);

  assert.equal(report.ok, true);
  assert.equal(report.integration.ok, true);
  assert.equal(report.daemon.ok, true);
  assert.equal(report.doctor.ok, true);
  assert.deepEqual(report.hosts, []);
  assert.ok(report.generatedFiles.some((path) => path.endsWith('AGENTS.md')));
  assert.ok(report.generatedFiles.some((path) => path.includes('.cursor') && path.endsWith('open-dynamic-workflows.mdc')));
});
