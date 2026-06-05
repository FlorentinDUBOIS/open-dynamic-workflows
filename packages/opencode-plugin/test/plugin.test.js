import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  OdwPlugin, detectTrigger, createDaemonClient, readUltracode, writeUltracode, resolveDaemonPort,
} = await import('../src/index.js');

const DIR = mkdtempSync(join(tmpdir(), 'odw-plugin-'));
after(() => rmSync(DIR, { recursive: true, force: true }));

// ── trigger (inlined mirror of odw-core) ─────────────────────────────────────

test('plugin trigger: intent fires, mentions do not', () => {
  assert.equal(detectTrigger('run a workflow to audit auth').mode, 'workflow');
  assert.equal(detectTrigger('ultracode fix everything').mode, 'ultracode');
  assert.equal(detectTrigger('explain my git workflow').triggered, false);
});

// ── ultracode state ──────────────────────────────────────────────────────────

test('plugin ultracode state round-trips per project', () => {
  assert.equal(readUltracode(DIR), false);
  writeUltracode(DIR, true);
  assert.equal(readUltracode(DIR), true);
  writeUltracode(DIR, false);
  assert.equal(readUltracode(DIR), false);
});

// ── daemon client + hooks against a stub daemon ──────────────────────────────

function stubDaemon(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const key = `${req.method} ${req.url}`;
        const handler = routes[key];
        if (!handler) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'not_found', message: key } }));
          return;
        }
        const body = handler(raw ? JSON.parse(raw) : undefined);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const SAMPLE_PLAN = {
  planId: 'plan_x', topology: 'hybrid', script: 'module.exports={execute:async()=>1}',
  estimate: { totalAgents: 12, maxConcurrent: 8, tokens: 50000, costUSD: 1.2, minutes: 3 },
  taskGraph: { root: {}, tasks: [] },
};

test('plugin: chat.message rewrites trigger into a daemon-execution directive', async () => {
  const { server, port } = await stubDaemon({
    'GET /health': () => ({ status: 'ok', activeWorkflows: 0, activeAgents: 0, maxConcurrency: 16 }),
    'POST /workflows/plan': () => ({ plan: SAMPLE_PLAN }),
    'POST /workflows/exec': () => ({ workflowId: 'wf_stub123', status: 'running' }),
  });
  process.env.ODW_DAEMON_PORT = String(port);
  try {
    const hooks = await OdwPlugin({ directory: DIR });
    const output = { message: {}, parts: [{ type: 'text', text: 'workflow: audit all endpoints for missing auth' }] };
    await hooks['chat.message']({}, output);
    const text = output.parts[0].text;
    assert.match(text, /wf_stub123/);
    assert.match(text, /daemon ONLINE/);
    assert.match(text, /do NOT redo it yourself/);
  } finally {
    delete process.env.ODW_DAEMON_PORT;
    server.close();
  }
});

test('plugin: chat.message falls back to native-orchestration directive when daemon is down', async () => {
  process.env.ODW_DAEMON_PORT = '59999'; // nothing listening
  try {
    const hooks = await OdwPlugin({ directory: DIR });
    const output = { message: {}, parts: [{ type: 'text', text: 'run a workflow to migrate this repo to TypeScript' }] };
    await hooks['chat.message']({}, output);
    const text = output.parts[0].text;
    assert.match(text, /daemon OFFLINE/);
    assert.match(text, /PLAN FIRST/);
    assert.match(text, /open-dynamic-workflows/);
  } finally {
    delete process.env.ODW_DAEMON_PORT;
  }
});

test('plugin: non-trigger messages pass through untouched', async () => {
  const hooks = await OdwPlugin({ directory: DIR });
  const original = 'what does this function do?';
  const output = { message: {}, parts: [{ type: 'text', text: original }] };
  await hooks['chat.message']({}, output);
  assert.equal(output.parts[0].text, original);
});

test('plugin: tools execute against the daemon (run + status + workflows + ultracode)', async () => {
  const { server, port } = await stubDaemon({
    'GET /health': () => ({ status: 'ok' }),
    'POST /workflows/plan': () => ({ plan: SAMPLE_PLAN }),
    'POST /workflows/exec': () => ({ workflowId: 'wf_tool1', status: 'running' }),
    'GET /workflows/wf_tool1': () => ({
      status: 'running', total_agents: 12, completed_agents: 4, failed_agents: 0, cost_usd: 0.5,
      nodeStats: { completed: 4, running: 2 },
    }),
    'GET /workflows': () => ({
      workflows: [{ workflow_id: 'wf_tool1', status: 'running', completed_agents: 4, total_agents: 12, cost_usd: 0.5, root_prompt: 'x' }],
    }),
  });
  process.env.ODW_DAEMON_PORT = String(port);
  try {
    const hooks = await OdwPlugin({ directory: DIR });
    const context = { directory: DIR, sessionID: 's', messageID: 'm', agent: 'a' };

    const run = await hooks.tool.odw_run.execute({ prompt: 'audit everything' }, context);
    assert.match(run, /wf_tool1 started/);

    const status = await hooks.tool.odw_status.execute({ workflowId: 'wf_tool1' }, context);
    assert.match(status, /"completed": 4/);

    const list = await hooks.tool.odw_workflows.execute({}, context);
    assert.match(list, /wf_tool1/);

    const toggled = await hooks.tool.odw_ultracode.execute({}, context);
    assert.match(toggled, /ON/);
    assert.equal(readUltracode(DIR), true);
    await hooks.tool.odw_ultracode.execute({ enabled: false }, context);
    assert.equal(readUltracode(DIR), false);
  } finally {
    delete process.env.ODW_DAEMON_PORT;
    server.close();
  }
});

test('plugin: resolveDaemonPort honors env override', () => {
  process.env.ODW_DAEMON_PORT = '4242';
  assert.equal(resolveDaemonPort(), 4242);
  delete process.env.ODW_DAEMON_PORT;
  assert.equal(typeof resolveDaemonPort(), 'number');
});

test('plugin: daemon client surfaces structured HTTP errors', async () => {
  const { server, port } = await stubDaemon({});
  try {
    const client = createDaemonClient(port);
    await assert.rejects(() => client.get('wf_missing'), /404/);
  } finally {
    server.close();
  }
});
