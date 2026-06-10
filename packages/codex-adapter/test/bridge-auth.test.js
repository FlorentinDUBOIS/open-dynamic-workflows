'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const http = require('node:http');

const root = join(__dirname, '..');
const bridge = join(root, 'scripts', 'daemon-bridge.js');
// execFileSync would deadlock here: it blocks this process's event loop, so the
// in-process stub server could never answer the child. Async execFile instead.
const run = promisify(execFile);

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('daemon-bridge attaches the Bearer token from ODW_HOME on GET and POST', async () => {
  const TOKEN = 'ab'.repeat(32); // 64 hex chars, like the daemon writes
  const home = mkdtempSync(join(tmpdir(), 'odw-bridge-'));
  writeFileSync(join(home, 'daemon.token'), '\ufeff' + TOKEN + '\n', 'utf8'); // BOM + newline must be stripped
  const planPath = join(home, 'plan.json');
  writeFileSync(planPath, JSON.stringify({ planId: 'plan_x' }), 'utf8');
  const seen = [];
  const { server, port } = await startStub((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/workflows' ? JSON.stringify({ workflows: [] }) : JSON.stringify({ workflowId: 'wf_auth1' }));
  });
  const env = { ...process.env, ODW_DAEMON_PORT: String(port), ODW_HOME: home };
  delete env.ODW_DAEMON_TOKEN;
  try {
    await run(process.execPath, [bridge, 'list'], { env, timeout: 15000 });
    const { stdout } = await run(process.execPath, [bridge, 'exec', planPath], { env, timeout: 15000 });
    assert.match(stdout, /wf_auth1/);
    assert.deepEqual(seen, [`GET /workflows Bearer ${TOKEN}`, `POST /workflows/exec Bearer ${TOKEN}`]);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('daemon-bridge exits 1 with auth guidance (not "not reachable") on 401', async () => {
  const { server, port } = await startStub((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'daemon requires an auth token — copy it from ~/.odw/daemon.token or set ODW_DAEMON_TOKEN' } }));
  });
  const home = mkdtempSync(join(tmpdir(), 'odw-bridge-')); // empty: no token resolves
  const env = { ...process.env, ODW_DAEMON_PORT: String(port), ODW_HOME: home };
  delete env.ODW_DAEMON_TOKEN;
  try {
    await assert.rejects(
      run(process.execPath, [bridge, 'list'], { env, timeout: 15000 }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(String(error.stderr), /requires an auth token/);
        assert.doesNotMatch(String(error.stderr), /not reachable/);
        return true;
      }
    );
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
