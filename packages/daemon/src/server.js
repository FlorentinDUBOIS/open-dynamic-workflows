/**
 * HTTP API (express 5) + WebSocket events (ws, noServer + manual upgrade).
 * Binds 127.0.0.1 ONLY unless explicitly overridden (containers).
 * Errors: {error:{code,message}} — never stack traces, never keys.
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

/**
 * @param {{runtime: object, store: object, config: object, logger: object,
 *          planner: (prompt: string, options?: object) => Promise<object>,
 *          events: {on: Function, off: Function}, startedAt?: number,
 *          auth?: {mode: 'token'|'none', token: string|null}}} deps
 */
export function createServer(deps) {
  const { runtime, store, config, logger, planner, events } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  // startDaemon always supplies auth; 'none' keeps direct embedders working.
  const auth = deps.auth ?? { mode: 'none', token: null };

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  // ── auth: Bearer token on everything except GET /health ────────────────────
  // Compared via timingSafeEqual over sha256 digests of both sides — digesting
  // first sidesteps timingSafeEqual's equal-length requirement.
  const sha256 = (s) => createHash('sha256').update(String(s ?? '')).digest();
  const tokenMatches = (header) =>
    typeof header === 'string' &&
    header.startsWith('Bearer ') &&
    timingSafeEqual(sha256(header.slice('Bearer '.length)), sha256(auth.token));
  const UNAUTHORIZED = {
    error: { code: 'unauthorized', message: 'daemon requires an auth token — copy it from ~/.odw/daemon.token or set ODW_DAEMON_TOKEN' },
  };
  app.use((req, res, next) => {
    if (auth.mode === 'none') return next();
    // /health stays tokenless: docker healthcheck + CLI preflight depend on it.
    if (req.method === 'GET' && req.path === '/health') return next();
    if (tokenMatches(req.headers.authorization)) return next();
    res.status(401).json(UNAUTHORIZED);
  });

  // ── rate limiting: in-memory fixed window keyed by route class ─────────────
  const rateLimit = config.rateLimit ?? { enabled: false };
  const windows = new Map(); // route class → {start, count}
  const underLimit = (key, max) => {
    if (!rateLimit.enabled) return true;
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now - w.start >= rateLimit.windowMs) {
      w = { start: now, count: 0 };
      windows.set(key, w);
    }
    return ++w.count <= max;
  };
  const RATE_LIMITED = {
    error: { code: 'rate_limited', message: 'too many requests in the current window — retry shortly' },
  };
  const mutationLimiter = (req, res, next) => {
    if (underLimit('mutation', rateLimit.maxMutationsPerWindow)) return next();
    res.status(429).json(RATE_LIMITED);
  };
  // Sweep stale windows; unref'd AND cleared in close() — an open handle here
  // would hang the 30s graceful-shutdown drain.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) {
      if (now - w.start >= rateLimit.windowMs) windows.delete(key);
    }
  }, rateLimit.windowMs ?? 60000);
  sweep.unref();

  const asyncRoute = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((error) => {
      const status = error.status ?? 500;
      logger.error(`http ${req.method} ${req.path} → ${status}`, { error });
      res.status(status).json({ error: { code: error.code ?? 'internal', message: safeMessage(error) } });
    });
  };

  app.get('/health', (_req, res) => {
    const stats = runtime.stats();
    res.json({
      status: 'ok',
      uptime: Math.round((Date.now() - startedAt) / 1000),
      activeWorkflows: stats.activeWorkflows,
      activeAgents: stats.queuePending,
      queuedAgents: stats.queueSize,
      maxActiveAgentsObserved: stats.queueHighWaterPending,
      maxConcurrency: stats.maxConcurrency,
    });
  });

  // Preflight: is the configured default model actually usable (route + key)?
  // Lets the CLI fail fast with guidance BEFORE rendering a plan.
  app.get('/config/check', asyncRoute(async (_req, res) => {
    res.json(deps.checkModel ? deps.checkModel() : { ok: true });
  }));

  const ensureModelReady = (options) => {
    const readiness = deps.checkModel?.(options);
    if (readiness && !readiness.ok) {
      throw Object.assign(new Error(`model configuration is not ready: ${readiness.reason}`), {
        status: 400,
        code: 'provider_not_ready',
      });
    }
    return readiness;
  };

  app.post('/workflows/plan', mutationLimiter, asyncRoute(async (req, res) => {
    const { prompt, options } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string') {
      throw Object.assign(new Error('body.prompt (string) is required'), { status: 400, code: 'bad_request' });
    }
    // Heuristic planning is intentionally keyless, and even the optional LLM
    // planner falls back to heuristics when unavailable. Execution is the hard
    // provider-readiness gate.
    const plan = await planner(prompt, options ?? {});
    // Annotate whether the plan includes an adversarial verification node, so
    // the absence of the safety net is never silent.
    plan.hasVerification = (plan.taskGraph?.tasks ?? []).some((t) => t.type === 'verification');
    res.json({ plan });
  }));

  app.post('/workflows/exec', mutationLimiter, asyncRoute(async (req, res) => {
    const { plan, strategy, cwd, args } = req.body ?? {};
    if (!plan?.script) {
      throw Object.assign(new Error('body.plan with a compiled script is required'), { status: 400, code: 'bad_request' });
    }
    if (planNeedsModelProvider(plan)) ensureModelReady({ plan });
    // roles must travel with the run (embedded.js does the same) — dropping
    // them silently strips role system prompts from daemon-run workflows.
    const workflowId = await runtime.execWorkflow(plan, strategy, { cwd, args, roles: plan.roles });
    res.status(202).json({ workflowId, status: 'running' });
  }));

  app.get('/workflows', asyncRoute(async (_req, res) => {
    res.json({ workflows: store.listWorkflows() });
  }));

  app.get('/workflows/:id', asyncRoute(async (req, res) => {
    const row = store.getWorkflow(req.params.id);
    if (!row) throw Object.assign(new Error('workflow not found'), { status: 404, code: 'not_found' });
    const { compiled_script, execution_strategy, result, ...summary } = row;
    // Surface a failure reason at the top level so `status` / the dashboard
    // can show WHY a run failed without anyone reading daemon.log.
    let error = null;
    if (row.status === 'failed' && result) {
      try {
        error = JSON.parse(result).error ?? null;
      } catch {
        error = null;
      }
    }
    res.json({
      ...summary,
      error,
      strategy: JSON.parse(execution_strategy),
      nodeStats: store.nodeStats(req.params.id),
      scriptLength: compiled_script.length,
    });
  }));

  app.get('/workflows/:id/script', asyncRoute(async (req, res) => {
    const row = store.getWorkflow(req.params.id);
    if (!row) throw Object.assign(new Error('workflow not found'), { status: 404, code: 'not_found' });
    res.type('text/plain').send(row.compiled_script);
  }));

  app.get('/workflows/:id/result', asyncRoute(async (req, res) => {
    const row = store.getWorkflow(req.params.id);
    if (!row) throw Object.assign(new Error('workflow not found'), { status: 404, code: 'not_found' });
    if (row.status === 'completed' || row.status === 'failed') {
      res.json({ status: row.status, result: row.result ? JSON.parse(row.result) : null });
      return;
    }
    // wait briefly when the workflow is live and the caller asked to block
    const live = runtime.resultOf(req.params.id);
    if (req.query.wait !== undefined && live) {
      try {
        const result = await live;
        res.json({ status: 'completed', result });
      } catch {
        const fresh = store.getWorkflow(req.params.id);
        res.json({ status: fresh.status, result: fresh.result ? JSON.parse(fresh.result) : null });
      }
      return;
    }
    res.json({ status: row.status, result: null });
  }));

  app.post('/workflows/:id/ctl', mutationLimiter, asyncRoute(async (req, res) => {
    const { action } = req.body ?? {};
    if (!['pause', 'resume', 'stop'].includes(action)) {
      throw Object.assign(new Error('body.action must be pause|resume|stop'), { status: 400, code: 'bad_request' });
    }
    res.json(await runtime.control(req.params.id, action));
  }));

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: `no route: ${req.method} ${req.path}` } });
  });

  // ── WebSocket: /ws/:workflowId (?after=<journal_id> replays missed events) ──
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer(app);

  server.on('upgrade', (request, socket, head) => {
    const match = (request.url ?? '').match(/^\/ws\/([A-Za-z0-9_-]+)(\?.*)?$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // 401 BEFORE the workflow-existence check — an unauthenticated caller must
    // not be able to use 404-vs-101 as a workflow-ID oracle.
    if (auth.mode !== 'none' && !tokenMatches(request.headers.authorization)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!underLimit('upgrade', rateLimit.maxUpgradesPerWindow)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    const workflowId = match[1];
    if (!store.getWorkflow(workflowId)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const after = Number(new URL(request.url, 'http://localhost').searchParams.get('after') ?? 0);
      // replay journal from `after`, then stream live
      for (const entry of store.journalAfter(workflowId, after)) {
        ws.send(JSON.stringify({
          type: entry.operation,
          workflowId,
          ts: entry.timestamp * 1000,
          journalId: entry.journal_id,
          payload: JSON.parse(entry.payload),
        }));
      }
      const onEvent = (event) => {
        if (event.workflowId === workflowId && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(event));
        }
      };
      events.on('workflow-event', onEvent);
      ws.on('close', () => events.off('workflow-event', onEvent));
    });
  });

  return {
    app,
    /**
     * @param {number} [port]
     * @param {string} [host]
     * @returns {Promise<import('node:http').Server>}
     */
    listen(port = config.daemon.port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server));
      });
    },
    close() {
      clearInterval(sweep);
      return new Promise((resolve) => {
        wss.clients.forEach((ws) => ws.close());
        server.close(() => resolve());
      });
    },
    server,
  };
}

function safeMessage(error) {
  // never leak stack traces or anything resembling a secret
  return String(error.message ?? 'internal error')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/g, '[REDACTED]')
    .slice(0, 500);
}

function planNeedsModelProvider(plan) {
  if ((plan.estimate?.totalAgents ?? 0) > 0) return true;
  if ((plan.roles?.length ?? 0) > 0) return true;
  if (plan.strategy?.budget?.model) return true;
  return /\b(agent|verify|replan)\s*\(/.test(String(plan.script ?? ''));
}
