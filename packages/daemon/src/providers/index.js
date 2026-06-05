/**
 * Provider registry: model id → provider adapter.
 *
 * Routing rules:
 *   claude-*            → anthropic
 *   gpt-* / o[0-9]*     → openai
 *   ollama:<m>, ollama/<m> → ollama
 *   <provider>:<model>  → named OpenAI-compatible endpoint from config.baseURLs
 *   anything else       → openai-compatible default (config.baseURLs.default) or error
 */

import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { createOllamaProvider } from './ollama.js';
import { apiKeyFor } from '../config.js';

/**
 * @param {string} model
 * @param {import('../config.js').DaemonConfig} config
 * @param {{fetchImpl?: typeof fetch}} [opts]
 * @returns {{provider: object, model: string}}
 */
export function resolveProvider(model, config, opts = {}) {
  const id = String(model ?? config.models.default);
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (/^claude-/.test(id)) {
    return {
      provider: createAnthropicProvider({
        apiKey: apiKeyFor(config, 'anthropic'),
        baseURL: config.baseURLs?.anthropic,
        fetchImpl,
      }),
      model: id,
    };
  }

  if (/^(gpt-|o[0-9])/.test(id)) {
    return {
      provider: createOpenAIProvider({
        apiKey: apiKeyFor(config, 'openai'),
        baseURL: config.baseURLs?.openai ?? 'https://api.openai.com/v1',
        fetchImpl,
      }),
      model: id,
    };
  }

  if (/^ollama[:/]/.test(id)) {
    return {
      provider: createOllamaProvider({ baseURL: config.baseURLs?.ollama, fetchImpl }),
      model: id,
    };
  }

  // <provider>:<model> → named OpenAI-compatible endpoint
  const prefixed = id.match(/^([a-z][a-z0-9_-]*):(.+)$/i);
  if (prefixed && config.baseURLs?.[prefixed[1]]) {
    return {
      provider: createOpenAIProvider({
        apiKey: apiKeyFor(config, prefixed[1]) ?? 'none',
        baseURL: config.baseURLs[prefixed[1]],
        fetchImpl,
        name: prefixed[1],
      }),
      model: prefixed[2],
    };
  }

  if (config.baseURLs?.default) {
    return {
      provider: createOpenAIProvider({
        apiKey: apiKeyFor(config, 'default') ?? 'none',
        baseURL: config.baseURLs.default,
        fetchImpl,
        name: 'openai-compatible',
      }),
      model: id,
    };
  }

  throw new Error(`No provider route for model "${id}". Configure apiKeys/baseURLs in ~/.odw/config.json.`);
}
