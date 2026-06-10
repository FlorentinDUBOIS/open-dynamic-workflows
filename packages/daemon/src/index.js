/**
 * Composition root: wire config → db → queue → runtime → server.
 * Used by cli.js (start --foreground) and by integration tests directly.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { createPlan } from 'odw-core';
import { loadConfig, ensureHome } from './config.js';
import { createLogger } from './logger.js';
import { openDatabase, createStore } from './db.js';
import { createAgentQueue } from './agent-queue.js';
import { resolveProvider } from './providers/index.js';
import { createRuntime } from './runtime.js';
import { createResumability } from './resumability.js';
import { createServer } from './server.js';

/**
 * @param {{port?: number, host?: string, dbPath?: string, configOverrides?: object,
 *          logStream?: {write: Function}, fetchImpl?: typeof fetch}} [options]
 */
export async function startDaemon(options = {}) {
  const config = mergeOverrides(loadConfig(), options.configOverrides);
  const paths = ensureHome();
  const logger = createLogger({ level: config.daemon.logLevel, stream: options.logStream });
  const events = new EventEmitter();
  events.setMaxListeners(100);

  // ── auth: resolve the daemon token (env → file → generate) ─────────────────
  const host = options.host ?? '127.0.0.1';
  let authMode = config.auth?.mode ?? 'token';
  if (authMode === 'none' && !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    // The docker path binds 0.0.0.0 — never let that combination run tokenless.
    logger.warn(`auth.mode "none" is only safe on loopback; forcing token auth on ${host}`);
    authMode = 'token';
  }
  let token = process.env.ODW_DAEMON_TOKEN || null;
  if (!token && existsSync(paths.tokenPath)) {
    try {
      // BOM-strip + trim: same precedent as config.json parsing above.
      const raw = readFileSync(paths.tokenPath, 'utf8');
      token = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim() || null;
    } catch {
      token = null; // unreadable file = no token; we regenerate below
    }
    // writeFileSync's mode only applies at creation — tighten a pre-existing
    // file here. win32: NTFS ignores POSIX modes and %USERPROFILE% ACLs are
    // already user-private, so skip chmod there.
    if (token && process.platform !== 'win32') {
      try { chmodSync(paths.tokenPath, 0o600); } catch { /* best-effort */ }
    }
  }
  if (!token) {
    token = randomBytes(32).toString('hex');
    writeFileSync(paths.tokenPath, token, { encoding: 'utf8', mode: 0o600 });
  }

  const db = openDatabase(options.dbPath ?? paths.dbPath);
  const store = createStore(db);

  const queue = createAgentQueue({
    maxConcurrency: config.daemon.maxConcurrency,
    retry: { maxAttempts: config.daemon.retryAttempts ?? 3, backoff: 'exponential' },
    // Per-agent wall-clock timeout. Configurable because slow/free models can
    // take well over the old hardcoded 120s on a large prompt.
    perAgentTimeout: config.daemon.perAgentTimeout ?? 120,
    resolveProvider: (model) => resolveProvider(model, config, { fetchImpl: options.fetchImpl }),
    logger,
  });

  /** Planning: LLM decomposition via the configured planning model when reachable; heuristic otherwise.
   *  ONE definition shared by the HTTP /workflows/plan endpoint AND the runtime's replan() bridge. */
  const planner = (prompt, plannerOptions = {}) =>
    createPlan(prompt, {
      ...plannerOptions,
      strategy: {
        ...(plannerOptions.strategy ?? {}),
        budget: {
          model: config.models.default,
          maxTokens: config.budget.defaultMaxTokens,
          maxCostUSD: config.budget.defaultMaxCostUSD,
          alertAtPercent: config.budget.alertAtPercent,
          ...(plannerOptions.strategy?.budget ?? {}),
        },
        safety: { ...config.safety, ...(plannerOptions.strategy?.safety ?? {}) },
        git: { ...config.git, ...(plannerOptions.strategy?.git ?? {}) },
        concurrency: {
          max: config.daemon.maxConcurrency,
          default: config.daemon.maxConcurrency,
          ...(plannerOptions.strategy?.concurrency ?? {}),
        },
      },
      llmDecompose: plannerOptions.useLlmPlanner ? llmDecompose(config, queue) : undefined,
    });

  const runtime = createRuntime({ store, queue, config, events, logger, planner });
  const resumability = createResumability({ store, runtime, logger });

  /** Preflight: can we actually reach the configured default model? */
  const checkModel = () => {
    const model = config.models.default;
    try {
      resolveProvider(model, config, { fetchImpl: options.fetchImpl });
      return { ok: true, model };
    } catch (error) {
      return { ok: false, model, reason: String(error.message) };
    }
  };

  const api = createServer({ runtime, store, config, logger, planner, events, checkModel, auth: { mode: authMode, token } });
  const server = await api.listen(options.port ?? config.daemon.port, host);
  const { port } = server.address();
  logger.info(`daemon listening on ${host}:${port}`);

  return {
    server: api,
    httpServer: server,
    runtime,
    resumability,
    store,
    config,
    logger,
    events,
    planner,
    port,
    async close() {
      await api.close();
      store.close();
    },
  };
}

/** LLM-driven task decomposition using the cheap planning model. */
function llmDecompose(config, queue) {
  return async (prompt) => {
    const result = await queue.executeAgent({
      model: config.models.planning,
      systemPrompt:
        'You are a planning engine. Decompose the task into a JSON task graph. Return ONLY JSON: ' +
        '{"root":{"prompt":string,"complexity":"low"|"medium"|"high"|"massive","estimatedTotalAgents":number},' +
        '"tasks":[{"id":string,"description":string,"type":"discovery"|"analysis"|"mutation"|"verification"|"synthesis",' +
        '"dependencies":[string],"parallelizable":boolean,"fanoutSource":string|null,"role":string,' +
        '"expectedOutputSchema":object,"estimatedTokens":number}]}',
      prompt,
      schema: { type: 'object', properties: { root: { type: 'object' }, tasks: { type: 'array' } }, required: ['tasks'] },
      maxTokens: 4000,
      temperature: 0,
    });
    return result.output;
  };
}

function mergeOverrides(config, overrides) {
  if (!overrides) return config;
  const merge = (base, over) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object'
        ? merge(base[k], v)
        : v;
    }
    return out;
  };
  return merge(config, overrides);
}
