#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const args = new Set(process.argv.slice(2));
const json = args.has('--json');
const skipHostProbes = args.has('--skip-host-probes');
const requiredHosts = valuesFor('--require-host');
const liveHosts = valuesFor('--live-host');
const repoRoot = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const report = {
  ok: false,
  requiredHosts,
  liveHosts,
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

  if (wantsLiveHost('opencode')) {
    installOpenCodeSmokeConfig({ targetDir, mockProvider });
  }

  if (!skipHostProbes) {
    report.hosts = await probeHosts({ targetDir, home, port: daemon.port, mockProvider });
  }

  const missingRequired = requiredHosts.filter((name) => !report.hosts.some((host) => host.name === name && host.status === 'ok'));
  const missingLive = liveHosts.filter((name) => !report.hosts.some((host) => host.name === name && host.live?.ok));
  if (missingRequired.length) {
    report.error = `required host evidence missing: ${missingRequired.join(', ')}`;
  } else if (missingLive.length) {
    report.error = `required live host evidence missing: ${missingLive.join(', ')}`;
  }

  report.ok = report.integration.ok && report.daemon.ok && report.doctor.ok && report.workflow.ok && report.mcp.ok && missingRequired.length === 0 && missingLive.length === 0;
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

async function probeHosts({ targetDir, home, port, mockProvider }) {
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
      const result = { name: probe.name, status: 'ok', command: found, output: firstLine(stdout || stderr) };
      if (wantsLiveHost(probe.name)) {
        result.live = await runLiveHostProbe(probe.name, found, { targetDir, home, port, mockProvider });
      }
      results.push(result);
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

function wantsLiveHost(name) {
  return liveHosts.includes(name) || liveHosts.includes('all');
}

async function runLiveHostProbe(name, found, { targetDir, home, port, mockProvider }) {
  const mockCallsBefore = mockProvider?.calls.length ?? 0;
  try {
    if (name !== 'opencode') {
      return { ok: false, reason: `no live probe implemented for ${name}` };
    }
    const env = { ...process.env };
    if (home) env.ODW_HOME = home;
    if (port) env.ODW_DAEMON_PORT = String(port);
    env.OPENAI_API_KEY = env.OPENAI_API_KEY || 'odw-smoke';
    const { stdout, stderr } = await runFoundCommand(found, [
      'run',
      '--format',
      'json',
      '--model',
      'openai/odw-smoke-model',
      '--dir',
      targetDir,
      'Use the odw_workflows tool to list workflows known to the local daemon, then answer with one short sentence.',
    ], { cwd: targetDir, env, timeout: liveHostProbeTimeoutMs() });
    const text = `${stdout ?? ''}\n${stderr ?? ''}`;
    const output = summarizeJsonLines(text);
    if (!/odw_workflows/.test(text)) {
      return {
        ok: false,
        command: 'tool-prompt',
        output,
        mockCalls: (mockProvider?.calls.length ?? mockCallsBefore) - mockCallsBefore,
        reason: 'odw_workflows tool was not called',
      };
    }
    return {
      ok: true,
      command: 'tool-prompt',
      output,
      mockCalls: (mockProvider?.calls.length ?? mockCallsBefore) - mockCallsBefore,
    };
  } catch (error) {
    return {
      ok: false,
      command: name === 'opencode' ? 'tool-prompt' : undefined,
      code: error.code ?? error.signal,
      output: summarizeJsonLines(`${error.stdout ?? ''}\n${error.stderr ?? ''}`),
      mockCalls: (mockProvider?.calls.length ?? mockCallsBefore) - mockCallsBefore,
      mockCallModels: (mockProvider?.calls ?? []).slice(mockCallsBefore).map((call) => ({
        model: call.model,
        tools: call.tools,
      })),
      reason: firstLine(error.stderr || error.stdout || error.message),
    };
  }
}

function runFoundCommand(found, args, options = {}) {
  if (process.platform === 'win32' && /\.cmd$/i.test(found)) {
    const hasFreeTextArg = args.some((arg) => /\s/.test(String(arg)));
    if (hasFreeTextArg && !/\s/.test(found)) {
      return spawnShellHostProbe(found, args, options);
    }
    const commandLine = [quoteCmdArg(found), ...args.map(quoteCmdArg)].join(' ');
    return execHostProbe('cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
      encoding: 'utf8',
      timeout: hostProbeTimeoutMs(),
      windowsVerbatimArguments: true,
      ...options,
    });
  }
  if (process.platform === 'win32' && /\.ps1$/i.test(found)) {
    return execHostProbe(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', found, ...args],
      { encoding: 'utf8', timeout: hostProbeTimeoutMs(), ...options }
    );
  }
  return execHostProbe(found, args, { encoding: 'utf8', timeout: hostProbeTimeoutMs(), ...options });
}

function installOpenCodeSmokeConfig({ targetDir, mockProvider }) {
  const path = join(targetDir, 'opencode.json');
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const plugins = Array.isArray(current.plugin) ? current.plugin.filter((entry) => entry !== './.opencode/plugins/odw.mjs') : [];
  plugins.push('./.opencode/plugins/odw.mjs');
  current.plugin = plugins;
  current.model = 'openai/odw-smoke-model';
  current.small_model = 'openai/odw-smoke-model';
  current.provider = {
    ...current.provider,
    openai: {
      name: 'ODW Smoke Mock',
      options: {
        baseURL: mockProvider.url,
      },
      models: {
        'odw-smoke-model': {
          name: 'ODW Smoke Mock Model',
          limit: {
            context: 128000,
            output: 32000,
          },
        },
      },
    },
  };
  writeFileSync(path, `${JSON.stringify({
    ...current,
    $schema: 'https://opencode.ai/config.json',
  }, null, 2)}\n`, 'utf8');
  return path;
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

function spawnShellHostProbe(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const commandLine = [command, ...args.map(quoteCmdArg)].join(' ');
    const child = spawn(commandLine, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      windowsHide: true,
    });
    const maxBuffer = options.maxBuffer ?? 10 * 1024 * 1024;
    const append = (current, chunk) => (current.length >= maxBuffer ? current : (current + chunk.toString()).slice(0, maxBuffer));
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeout ?? hostProbeTimeoutMs());
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || (timedOut && firstLine(stdout || stderr))) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed: ${command} ${args.join(' ')}`);
      error.code = code ?? signal;
      error.signal = signal;
      error.killed = timedOut;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function hostProbeTimeoutMs() {
  const value = Number(process.env.ODW_HOST_PROBE_TIMEOUT_MS);
  if (Number.isFinite(value) && value > 0) return value;
  return 45_000;
}

function liveHostProbeTimeoutMs() {
  const value = Number(process.env.ODW_LIVE_HOST_PROBE_TIMEOUT_MS);
  if (Number.isFinite(value) && value > 0) return value;
  return 30_000;
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

function summarizeJsonLines(text) {
  const snippets = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      const part = event.part ?? {};
      if (part.tool) snippets.push(`${part.tool}: ${part.state?.status ?? 'called'} ${part.state?.output ? firstLine(part.state.output) : ''}`.trim());
      else if (part.text) snippets.push(firstLine(part.text));
    } catch {
      snippets.push(firstLine(trimmed));
    }
    if (snippets.length >= 3) break;
  }
  return snippets.join(' | ').slice(0, 500);
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
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`odw host smoke: warning: could not remove temp dir ${resolvedTemp}: ${message}\n`);
  }
}

async function startMockProvider() {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: 'odw-smoke-model', object: 'model', owned_by: 'odw-smoke' }],
      }));
      return;
    }

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
      const prompt = promptText(body);
      calls.push({ model: body.model, prompt, tools: body.tools?.map((tool) => tool.function?.name ?? tool.name).filter(Boolean) ?? [] });
      if (isOpenCodeSmokeRequest(body)) {
        respondToOpenCodeSmoke(req, res, body);
        return;
      }
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

function isOpenCodeSmokeRequest(body) {
  return body.model === 'odw-smoke-model'
    || body.model === 'odw-smoke/odw-smoke-model'
    || body.model === 'openai/odw-smoke-model';
}

function promptText(body) {
  if (body.messages) {
    return body.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content)).join('\n');
  }
  if (body.input) return contentText(body.input);
  return '';
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return contentText(value.text ?? value.content ?? value.output ?? '');
  return '';
}

function respondToOpenCodeSmoke(req, res, body) {
  if (req.url?.endsWith('/responses')) {
    return respondToOpenCodeResponsesSmoke(res, body);
  }

  const tools = toolNames(body);
  const hasWorkflowTool = tools.includes('odw_workflows');
  const hasToolResult = body.messages?.some((message) => message.role === 'tool');
  if (body.stream) {
    return hasWorkflowTool && !hasToolResult
      ? writeOpenAiToolCallStream(res, body.model)
      : writeOpenAiTextStream(res, body.model, hasToolResult ? 'ODW live smoke saw odw_workflows complete.' : 'ODW workflows smoke');
  }

  if (hasWorkflowTool && !hasToolResult) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-odw-smoke',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_odw_workflows',
            type: 'function',
            function: { name: 'odw_workflows', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      model: body.model,
    }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-odw-smoke',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: hasToolResult ? 'ODW live smoke saw odw_workflows complete.' : 'ODW workflows smoke',
      },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
    model: body.model,
  }));
}

function toolNames(body) {
  return body.tools?.map((tool) => tool.function?.name ?? tool.name).filter(Boolean) ?? [];
}

function respondToOpenCodeResponsesSmoke(res, body) {
  const tools = toolNames(body);
  const hasWorkflowTool = tools.includes('odw_workflows');
  const hasToolResult = body.input?.some((item) => item.type === 'function_call_output' || item.role === 'tool');
  if (body.stream) {
    return hasWorkflowTool && !hasToolResult
      ? writeResponsesToolCallStream(res, body.model)
      : writeResponsesTextStream(res, body.model, hasToolResult ? 'ODW live smoke saw odw_workflows complete.' : 'ODW workflows smoke');
  }

  if (hasWorkflowTool && !hasToolResult) {
    writeJsonResponse(res, responsePayload(body.model, [responsesFunctionItem()]));
    return;
  }
  writeJsonResponse(res, responsePayload(body.model, [responsesTextItem(hasToolResult ? 'ODW live smoke saw odw_workflows complete.' : 'ODW workflows smoke')]));
}

function writeResponsesToolCallStream(res, model) {
  const item = responsesFunctionItem();
  writeSseEvents(res, [
    { type: 'response.created', response: responsePayload(model, []) },
    { type: 'response.in_progress', response: responsePayload(model, []) },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{}' },
    { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: '{}' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: responsePayload(model, [item]) },
  ]);
}

function writeResponsesTextStream(res, model, text) {
  const item = responsesTextItem(text);
  const partialItem = { ...item, status: 'in_progress', content: [] };
  const contentPart = { type: 'output_text', text: '', annotations: [] };
  writeSseEvents(res, [
    { type: 'response.created', response: responsePayload(model, []) },
    { type: 'response.in_progress', response: responsePayload(model, []) },
    { type: 'response.output_item.added', output_index: 0, item: partialItem },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: contentPart },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: responsePayload(model, [item]) },
  ]);
}

function responsesFunctionItem() {
  return {
    id: 'fc_odw_workflows',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_odw_workflows',
    name: 'odw_workflows',
    arguments: '{}',
  };
}

function responsesTextItem(text) {
  return {
    id: 'msg_odw_smoke',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function responsePayload(model, output) {
  return {
    id: 'resp_odw_smoke',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    usage: {
      input_tokens: 30,
      output_tokens: 10,
      total_tokens: 40,
    },
  };
}

function writeJsonResponse(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function writeOpenAiToolCallStream(res, model) {
  writeOpenAiStream(res, [
    openAiChunk(model, { role: 'assistant' }),
    openAiChunk(model, {
      tool_calls: [{
        index: 0,
        id: 'call_odw_workflows',
        type: 'function',
        function: { name: 'odw_workflows', arguments: '' },
      }],
    }),
    openAiChunk(model, {
      tool_calls: [{
        index: 0,
        function: { arguments: '{}' },
      }],
    }),
    openAiChunk(model, {}, 'tool_calls'),
  ]);
}

function writeOpenAiTextStream(res, model, text) {
  writeOpenAiStream(res, [
    openAiChunk(model, { role: 'assistant' }),
    openAiChunk(model, { content: text }),
    openAiChunk(model, {}, 'stop'),
  ]);
}

function writeOpenAiStream(res, chunks) {
  writeSseEvents(res, chunks);
}

function writeSseEvents(res, chunks) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

function openAiChunk(model, delta, finishReason = null) {
  return {
    id: 'chatcmpl-odw-smoke',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
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
