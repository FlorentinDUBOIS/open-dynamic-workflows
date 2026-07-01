'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const http = require('node:http');
const Module = require('node:module');

// Minimal 'vscode' stub: the daemon client only touches workspace configuration,
// and getConfiguration().get() returning undefined means env vars win.
const vscodeStub = {
  workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...rest);
};

const { _internal } = require('../extension.js');

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('daemon client attaches the Bearer token on request() and the raw /script fetch', async () => {
  const TOKEN = 'ab'.repeat(32); // 64 hex chars, like the daemon writes
  const home = mkdtempSync(join(tmpdir(), 'odw-vsc-'));
  writeFileSync(join(home, 'daemon.token'), '\ufeff' + TOKEN + '\n', 'utf8'); // BOM + newline must be stripped
  const seen = {};
  const { server, port } = await startStub((req, res) => {
    seen[req.url] = req.headers.authorization;
    if (req.url.endsWith('/script')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('// generated script');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', activeWorkflows: 0 }));
    }
  });
  process.env.ODW_DAEMON_PORT = String(port);
  process.env.ODW_HOME = home;
  const prevToken = process.env.ODW_DAEMON_TOKEN;
  delete process.env.ODW_DAEMON_TOKEN;
  try {
    const client = _internal.createDaemonClient();
    await client.health();
    const script = await client.script('wf_1');
    assert.match(script, /generated script/);
    assert.equal(seen['/health'], `Bearer ${TOKEN}`);
    assert.equal(seen['/workflows/wf_1/script'], `Bearer ${TOKEN}`);
  } finally {
    delete process.env.ODW_DAEMON_PORT;
    delete process.env.ODW_HOME;
    if (prevToken !== undefined) process.env.ODW_DAEMON_TOKEN = prevToken;
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('daemon client surfaces 401 as auth guidance, never as offline', async () => {
  const { server, port } = await startStub((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'daemon requires an auth token — copy it from ~/.odw/daemon.token or set ODW_DAEMON_TOKEN' } }));
  });
  const home = mkdtempSync(join(tmpdir(), 'odw-vsc-')); // empty: no token resolves
  process.env.ODW_DAEMON_PORT = String(port);
  process.env.ODW_HOME = home;
  const prevToken = process.env.ODW_DAEMON_TOKEN;
  delete process.env.ODW_DAEMON_TOKEN;
  try {
    const client = _internal.createDaemonClient();
    // health() must throw the auth error (NOT return null = "offline").
    await assert.rejects(() => client.health(), /requires an auth token/);
    await assert.rejects(() => client.script('wf_1'), /requires an auth token/);
  } finally {
    delete process.env.ODW_DAEMON_PORT;
    delete process.env.ODW_HOME;
    if (prevToken !== undefined) process.env.ODW_DAEMON_TOKEN = prevToken;
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('daemonToken precedence: env beats file; absent file means no token', () => {
  const home = mkdtempSync(join(tmpdir(), 'odw-vsc-'));
  writeFileSync(join(home, 'daemon.token'), 'cd'.repeat(32), 'utf8');
  process.env.ODW_HOME = home;
  const prevToken = process.env.ODW_DAEMON_TOKEN;
  try {
    process.env.ODW_DAEMON_TOKEN = 'ef'.repeat(32);
    assert.equal(_internal.daemonToken(), 'ef'.repeat(32));
    delete process.env.ODW_DAEMON_TOKEN;
    assert.equal(_internal.daemonToken(), 'cd'.repeat(32));
    rmSync(join(home, 'daemon.token'));
    assert.equal(_internal.daemonToken(), null);
  } finally {
    delete process.env.ODW_HOME;
    if (prevToken !== undefined) process.env.ODW_DAEMON_TOKEN = prevToken;
    else delete process.env.ODW_DAEMON_TOKEN;
    rmSync(home, { recursive: true, force: true });
  }
});
