#!/usr/bin/env node
import { execFile } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  workflow: { ok: false },
  mcp: { ok: false },
  hosts: [],
  generatedFiles: [],
};

const tempRoot = mkdtempSync(join(tmpdir(), 'odw-host-smoke-'));
const targetDir = join(tempRoot, 'target');
const home = join(tempRoot, 'home');
let daemon;
let mockProvider;

try {
  process.env.ODW_HOME = home;
  const { doctorAgentIntegration, installAgentIntegration } = await import('../packages/daemon/src/integrations.js');
  const { startDaemon } = await import('../packages/daemon/src/index.js');
  const { TOOL_DEFINITIONS, createToolHandlers } = await import('../packages/mcp-server/src/tools.js');
  const { createDaemonClient } = await import('../packages/mcp-server/src/daemon-client.js');

  installAgentIntegration('all', { targetDir, home, repoRoot });
  const integrationDoctor = doctorAgentIntegration('all', { targetDir, home, repoRoot });
  report.generatedFiles = [...new Set(integrationDoctor.checks.map((check) => check.path).filter(Boolean))];
  const missing = integrationDoctor.checks
    .filter((check) => !check.ok)
    .map(({ label, path, message }) => ({ label, path, message }));
  const agentInstructionsPath = join(targetDir, 'AGENTS.md');
  const agentInstructionsText = existsSync(agentInstructionsPath) ? readFileSync(agentInstructionsPath, 'utf8') : '';
  report.integration = {
    ok: integrationDoctor.ok,
    targetDir,
    home,
    missing,
    agentInstructions: {
      path: agentInstructionsPath,
      combinedHostAudience: agentInstructionsText.includes('generic MCP hosts, Kimi Code, Zed, and zcode-compatible agents'),
    },
  };

  mockProvider = await startMockProvider();
  daemon = await startDaemon({
    port: 0,
    configOverrides: {
      auth: { mode: 'none' },
      baseURLs: { default: mockProvider.url },
      models: { planning: 'mock-planner', default: 'mock-model', fallback: 'mock-model' },
      daemon: { maxConcurrency: 4 },
    },
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
      '--json',
    ],
    { encoding: 'utf8', env: { ...process.env, ODW_HOME: home, ODW_DAEMON_PORT: String(daemon.port) } }
  );
  const doctorReport = JSON.parse(doctor.stdout);
  report.doctor = doctorReport;
  report.workflow = await runLiveWorkflow({ port: daemon.port, cwd: targetDir, mockProvider });
  report.mcp = await runMcpBridge({
    port: daemon.port,
    cwd: targetDir,
    toolDefinitions: TOOL_DEFINITIONS,
    createToolHandlers,
    createDaemonClient,
  });

  if (!skipHostProbes) {
    report.hosts = await probeHosts();
  }

  const missingRequired = requiredHosts.filter((name) => !report.hosts.some((host) => host.name === name && host.status === 'ok'));
  if (missingRequired.length) {
    report.error = `required host evidence missing: ${missingRequired.join(', ')}`;
  }

  report.ok = report.integration.ok && report.daemon.ok && report.doctor.ok && report.workflow.ok && report.mcp.ok && missingRequired.length === 0;
  finish(report.ok ? 0 : 1);
} catch (error) {
  report.error = String(error?.stack || error?.message || error);
  finish(1);
} finally {
  if (daemon) await daemon.close();
  if (mockProvider) await mockProvider.close();
  safeRemove(tempRoot);
}

async function runLiveWorkflow({ port, cwd, mockProvider }) {
  const base = `http://127.0.0.1:${port}`;
  const planRes = await fetch(`${base}/workflows/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'workflow: audit alpha, beta, and gamma for security issues with verification',
      options: { maxAgents: 6 },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!planRes.ok) throw new Error(`live workflow plan failed: ${await planRes.text()}`);
  const { plan } = await planRes.json();
  const execRes = await fetch(`${base}/workflows/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan, cwd }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!execRes.ok) throw new Error(`live workflow exec failed: ${await execRes.text()}`);
  const { workflowId } = await execRes.json();
  const resultRes = await fetch(`${base}/workflows/${workflowId}/result?wait`, { signal: AbortSignal.timeout(60_000) });
  if (!resultRes.ok) throw new Error(`live workflow result failed: ${await resultRes.text()}`);
  const body = await resultRes.json();
  return {
    ok: body.status === 'completed',
    workflowId,
    status: body.status,
    plan: {
      topology: plan.topology,
      totalAgents: plan.estimate?.totalAgents,
      hasVerification: plan.hasVerification === true,
    },
    result: body.result,
    mockCalls: mockProvider.calls.length,
  };
}

async function runMcpBridge({ port, cwd, toolDefinitions, createToolHandlers, createDaemonClient }) {
  const handlers = createToolHandlers(
    createDaemonClient({ port }),
    { pollIntervalMs: 50, pollCapMs: 30_000 }
  );
  const health = await handlers.odw_health({});
  const run = await handlers.odw_run({
    prompt: 'workflow: inspect two targets with verification through the MCP bridge',
    cwd,
    maxAgents: 6,
    wait: true,
  });
  const parsedRun = parseMcpJson(run);
  return {
    ok: !health.isError && !run.isError && parsedRun.status === 'completed',
    tools: toolDefinitions.map((tool) => tool.name),
    health: mcpText(health),
    run: {
      workflowId: parsedRun.workflowId,
      status: parsedRun.status,
      result: parsedRun.result,
    },
  };
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
    return execHostProbe('cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      encoding: 'utf8',
      timeout: hostProbeTimeoutMs(),
      windowsVerbatimArguments: true,
    });
  }
  if (process.platform === 'win32' && /\.ps1$/i.test(found)) {
    return execHostProbe(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', found, ...args],
      { encoding: 'utf8', timeout: hostProbeTimeoutMs() }
    );
  }
  return execHostProbe(found, args, { encoding: 'utf8', timeout: hostProbeTimeoutMs() });
}

async function execHostProbe(command, args, options) {
  try {
    return await execFileAsync(command, args, options);
  } catch (error) {
    if (error.killed && firstLine(error.stdout || error.stderr)) {
      return { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
    throw error;
  }
}

function hostProbeTimeoutMs() {
  const value = Number(process.env.ODW_HOST_PROBE_TIMEOUT_MS);
  if (Number.isFinite(value) && value > 0) return value;
  return 45_000;
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

function mcpText(response) {
  return String(response?.content?.[0]?.text ?? '');
}

function parseMcpJson(response) {
  const text = mcpText(response);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`MCP response was not JSON (${error.message}): ${text.slice(0, 300)}`);
  }
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
  console.log(`  workflow: ${data.workflow.ok ? `${data.workflow.status} (${data.workflow.workflowId})` : 'failed'}`);
  console.log(`  mcp bridge: ${data.mcp.ok ? `${data.mcp.run?.status} (${data.mcp.run?.workflowId})` : 'failed'}`);
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

async function startMockProvider() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* tolerate malformed requests so failures stay in the daemon path */
      }
      const prompt = body.messages?.filter((m) => m.role === 'user').map((m) => m.content).join('\n') ?? '';
      calls.push({ model: body.model, prompt });
      const content = JSON.stringify(mockOutput(prompt));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'odw-smoke-mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
        model: body.model,
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
  };
}

function mockOutput(prompt) {
  const instruction = String(prompt).split(' Context: ')[0].split(' Findings to review: ')[0];
  if (/Merge verified results|final deliverable/i.test(instruction)) {
    return { summary: 'mock synthesis of all results', details: ['detail-1', 'detail-2'] };
  }
  if (/Findings to review:/.test(prompt)) {
    return { approved: true, confidence: 0.95, critique: 'mock critique: looks right', rejectedItems: [] };
  }
  if (/Enumerate|enumerate the concrete targets/i.test(instruction)) {
    return { items: ['alpha.js', 'beta.js', 'gamma.js'] };
  }
  if (/Analyze ONE|Apply the requested change|inspect|audit/i.test(instruction)) {
    return { findings: [{ line: 1, severity: 'low', description: 'mock finding' }], confidence: 0.9, changed: true, summary: 'mock change' };
  }
  return { result: 'ok' };
}
