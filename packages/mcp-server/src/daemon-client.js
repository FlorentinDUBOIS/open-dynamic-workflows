/**
 * HTTP client for the local odw daemon. Deliberately SDK-free (node builtins +
 * fetch only) so the test suite runs without npm install — src/index.js is the
 * ONLY file in this package that imports the MCP SDK.
 *
 * Auth: bearer token from explicit option → ODW_DAEMON_TOKEN → ~/.odw/daemon.token,
 * resolved lazily PER REQUEST (the token file may appear after the MCP server
 * starts). Token values are never logged or echoed.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const UNAUTHORIZED_HINT =
  'daemon requires an auth token — copy it from ~/.odw/daemon.token or set ODW_DAEMON_TOKEN';
export const OFFLINE_HINT = 'daemon offline — start it with: odw-daemon start';

function odwHome() {
  return process.env.ODW_HOME || join(homedir(), '.odw');
}

// Strip a UTF-8 BOM if present — editors and PowerShell on Windows often write
// one (same precedent as daemon/src/config.js).
function deBom(raw) {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function resolvePort(explicit) {
  if (explicit) return Number(explicit);
  if (process.env.ODW_DAEMON_PORT) {
    const fromEnv = Number(process.env.ODW_DAEMON_PORT);
    if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  }
  try {
    const config = JSON.parse(deBom(readFileSync(join(odwHome(), 'config.json'), 'utf8')));
    if (config?.daemon?.port) return Number(config.daemon.port);
  } catch {
    /* default */
  }
  return 7345;
}

function resolveToken(explicit) {
  if (explicit) return explicit;
  if (process.env.ODW_DAEMON_TOKEN) return process.env.ODW_DAEMON_TOKEN;
  try {
    return deBom(readFileSync(join(odwHome(), 'daemon.token'), 'utf8')).trim() || undefined;
  } catch {
    return undefined; // absent/unreadable file => behave as "no token"
  }
}

function isConnRefused(error) {
  const cause = error?.cause;
  return (
    error?.code === 'ECONNREFUSED' ||
    cause?.code === 'ECONNREFUSED' ||
    (Array.isArray(cause?.errors) && cause.errors.some((e) => e?.code === 'ECONNREFUSED'))
  );
}

/** @param {{port?: number, token?: string}} [options] */
export function createDaemonClient({ port, token } = {}) {
  const base = `http://127.0.0.1:${resolvePort(port)}`;

  const request = async (method, route, body, timeoutMs) => {
    // Headers built UNCONDITIONALLY (GETs included): auth applies to every
    // route, not just the ones with a body. /health ignores it server-side.
    const headers = { 'content-type': 'application/json' };
    const bearer = resolveToken(token);
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let res;
    try {
      res = await fetch(base + route, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs ?? (method === 'GET' ? 5000 : 30000)),
      });
    } catch (error) {
      // 401 ≠ connection-refused: only the latter means the daemon is down.
      if (isConnRefused(error)) throw new Error(OFFLINE_HINT);
      throw error;
    }
    if (res.status === 401) throw new Error(UNAUTHORIZED_HINT); // daemon RUNNING, token missing/wrong
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`daemon ${method} ${route} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  };

  return {
    base,
    health: () => request('GET', '/health'),
    plan: (prompt, options) => request('POST', '/workflows/plan', { prompt, options }),
    exec: (plan, { cwd, args } = {}) => request('POST', '/workflows/exec', { plan, cwd, args }),
    list: () => request('GET', '/workflows'),
    get: (id) => request('GET', `/workflows/${id}`),
    // ?wait blocks server-side until the workflow finishes — generous timeout.
    result: (id, { wait } = {}) =>
      request('GET', `/workflows/${id}/result${wait ? '?wait' : ''}`, undefined, wait ? 600_000 : undefined),
    control: (id, action) => request('POST', `/workflows/${id}/ctl`, { action }),
  };
}
