/**
 * Daemon configuration: ~/.odw/config.json with env-var fallbacks.
 * API keys are NEVER logged and never serialized into state rows.
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @typedef {object} DaemonConfig
 * @property {{port: number, maxConcurrency: number, checkpointInterval: number, logLevel: string}} daemon
 * @property {Record<string, string>} apiKeys
 * @property {{planning: string, default: string, fallback: string}} models
 * @property {{defaultMaxTokens: number, defaultMaxCostUSD: number, alertAtPercent: number}} budget
 * @property {{requireApprovalFor: string[], autoApproveReadOnly: boolean, dryRun: boolean, blockedCommands: string[]}} safety
 * @property {{autoCreateBranch: boolean, branchPrefix: string, commitCheckpoints: boolean}} git
 * @property {Record<string, string>} baseURLs  per-provider endpoint overrides
 */

export const DEFAULT_PORT = 7345;

/** @returns {string} the odw home directory (ODW_HOME override for tests/containers) */
export function odwHome() {
  return process.env.ODW_HOME || join(homedir(), '.odw');
}

/** Ensure ~/.odw layout exists; returns useful paths. */
export function ensureHome() {
  const home = odwHome();
  const dirs = {
    home,
    data: join(home, 'data'),
    logs: join(home, 'logs'),
  };
  for (const dir of Object.values(dirs)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return {
    ...dirs,
    dbPath: join(dirs.data, 'odw.db'),
    configPath: join(home, 'config.json'),
    pidFile: join(home, 'daemon.pid'),
    logFile: join(dirs.logs, 'daemon.log'),
  };
}

/** @returns {DaemonConfig} */
export function defaultConfig() {
  return {
    daemon: { port: DEFAULT_PORT, maxConcurrency: 16, checkpointInterval: 30, logLevel: 'info' },
    apiKeys: {},
    models: { planning: 'gpt-4o-mini', default: 'claude-sonnet-4-6', fallback: 'gpt-4o' },
    budget: { defaultMaxTokens: 1_000_000, defaultMaxCostUSD: 50, alertAtPercent: 80 },
    safety: {
      requireApprovalFor: ['write_file', 'run_bash', 'git_commit'],
      autoApproveReadOnly: true,
      dryRun: false,
      blockedCommands: ['rm -rf /', 'sudo ', 'chmod -R 777 /', 'mkfs', 'dd if='],
    },
    git: { autoCreateBranch: true, branchPrefix: 'odw/', commitCheckpoints: false },
    baseURLs: {},
  };
}

/** @returns {DaemonConfig} merged defaults ← file ← env */
export function loadConfig() {
  const base = defaultConfig();
  const { configPath } = ensureHome();
  let fromFile = {};
  if (existsSync(configPath)) {
    try {
      fromFile = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      // malformed config: keep defaults rather than crash the daemon
      fromFile = {};
    }
  }
  const merged = deepMerge(base, fromFile);
  if (process.env.ODW_DAEMON_PORT) {
    const port = Number(process.env.ODW_DAEMON_PORT);
    if (Number.isInteger(port) && port > 0 && port < 65536) merged.daemon.port = port;
  }
  return merged;
}

/**
 * Resolve an API key for a provider: config.apiKeys[provider] → env.
 * @param {DaemonConfig} config
 * @param {string} provider
 * @returns {string|undefined}
 */
export function apiKeyFor(config, provider) {
  const fromConfig = config?.apiKeys?.[provider];
  if (fromConfig) return fromConfig;
  const ENV_NAMES = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_API_KEY',
    opencode: 'OPENCODE_API_KEY',
  };
  const envName = ENV_NAMES[provider];
  return envName ? process.env[envName] : undefined;
}

function deepMerge(base, overrides) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof base?.[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
