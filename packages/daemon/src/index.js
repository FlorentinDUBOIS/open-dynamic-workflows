/**
 * Composition root: wire config → db → queue → runtime → server.
 * Used by cli.js (start --foreground) and by integration tests directly.
 */

import { EventEmitter } from 'node:events';
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

  const db = openDatabase(options.dbPath ?? paths.dbPath);
  const store = createStore(db);

  const queue = createAgentQueue({
    maxConcurrency: config.daemon.maxConcurrency,
    retry: { maxAttempts: 3, backoff: 'exponential' },
    perAgentTimeout: 120,
    resolveProvider: (model) => resolveProvider(model, config, { fetchImpl: options.fetchImpl }),
    logger,
  });

  const runtime = createRuntime({ store, queue, config, events, logger });
  const resumability = createResumability({ store, runtime, logger });

  /** Planning: LLM decomposition via the configured planning model when reachable; heuristic otherwise. */
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

  const api = createServer({ runtime, store, config, logger, planner, events });
  const server = await api.listen(options.port ?? config.daemon.port, options.host ?? '127.0.0.1');
  const { port } = server.address();
  logger.info(`daemon listening on ${options.host ?? '127.0.0.1'}:${port}`);

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
