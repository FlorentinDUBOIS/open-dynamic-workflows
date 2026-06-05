/**
 * HTTP API (express 5) + WebSocket events (ws). Binds 127.0.0.1 ONLY unless
 * explicitly overridden (containers). Routes per data contract:
 *   GET  /health
 *   POST /workflows/plan      {prompt, options?} → {plan}
 *   POST /workflows/exec      {plan, strategy?}  → {workflowId, status}
 *   GET  /workflows           → {workflows}
 *   GET  /workflows/:id       → workflow record + node stats
 *   GET  /workflows/:id/result → {status, result?}
 *   POST /workflows/:id/ctl   {action} → {workflowId, status}
 * WS: /ws/:workflowId (?after=<journal_id> replays missed events).
 * Errors: {error:{code,message}} — never stack traces, never keys.
 */

/**
 * @param {{runtime: object, store: object, config: object, logger: object, planner: Function}} deps
 * @returns {{listen: (port: number, host?: string) => Promise<import('node:http').Server>, close: () => Promise<void>}}
 */
export function createServer(deps) {
  void deps;
  throw new Error('not implemented (P4)');
}
