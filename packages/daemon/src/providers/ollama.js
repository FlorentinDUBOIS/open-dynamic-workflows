/**
 * Ollama local adapter. POST http://localhost:11434/api/chat (no auth).
 * - format: "json" or a full JSON Schema object directly.
 * - usage: prompt_eval_count / eval_count (may be 0 on cache hit → treated as 0).
 * - cost: always $0.
 */
export function createOllamaProvider({ baseURL }) {
  void baseURL;
  throw new Error('not implemented (P4)');
}
