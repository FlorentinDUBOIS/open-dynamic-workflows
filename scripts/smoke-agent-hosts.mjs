#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const skipHostProbes = args.has('--skip-host-probes');
const requiredHosts = valuesFor('--require-host');
const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const report = {
  ok: false,
  requiredHosts,
  integration: { ok: false },
  daemon: { ok: false },
  doctor: { ok: false },
  hosts: [],
  generatedFiles: [],
};

const tempRoot = mkdtempSync(join(tmpdir(), 'odw-host-smoke-'));
const targetDir = join(tempRoot, 'target');
const home = join(tempRoot, 'home');
let daemon;

try {
  process.env.ODW_HOME = home;
  const { installAgentIntegration } = await import('../packages/daemon/src/integrations.js');
  const { startDaemon } = await import('../packages/daemon/src/index.js');

  installAgentIntegration('all', { targetDir, home, repoRoot });
  report.generatedFiles = [
    join(targetDir, '.mcp.json'),
    join(targetDir, 'AGENTS.md'),
    join(targetDir, '.cursor', 'mcp.json'),
    join(targetDir, '.cursor', 'rules', 'open-dynamic-workflows.mdc'),
    join(targetDir, '.cursor', 'skills', 'odw', 'SKILL.md'),
    join(targetDir, '.cursor', 'skills', 'odw', 'scripts', 'daemon-bridge.js'),
    join(targetDir, '.zed', 'settings.json'),
    join(targetDir, '.agents', 'skills', 'odw', 'SKILL.md'),
    join(targetDir, '.agents', 'skills', 'odw', 'scripts', 'daemon-bridge.js'),
    join(targetDir, '.opencode', 'plugins', 'odw.mjs'),
    join(targetDir, '.opencode', 'commands', 'ultracode.md'),
    join(home, '.codex', 'config.toml'),
    join(home, '.codex', 'plugins', 'odw', '.codex-plugin', 'plugin.json'),
    join(home, '.codex', 'plugins', 'odw', '.mcp.json'),
    join(home, '.codex', 'plugins', 'odw', 'skills', 'odw', 'SKILL.md'),
    join(home, '.codex', 'plugins', 'odw', 'scripts', 'daemon-bridge.js'),
    join(home, '.codex', 'plugins', 'odw', 'skills', 'odw', 'scripts', 'daemon-bridge.js'),
    join(home, '.agents', 'plugins', 'marketplace.json'),
    join(home, '.agents', 'skills', 'odw', 'SKILL.md'),
    join(home, '.kimi-code', 'mcp.json'),
    join(targetDir, '.kimi', 'skills', 'odw', 'SKILL.md'),
    join(targetDir, '.kimi', 'skills', 'odw', 'scripts', 'daemon-bridge.js'),
    join(home, '.gemini', 'settings.json'),
    join(targetDir, 'GEMINI.md'),
    join(targetDir, '.gemini', 'commands', 'odw.toml'),
    join(targetDir, '.gemini', 'commands', 'ultracode.toml'),
    join(home, '.gemini', 'config', 'mcp_config.json'),
    join(home, '.gemini', 'antigravity-cli', 'mcp_config.json'),
    join(home, '.gemini', 'skills', 'odw', 'SKILL.md'),
    join(home, '.gemini', 'antigravity', 'global_workflows', 'odw-run.md'),
    join(targetDir, '.agents', 'mcp_config.json'),
    join(home, '.vscode', 'extensions', 'open-dynamic-workflows.odw-vscode-0.1.0', 'package.json'),
    join(home, '.openclaw', 'skills', 'open-dynamic-workflows', 'SKILL.md'),
  ];
  const missing = report.generatedFiles.filter((file) => !existsSync(file));
  report.integration = { ok: missing.length === 0, targetDir, home, missing };

  daemon = await startDaemon({
    port: 0,
    configOverrides: { auth: { mode: 'none' } },
    logStream: { write() {} },
  });
  report.daemon = { ok: true, port: daemon.port };

  const doctor = await execFileAsync(
    process.execPath,
    [
      join(repoRoot, 'packages', 'daemon', 'src', 'cli.js'),
      'doctor',
      'all',
      '--target',
      targetDir,
      '--home',
      home,
      '--repo',
      repoRoot,
      '--port',
      String(daemon.port),
    ],
    { encoding: 'utf8', env: { ...process.env, ODW_HOME: home, ODW_DAEMON_PORT: String(daemon.port) } }
  );
  report.doctor = { ok: /all integration .*ready/.test(doctor.stdout) && /daemon running/.test(doctor.stdout), stdout: doctor.stdout };

  if (!skipHostProbes) {
    report.hosts = await probeHosts();
  }

  const missingRequired = requiredHosts.filter((name) => !report.hosts.some((host) => host.name === name && host.status === 'ok'));
  if (missingRequired.length) {
    report.error = `required host evidence missing: ${missingRequired.join(', ')}`;
  }

  report.ok = report.integration.ok && report.daemon.ok && report.doctor.ok && missingRequired.length === 0;
  finish(report.ok ? 0 : 1);
} catch (error) {
  report.error = String(error?.stack || error?.message || error);
  finish(1);
} finally {
  if (daemon) await daemon.close();
  safeRemove(tempRoot);
}

async function probeHosts() {
  const probes = [
    { name: 'codex', command: 'codex', args: ['--help'] },
    { name: 'opencode', command: 'opencode', args: ['--version'] },
    { name: 'cursor', command: 'cursor', args: ['--version'] },
    { name: 'kimi', command: 'kimi', args: ['--version'] },
    { name: 'gemini', command: 'gemini', args: ['--version'] },
    { name: 'zed', command: 'zed', args: ['--version'] },
    { name: 'zcode', command: 'zcode', args: ['--version'] },
    { name: 'vscode', command: 'code', args: ['--version'] },
  ];
  const results = [];
  for (const probe of probes) {
    const found = await commandPath(probe.command);
    if (!found) {
      results.push({ name: probe.name, status: 'skipped', reason: 'command not found' });
      continue;
    }
    try {
      const { stdout, stderr } = await runFoundCommand(found, probe.args);
      results.push({ name: probe.name, status: 'ok', command: found, output: firstLine(stdout || stderr) });
    } catch (error) {
      results.push({
        name: probe.name,
        status: 'found_unusable',
        command: found,
        reason: firstLine(error.stderr || error.stdout || error.message),
      });
    }
  }
  return results;
}

function runFoundCommand(found, args) {
  if (process.platform === 'win32' && /\.cmd$/i.test(found)) {
    const commandLine = [quoteCmdArg(found), ...args.map(quoteCmdArg)].join(' ');
    return execFileAsync('cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsVerbatimArguments: true,
    });
  }
  if (process.platform === 'win32' && /\.ps1$/i.test(found)) {
    return execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', found, ...args],
      { encoding: 'utf8', timeout: 15_000 }
    );
  }
  return execFileAsync(found, args, { encoding: 'utf8', timeout: 15_000 });
}

function quoteCmdArg(value) {
  const text = String(value);
  if (!/[\s&()^=;!'+,`~[\]{}]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function commandPath(command) {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'command';
  const lookupArgs = process.platform === 'win32' ? [command] : ['-v', command];
  try {
    const { stdout } = await execFileAsync(lookup, lookupArgs, { encoding: 'utf8', timeout: 5000 });
    const candidates = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (process.platform === 'win32') {
      return candidates.find((path) => /\.(cmd|exe|ps1)$/i.test(path)) ?? candidates[0] ?? null;
    }
    return candidates[0] || null;
  } catch {
    return null;
  }
}

function firstLine(text) {
  return String(text ?? '').trim().split(/\r?\n/)[0]?.slice(0, 240) || '';
}

function valuesFor(flag) {
  const raw = process.argv.slice(2);
  const values = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === flag && raw[i + 1] && !raw[i + 1].startsWith('--')) {
      values.push(raw[i + 1]);
      i++;
    } else if (raw[i].startsWith(`${flag}=`)) {
      values.push(raw[i].slice(flag.length + 1));
    }
  }
  return values.flatMap((value) => value.split(',').map((item) => item.trim()).filter(Boolean));
}

function finish(code) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printHuman(report);
  }
  process.exitCode = code;
}

function printHuman(data) {
  console.log(`ODW host smoke: ${data.ok ? 'ready' : 'needs attention'}`);
  console.log(`  integration files: ${data.integration.ok ? 'ready' : `missing ${data.integration.missing?.length ?? '?'}`}`);
  console.log(`  daemon: ${data.daemon.ok ? `running on ${data.daemon.port}` : 'not running'}`);
  console.log(`  doctor: ${data.doctor.ok ? 'ready' : 'failed'}`);
  for (const host of data.hosts) {
    console.log(`  ${host.name}: ${host.status}${host.reason ? ` (${host.reason})` : ''}`);
  }
  if (data.error) console.log(`  error: ${data.error}`);
}

function safeRemove(path) {
  const resolvedTemp = resolve(path);
  const resolvedBase = resolve(tmpdir());
  if (!resolvedTemp.toLowerCase().startsWith(resolvedBase.toLowerCase())) {
    throw new Error(`refusing cleanup outside temp: ${resolvedTemp}`);
  }
  rmSync(path, { recursive: true, force: true });
}
