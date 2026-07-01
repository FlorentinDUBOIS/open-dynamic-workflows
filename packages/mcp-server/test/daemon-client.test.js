import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDaemonClient, UNAUTHORIZED_HINT, OFFLINE_HINT } from '../src/daemon-client.js';

const HOME = mkdtempSync(join(tmpdir(), 'odw-mcp-'));
after(() => rmSync(HOME, { recursive: true, force: true }));

// plain hex — never JWT/AKIA/sk_live-shaped strings (CI secrets grep)
const FILE_TOKEN = 'ab'.repeat(32);
const ENV_TOKEN = 'cd'.repeat(32);
const EXPLICIT_TOKEN = 'ef'.repeat(32);

/** stub daemon that records every request's method/url/authorization header */
function stubDaemon(handler = () => ({ ok: true })) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
        const out = handler(req, raw ? JSON.parse(raw) : undefined);
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body ?? out));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

/** an ephemeral port with nothing listening on it */
function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return Promise.resolve(fn()).finally(restore);
}

// ── header attachment ────────────────────────────────────────────────────────

test('client attaches Bearer token from the token file on EVERY request, GETs included', async () => {
  // BOM + trailing newline must be stripped (PowerShell writes both)
  writeFileSync(join(HOME, 'daemon.token'), '\ufeff' + FILE_TOKEN + '\r\n', 'utf8');
  const { server, port, seen } = await stubDaemon(() => ({ body: { workflows: [] } }));
  try {
    await withEnv({ ODW_HOME: HOME, ODW_DAEMON_TOKEN: undefined }, async () => {
      const client = createDaemonClient({ port });
      await client.list();
      await client.health();
      await client.control('wf_1', 'pause');
      assert.equal(seen.length, 3);
      for (const req of seen) assert.equal(req.authorization, `Bearer ${FILE_TOKEN}`);
    });
  } finally {
    server.close();
  }
});

test('client token precedence: explicit > ODW_DAEMON_TOKEN > token file', async () => {
  writeFileSync(join(HOME, 'daemon.token'), FILE_TOKEN, 'utf8');
  const { server, port, seen } = await stubDaemon(() => ({ body: { workflows: [] } }));
  try {
    await withEnv({ ODW_HOME: HOME, ODW_DAEMON_TOKEN: ENV_TOKEN }, async () => {
      await createDaemonClient({ port }).list();
      assert.equal(seen.at(-1).authorization, `Bearer ${ENV_TOKEN}`);
      await createDaemonClient({ port, token: EXPLICIT_TOKEN }).list();
      assert.equal(seen.at(-1).authorization, `Bearer ${EXPLICIT_TOKEN}`);
    });
  } finally {
    server.close();
  }
});

test('client sends no authorization header when no token resolves', async () => {
  const { server, port, seen } = await stubDaemon(() => ({ body: { status: 'ok' } }));
  try {
    await withEnv({ ODW_HOME: join(HOME, 'missing'), ODW_DAEMON_TOKEN: undefined }, async () => {
      await createDaemonClient({ port }).health();
      assert.equal(seen.at(-1).authorization, undefined);
    });
  } finally {
    server.close();
  }
});

// ── 401 vs ECONNREFUSED ──────────────────────────────────────────────────────

test('client surfaces 401 as "auth token" guidance — never "daemon offline"', async () => {
  const { server, port } = await stubDaemon(() => ({
    status: 401,
    body: { error: { code: 'unauthorized', message: UNAUTHORIZED_HINT } },
  }));
  try {
    await withEnv({ ODW_HOME: join(HOME, 'missing'), ODW_DAEMON_TOKEN: undefined }, async () => {
      const client = createDaemonClient({ port });
      await assert.rejects(() => client.list(), (error) => {
        assert.match(error.message, /daemon requires an auth token/);
        assert.doesNotMatch(error.message, /offline/);
        return true;
      });
    });
  } finally {
    server.close();
  }
});

test('client surfaces connection-refused as "daemon offline" with the start hint', async () => {
  const port = await freePort();
  const client = createDaemonClient({ port });
  await assert.rejects(() => client.health(), (error) => {
    assert.equal(error.message, OFFLINE_HINT);
    return true;
  });
});

test('client surfaces non-401 HTTP errors with status + body excerpt', async () => {
  const { server, port } = await stubDaemon(() => ({
    status: 404,
    body: { error: { code: 'not_found', message: 'workflow not found' } },
  }));
  try {
    const client = createDaemonClient({ port });
    await assert.rejects(() => client.get('wf_missing'), /404.*workflow not found/);
  } finally {
    server.close();
  }
});

// ── port resolution precedence ───────────────────────────────────────────────

test('port precedence: explicit > ODW_DAEMON_PORT > config.json > 7345', async () => {
  writeFileSync(join(HOME, 'config.json'), '\ufeff' + JSON.stringify({ daemon: { port: 4321 } }), 'utf8');
  await withEnv({ ODW_HOME: HOME, ODW_DAEMON_PORT: '5555' }, () => {
    assert.equal(createDaemonClient({ port: 6666 }).base, 'http://127.0.0.1:6666');
    assert.equal(createDaemonClient().base, 'http://127.0.0.1:5555');
  });
  await withEnv({ ODW_HOME: HOME, ODW_DAEMON_PORT: undefined }, () => {
    assert.equal(createDaemonClient().base, 'http://127.0.0.1:4321'); // BOM-stripped config read
  });
  await withEnv({ ODW_HOME: join(HOME, 'missing'), ODW_DAEMON_PORT: undefined }, () => {
    assert.equal(createDaemonClient().base, 'http://127.0.0.1:7345');
  });
});

// ── route shapes ─────────────────────────────────────────────────────────────

test('client hits the documented routes with the documented bodies', async () => {
  const bodies = [];
  const { server, port, seen } = await stubDaemon((req, body) => {
    bodies.push(body);
    return { body: { ok: true } };
  });
  try {
    const client = createDaemonClient({ port });
    await client.plan('audit auth', { topology: 'parallel' });
    await client.exec({ script: 's' }, { cwd: '/tmp/x', args: { a: 1 } });
    await client.result('wf_1', { wait: true });
    await client.result('wf_1');
    await client.control('wf_1', 'stop');
    assert.deepEqual(seen.map((r) => `${r.method} ${r.url}`), [
      'POST /workflows/plan',
      'POST /workflows/exec',
      'GET /workflows/wf_1/result?wait',
      'GET /workflows/wf_1/result',
      'POST /workflows/wf_1/ctl',
    ]);
    assert.deepEqual(bodies[0], { prompt: 'audit auth', options: { topology: 'parallel' } });
    assert.deepEqual(bodies[1], { plan: { script: 's' }, cwd: '/tmp/x', args: { a: 1 } });
    assert.deepEqual(bodies[4], { action: 'stop' });
  } finally {
    server.close();
  }
});
