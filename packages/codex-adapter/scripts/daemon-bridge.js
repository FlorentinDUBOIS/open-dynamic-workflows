#!/usr/bin/env node
/**
 * Daemon bridge for skill-based harnesses (Codex, Antigravity, anything that
 * can run a shell command). Plain CommonJS, zero dependencies.
 *
 *   daemon-bridge.js --check                 → daemon health (exit 0/1)
 *   daemon-bridge.js plan "<prompt>"         → plan JSON to stdout
 *   daemon-bridge.js exec <plan.json>        → workflowId
 *   daemon-bridge.js status [workflowId]     → status JSON
 *   daemon-bridge.js result <workflowId>     → final result JSON (waits)
 */

'use strict';

console.error('not implemented (P4)');
process.exit(1);
