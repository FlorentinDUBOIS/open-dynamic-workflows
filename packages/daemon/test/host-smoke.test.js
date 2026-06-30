import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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
  assert.ok(report.generatedFiles.some((path) => path.includes('.cursor') && path.endsWith(join('skills', 'odw', 'SKILL.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.kimi') && path.endsWith(join('skills', 'odw', 'SKILL.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.agents') && path.endsWith(join('skills', 'odw', 'SKILL.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.gemini') && path.endsWith(join('commands', 'odw.toml'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.gemini') && path.endsWith(join('commands', 'ultracode.toml'))));
});

test('smoke-agent-hosts can require specific host evidence', () => {
  assert.throws(
    () => execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'smoke-agent-hosts.mjs'), '--json', '--skip-host-probes', '--require-host', 'opencode'],
      { encoding: 'utf8', cwd: repoRoot }
    ),
    (error) => {
      assert.equal(error.status, 1);
      const report = JSON.parse(error.stdout);
      assert.equal(report.ok, false);
      assert.deepEqual(report.requiredHosts, ['opencode']);
      assert.match(report.error, /required host evidence missing: opencode/);
      return true;
    }
  );
});

test('smoke-agent-hosts executes Windows command shims from paths with spaces', () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'odw fake bin '));
  try {
    writeFileSync(join(fakeBin, 'code.cmd'), '@echo off\r\necho 9.9.9\r\n', 'utf8');
    const pathValue = `${fakeBin}${delimiter}${process.env.PATH || ''}`;
    const output = execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'smoke-agent-hosts.mjs'), '--json', '--require-host', 'vscode'],
      {
        encoding: 'utf8',
        cwd: repoRoot,
        env: { ...process.env, PATH: pathValue, Path: pathValue },
      }
    );
    const report = JSON.parse(output);
    const vscode = report.hosts.find((host) => host.name === 'vscode');
    assert.equal(vscode.status, 'ok');
    assert.equal(vscode.output, '9.9.9');
  } finally {
    safeRemoveTemp(fakeBin);
  }
});

function safeRemoveTemp(path) {
  const resolvedPath = resolve(path);
  const resolvedTemp = resolve(tmpdir());
  if (!resolvedPath.toLowerCase().startsWith(resolvedTemp.toLowerCase())) {
    throw new Error(`refusing cleanup outside temp: ${resolvedPath}`);
  }
  rmSync(path, { recursive: true, force: true });
}
