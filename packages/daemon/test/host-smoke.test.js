import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

test('root package exposes a safe live host smoke command', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['smoke:hosts'], 'node scripts/smoke-agent-hosts.mjs');
});

test('setup next steps advertise every supported integration including all mode', () => {
  const setup = readFileSync(join(repoRoot, 'scripts', 'setup.mjs'), 'utf8');
  assert.match(setup, /odw-daemon integrate all/);
  for (const agent of ['mcp', 'codex', 'cursor', 'kimi', 'gemini', 'zed', 'zcode', 'opencode', 'vscode', 'antigravity', 'openclaw']) {
    assert.match(setup, new RegExp(`\\b${agent}\\b`));
  }
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
  assert.equal(report.workflow.ok, true);
  assert.equal(report.workflow.status, 'completed');
  assert.match(report.workflow.workflowId, /^wf_/);
  assert.equal(report.workflow.result.summary, 'mock synthesis of all results');
  assert.ok(report.workflow.mockCalls >= 1);
  assert.equal(report.mcp.ok, true);
  assert.ok(report.mcp.tools.includes('odw_run'));
  assert.match(report.mcp.health, /daemon ok/);
  assert.equal(report.mcp.run.status, 'completed');
  assert.match(report.mcp.run.workflowId, /^wf_/);
  assert.equal(Object.hasOwn(report.doctor, 'stdout'), false);
  assert.ok(report.doctor.integration.checks.some((check) => check.label === 'zcode agent instructions'));
  assert.ok(report.doctor.integration.checks.some((check) => check.label === 'zcode ultracode agent skill'));
  assert.equal(report.integration.agentInstructions.combinedHostAudience, true);
  assert.deepEqual(report.hosts, []);
  assert.ok(report.generatedFiles.some((path) => path.endsWith('AGENTS.md')));
  assert.ok(report.generatedFiles.some((path) => path.includes('.cursor') && path.endsWith('open-dynamic-workflows.mdc')));
  assert.ok(report.generatedFiles.some((path) => path.includes('.cursor') && path.endsWith(join('skills', 'odw', 'SKILL.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.cursor') && path.endsWith(join('skills', 'ultracode', 'SKILL.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.cursor') && path.endsWith(join('agents', 'odw-orchestrator.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes(join('.agents', 'skills', 'odw')) && path.endsWith(join('scripts', 'daemon-bridge.js'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.kimi') && path.endsWith(join('skills', 'odw', 'SKILL.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.kimi') && path.endsWith(join('skills', 'ultracode', 'SKILL.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.agents') && path.endsWith(join('skills', 'odw', 'SKILL.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.agents') && path.endsWith(join('skills', 'ultracode', 'SKILL.md'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.gemini') && path.endsWith(join('commands', 'odw.toml'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.gemini') && path.endsWith(join('commands', 'ultracode.toml'))));
  assert.ok(report.generatedFiles.some((path) => path.includes('.opencode') && path.endsWith(join('commands', 'workflows.md'))));
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

test('smoke-agent-hosts executes command shims from paths with spaces', () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'odw fake bin '));
  try {
    if (process.platform === 'win32') {
      writeFileSync(join(fakeBin, 'code.cmd'), '@echo off\r\necho 9.9.9\r\n', 'utf8');
    } else {
      const file = join(fakeBin, 'code');
      writeFileSync(file, '#!/bin/sh\necho 9.9.9\n', 'utf8');
      chmodSync(file, 0o755);
    }
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

test('smoke-agent-hosts can run an opt-in OpenCode live command probe', () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'odw-fake-opencode-'));
  try {
    if (process.platform === 'win32') {
      writeFileSync(
        join(fakeBin, 'opencode.cmd'),
        '@echo off\r\n' +
          'if "%1"=="--version" (\r\n  echo 1.2.3\r\n  exit /b 0\r\n)\r\n' +
          'if "%ODW_DAEMON_PORT%"=="" (\r\n  echo missing daemon port 1>&2\r\n  exit /b 23\r\n)\r\n' +
          'if "%ODW_HOME%"=="" (\r\n  echo missing odw home 1>&2\r\n  exit /b 24\r\n)\r\n' +
          'if not exist "opencode.json" (\r\n  echo missing opencode cwd config 1>&2\r\n  exit /b 25\r\n)\r\n' +
          'echo {"type":"tool_use","part":{"tool":"odw_workflows","state":{"status":"completed","output":"wf_fake completed"}}}\r\n' +
          'echo {"type":"text","part":{"text":"Daemon is running"}}\r\n',
        'utf8'
      );
    } else {
      const file = join(fakeBin, 'opencode');
      writeFileSync(
        file,
        '#!/bin/sh\n' +
          'if [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\n' +
          'if [ -z "$ODW_DAEMON_PORT" ]; then echo missing daemon port >&2; exit 23; fi\n' +
          'if [ -z "$ODW_HOME" ]; then echo missing odw home >&2; exit 24; fi\n' +
          'if [ ! -f opencode.json ]; then echo missing opencode cwd config >&2; exit 25; fi\n' +
          "echo '{\"type\":\"tool_use\",\"part\":{\"tool\":\"odw_workflows\",\"state\":{\"status\":\"completed\",\"output\":\"wf_fake completed\"}}}'\n" +
          "echo '{\"type\":\"text\",\"part\":{\"text\":\"Daemon is running\"}}'\n",
        'utf8'
      );
      chmodSync(file, 0o755);
    }
    const pathValue = `${fakeBin}${delimiter}${process.env.PATH || ''}`;
    const output = execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'smoke-agent-hosts.mjs'), '--json', '--require-host', 'opencode', '--live-host', 'opencode'],
      {
        encoding: 'utf8',
        cwd: repoRoot,
        env: { ...process.env, PATH: pathValue, Path: pathValue },
      }
    );
    const report = JSON.parse(output);
    const opencode = report.hosts.find((host) => host.name === 'opencode');
    assert.equal(opencode.status, 'ok');
    assert.equal(opencode.live.ok, true);
    assert.equal(opencode.live.command, 'tool-prompt');
    assert.match(opencode.live.output, /wf_fake completed|Daemon is running/);
  } finally {
    safeRemoveTemp(fakeBin);
  }
});

test('smoke-agent-hosts can require the OpenCode embedded engine probe', () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'odw-fake-opencode-embedded-'));
  try {
    if (process.platform === 'win32') {
      writeFileSync(
        join(fakeBin, 'opencode.cmd'),
        '@echo off\r\n' +
          'if "%1"=="--version" (\r\n  echo 1.2.3\r\n  exit /b 0\r\n)\r\n' +
          'if "%ODW_DAEMON_PORT%"=="" (\r\n  echo missing daemon port 1>&2\r\n  exit /b 23\r\n)\r\n' +
          'if "%ODW_HOME%"=="" (\r\n  echo missing odw home 1>&2\r\n  exit /b 24\r\n)\r\n' +
          'if not exist "opencode.json" (\r\n  echo missing opencode cwd config 1>&2\r\n  exit /b 25\r\n)\r\n' +
          'echo {"type":"tool_use","part":{"tool":"odw_run","state":{"status":"completed","output":"[open-dynamic-workflows - tool - EMBEDDED on your OpenCode model]"}}}\r\n',
        'utf8'
      );
    } else {
      const file = join(fakeBin, 'opencode');
      writeFileSync(
        file,
        '#!/bin/sh\n' +
          'if [ "$1" = "--version" ]; then echo 1.2.3; exit 0; fi\n' +
          'if [ -z "$ODW_DAEMON_PORT" ]; then echo missing daemon port >&2; exit 23; fi\n' +
          'if [ -z "$ODW_HOME" ]; then echo missing odw home >&2; exit 24; fi\n' +
          'if [ ! -f opencode.json ]; then echo missing opencode cwd config >&2; exit 25; fi\n' +
          "echo '{\"type\":\"tool_use\",\"part\":{\"tool\":\"odw_run\",\"state\":{\"status\":\"completed\",\"output\":\"[open-dynamic-workflows - tool - EMBEDDED on your OpenCode model]\"}}}'\n",
        'utf8'
      );
      chmodSync(file, 0o755);
    }
    const pathValue = `${fakeBin}${delimiter}${process.env.PATH || ''}`;
    const output = execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'smoke-agent-hosts.mjs'), '--json', '--require-host', 'opencode', '--live-host', 'opencode-embedded'],
      {
        encoding: 'utf8',
        cwd: repoRoot,
        env: { ...process.env, PATH: pathValue, Path: pathValue },
      }
    );
    const report = JSON.parse(output);
    const opencode = report.hosts.find((host) => host.name === 'opencode');
    assert.equal(opencode.status, 'ok');
    assert.equal(opencode.live.ok, true);
    assert.equal(opencode.live.embedded.ok, true);
    assert.match(opencode.live.embedded.output, /EMBEDDED on your OpenCode model/);
  } finally {
    safeRemoveTemp(fakeBin);
  }
});

test('smoke-agent-hosts can run an opt-in zcode live MCP probe', () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'odw-fake-zcode-'));
  try {
    if (process.platform === 'win32') {
      writeFileSync(
        join(fakeBin, 'zcode.cmd'),
        '@echo off\r\n' +
          'if "%1"=="--version" (\r\n  echo 0.15.0\r\n  exit /b 0\r\n)\r\n' +
          'if "%ODW_DAEMON_PORT%"=="" (\r\n  echo missing daemon port 1>&2\r\n  exit /b 23\r\n)\r\n' +
          'if "%ODW_HOME%"=="" (\r\n  echo missing odw home 1>&2\r\n  exit /b 24\r\n)\r\n' +
          'if not exist ".mcp.json" (\r\n  echo missing mcp cwd config 1>&2\r\n  exit /b 25\r\n)\r\n' +
          'echo {"type":"tool_use","part":{"tool":"odw_plan","state":{"status":"completed","output":"plan_fake mapreduce"}}}\r\n' +
          'echo {"type":"text","part":{"text":"plan_fake ready"}}\r\n',
        'utf8'
      );
    } else {
      const file = join(fakeBin, 'zcode');
      writeFileSync(
        file,
        '#!/bin/sh\n' +
          'if [ "$1" = "--version" ]; then echo 0.15.0; exit 0; fi\n' +
          'if [ -z "$ODW_DAEMON_PORT" ]; then echo missing daemon port >&2; exit 23; fi\n' +
          'if [ -z "$ODW_HOME" ]; then echo missing odw home >&2; exit 24; fi\n' +
          'if [ ! -f .mcp.json ]; then echo missing mcp cwd config >&2; exit 25; fi\n' +
          "echo '{\"type\":\"tool_use\",\"part\":{\"tool\":\"odw_plan\",\"state\":{\"status\":\"completed\",\"output\":\"plan_fake mapreduce\"}}}'\n" +
          "echo '{\"type\":\"text\",\"part\":{\"text\":\"plan_fake ready\"}}'\n",
        'utf8'
      );
      chmodSync(file, 0o755);
    }
    const pathValue = `${fakeBin}${delimiter}${process.env.PATH || ''}`;
    const output = execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'smoke-agent-hosts.mjs'), '--json', '--require-host', 'zcode', '--live-host', 'zcode'],
      {
        encoding: 'utf8',
        cwd: repoRoot,
        env: { ...process.env, PATH: pathValue, Path: pathValue },
      }
    );
    const report = JSON.parse(output);
    const zcode = report.hosts.find((host) => host.name === 'zcode');
    assert.equal(zcode.status, 'ok');
    assert.equal(zcode.live.ok, true);
    assert.equal(zcode.live.command, 'zcode-prompt');
    assert.match(zcode.live.output, /odw_plan|plan_fake/);
  } finally {
    safeRemoveTemp(fakeBin);
  }
});

test('smoke-agent-hosts accepts version output from a slow Windows shim', { skip: process.platform !== 'win32' }, () => {
  const fakeBin = mkdtempSync(join(tmpdir(), 'odw slow fake bin '));
  try {
    writeFileSync(
      join(fakeBin, 'opencode.cmd'),
      '@echo off\r\necho 1.2.3\r\nping -n 30 127.0.0.1 >nul\r\n',
      'utf8'
    );
    const pathValue = `${fakeBin}${delimiter}${process.env.PATH || ''}`;
    const output = execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'smoke-agent-hosts.mjs'), '--json', '--require-host', 'opencode'],
      {
        encoding: 'utf8',
        cwd: repoRoot,
        env: {
          ...process.env,
          ODW_HOST_PROBE_TIMEOUT_MS: '1000',
          PATH: pathValue,
          Path: pathValue,
        },
      }
    );
    const report = JSON.parse(output);
    const opencode = report.hosts.find((host) => host.name === 'opencode');
    assert.equal(opencode.status, 'ok');
    assert.equal(opencode.output, '1.2.3');
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
