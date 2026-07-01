import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
        const body = handler(raw ? JSON.parse(raw) : undefined, req);
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

function mockHostClient() {
  const prompts = [];
  const deleted = [];
  let seq = 0;
  return {
    prompts,
    deleted,
    session: {
      create: async () => ({ id: `host-${++seq}` }),
      prompt: async ({ body }) => {
        const prompt = body.parts[0].text;
        prompts.push(prompt);
        let text;
        if (/Enumerate the concrete targets/.test(prompt)) text = '{"items":["a","b","c","d","e"]}';
        else if (/Find false positives|Challenge the severity|What is MISSING/.test(prompt)) text = '{"approved":true,"confidence":0.9,"critique":"","rejectedItems":[]}';
        else if (/Merge verified results/.test(prompt)) text = '{"summary":"done","details":[]}';
        else text = '{"findings":[],"confidence":0.9}';
        return { parts: [{ type: 'text', text }] };
      },
      delete: async ({ path }) => { deleted.push(path.id); },
    },
  };
}

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
  const planBodies = [];
  const { server, port } = await stubDaemon({
    'GET /health': () => ({ status: 'ok' }),
    'POST /workflows/plan': (body) => { planBodies.push(body); return { plan: SAMPLE_PLAN }; },
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

    const run = await hooks.tool.odw_run.execute({ prompt: 'audit everything', maxAgents: 6 }, context);
    assert.match(run, /wf_tool1 started/);
    assert.equal(planBodies[0].options.maxAgents, 6);

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

test('plugin: odw_run tool prefers embedded OpenCode model and honors maxAgents', async () => {
  const client = mockHostClient();
  const hooks = await OdwPlugin({ directory: DIR, client });
  const out = await hooks.tool.odw_run.execute(
    { prompt: 'workflow: audit every file in src for security bugs', maxAgents: 6 },
    { directory: DIR }
  );
  assert.match(out, /EMBEDDED on your OpenCode model/);
  assert.match(out, /~6 agents/);
  assert.equal(client.prompts.length, 6, '1 discovery + 1 capped work item + 3 critics + 1 synthesis');
  assert.equal(client.deleted.length, 6, 'embedded child sessions are cleaned up');
});

test('plugin: embedded OpenCode runs default to a twenty-agent safety cap', async () => {
  const client = mockHostClient();
  const hooks = await OdwPlugin({ directory: DIR, client });
  const out = await hooks.tool.odw_run.execute(
    { prompt: 'workflow: audit every file in src for security bugs' },
    { directory: DIR }
  );
  assert.match(out, /EMBEDDED on your OpenCode model/);
  assert.match(out, /~20 agents/);
});

// ── bearer-token auth ────────────────────────────────────────────────────────

test('plugin: requests attach the Bearer token from ODW_HOME daemon.token on GET and POST', async () => {
  const TOKEN = 'ab'.repeat(32); // 64 hex chars, like the daemon writes
  const home = mkdtempSync(join(tmpdir(), 'odw-auth-'));
  writeFileSync(join(home, 'daemon.token'), '\ufeff' + TOKEN + '\n', 'utf8'); // BOM + newline must be stripped
  const seen = [];
  const { server, port } = await stubDaemon({
    'GET /health': (_body, req) => { seen.push(req.headers.authorization); return { status: 'ok' }; },
    'POST /workflows/plan': (_body, req) => { seen.push(req.headers.authorization); return { plan: SAMPLE_PLAN }; },
  });
  process.env.ODW_HOME = home;
  const prevToken = process.env.ODW_DAEMON_TOKEN;
  delete process.env.ODW_DAEMON_TOKEN;
  try {
    const client = createDaemonClient(port);
    await client.health();
    await client.plan('audit auth');
    assert.deepEqual(seen, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  } finally {
    delete process.env.ODW_HOME;
    if (prevToken !== undefined) process.env.ODW_DAEMON_TOKEN = prevToken;
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('plugin: ODW_DAEMON_TOKEN env wins over the token file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'odw-auth-'));
  writeFileSync(join(home, 'daemon.token'), 'cd'.repeat(32), 'utf8');
  const seen = [];
  const { server, port } = await stubDaemon({
    'GET /health': (_body, req) => { seen.push(req.headers.authorization); return { status: 'ok' }; },
  });
  process.env.ODW_HOME = home;
  const prevToken = process.env.ODW_DAEMON_TOKEN;
  process.env.ODW_DAEMON_TOKEN = 'ef'.repeat(32);
  try {
    await createDaemonClient(port).health();
    assert.deepEqual(seen, [`Bearer ${'ef'.repeat(32)}`]);
  } finally {
    delete process.env.ODW_HOME;
    if (prevToken !== undefined) process.env.ODW_DAEMON_TOKEN = prevToken;
    else delete process.env.ODW_DAEMON_TOKEN;
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('plugin: 401 surfaces auth guidance, never "daemon offline"', async () => {
  // 401-everything stub with the daemon's contract body.
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'daemon requires an auth token — copy it from ~/.odw/daemon.token or set ODW_DAEMON_TOKEN' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ODW_DAEMON_PORT = String(server.address().port);
  try {
    const hooks = await OdwPlugin({ directory: DIR });

    const out = await hooks.tool.odw_workflows.execute({}, { directory: DIR });
    assert.match(out, /requires an auth token/);
    assert.doesNotMatch(out, /offline/i);

    const output = { message: {}, parts: [{ type: 'text', text: 'run a workflow to audit auth' }] };
    await hooks['chat.message']({}, output);
    assert.match(output.parts[0].text, /daemon UNAUTHORIZED/);
    assert.match(output.parts[0].text, /requires an auth token/);
    assert.doesNotMatch(output.parts[0].text, /daemon OFFLINE/);
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
