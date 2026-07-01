import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

const HOME = mkdtempSync(join(tmpdir(), 'odw-auth-'));
process.env.ODW_HOME = HOME;
delete process.env.ODW_DAEMON_TOKEN; // resolution order is env → file → generate

const { startDaemon } = await import('../src/index.js');

const UNAUTH_MESSAGE = /copy it from ~\/\.odw\/daemon\.token or set ODW_DAEMON_TOKEN/;

// A script that needs no LLM at all — exec works without a mock provider.
const NOOP_SCRIPT = 'async function execute(){ return { ok: true }; }\nmodule.exports = { execute };';

let daemon;
let base;
let token;
const bearer = (t) => ({ authorization: `Bearer ${t}` });

before(async () => {
  daemon = await startDaemon({
    port: 0,
    dbPath: join(HOME, 'auth.db'),
    logStream: { write() {} },
    configOverrides: { daemon: { maxConcurrency: 2, logLevel: 'error' } },
  });
  base = `http://127.0.0.1:${daemon.port}`;
  token = readFileSync(join(HOME, 'daemon.token'), 'utf8').trim();
});

after(async () => {
  await daemon.close();
  rmSync(HOME, { recursive: true, force: true });
});

test('auth: a 64-hex token file is auto-generated at startup', () => {
  assert.ok(existsSync(join(HOME, 'daemon.token')));
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('auth: GET /health stays open without a token', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});

test('auth: other routes 401 without a token, with the shared error body', async () => {
  const res = await fetch(`${base}/workflows`);
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, 'unauthorized');
  assert.match(body.error.message, UNAUTH_MESSAGE);
});

test('auth: wrong token 401s; the generated token succeeds', async () => {
  const wrong = await fetch(`${base}/workflows`, { headers: bearer('f'.repeat(64)) });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.code, 'unauthorized');

  const right = await fetch(`${base}/workflows`, { headers: bearer(token) });
  assert.equal(right.status, 200);
  assert.ok(Array.isArray((await right.json()).workflows));
});

test('auth: POST routes are covered too', async () => {
  const res = await fetch(`${base}/workflows/plan`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'x' }),
  });
  assert.equal(res.status, 401);
});

test('auth: ws upgrade 401s without a token — BEFORE the workflow-existence check', async () => {
  // Unknown workflow id without a token must yield 401, NOT 404: otherwise
  // unauthenticated callers could use 404-vs-101 as a workflow-ID oracle.
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/wf_does_not_exist`);
  const [error] = await once(ws, 'error');
  assert.match(String(error.message), /401/);
  assert.doesNotMatch(String(error.message), /404/);
});

test('auth: ws upgrade connects with the token on a real workflow', async () => {
  const exec = await fetch(`${base}/workflows/exec`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...bearer(token) },
    body: JSON.stringify({ plan: { script: NOOP_SCRIPT } }),
  });
  assert.equal(exec.status, 202);
  const { workflowId } = await exec.json();

  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/${workflowId}?after=0`, { headers: bearer(token) });
  await once(ws, 'open');
  ws.close();
});

test('auth: ODW_DAEMON_TOKEN takes precedence over the token file (server-side)', async () => {
  process.env.ODW_DAEMON_TOKEN = 'a'.repeat(64);
  const envDaemon = await startDaemon({
    port: 0, dbPath: join(HOME, 'env.db'), logStream: { write() {} },
    configOverrides: { daemon: { maxConcurrency: 2, logLevel: 'error' } },
  });
  delete process.env.ODW_DAEMON_TOKEN;
  try {
    const b = `http://127.0.0.1:${envDaemon.port}`;
    const viaFile = await fetch(`${b}/workflows`, { headers: bearer(token) });
    assert.equal(viaFile.status, 401, 'file token must NOT work when env token is set');
    const viaEnv = await fetch(`${b}/workflows`, { headers: bearer('a'.repeat(64)) });
    assert.equal(viaEnv.status, 200);
  } finally {
    await envDaemon.close();
  }
});

test('auth: mode "none" via configOverrides disables the checks on loopback', async () => {
  const open = await startDaemon({
    port: 0, dbPath: join(HOME, 'none.db'), logStream: { write() {} },
    configOverrides: { daemon: { maxConcurrency: 2, logLevel: 'error' }, auth: { mode: 'none' } },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${open.port}/workflows`);
    assert.equal(res.status, 200);
  } finally {
    await open.close();
  }
});

test('rate limit: exceeding maxMutationsPerWindow returns 429', async () => {
  const limited = await startDaemon({
    port: 0, dbPath: join(HOME, 'rate.db'), logStream: { write() {} },
    configOverrides: {
      daemon: { maxConcurrency: 2, logLevel: 'error' },
      rateLimit: { enabled: true, windowMs: 60000, maxMutationsPerWindow: 2, maxUpgradesPerWindow: 30 },
    },
  });
  try {
    const b = `http://127.0.0.1:${limited.port}`;
    // Bodyless plan posts count toward the window (limiter runs before validation)
    // and fail fast with 400 — no LLM involved.
    const hit = () => fetch(`${b}/workflows/plan`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...bearer(token) },
      body: JSON.stringify({}),
    });
    assert.equal((await hit()).status, 400);
    assert.equal((await hit()).status, 400);
    const third = await hit();
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.equal(body.error.code, 'rate_limited');

    // GETs are never mutation-limited
    const get = await fetch(`${b}/workflows`, { headers: bearer(token) });
    assert.equal(get.status, 200);
  } finally {
    await limited.close();
  }
});
