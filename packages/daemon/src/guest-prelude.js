/**
 * Guest prelude — plain JavaScript source evaluated INSIDE the QuickJS sandbox
 * before the orchestration script. Defines the runtime primitives
 * (agent, parallel, pipeline, verify, loop, phase, log, checkpoint, budget,
 * args, context.tools) on top of the __host_* JSON-string bridges, plus a
 * CommonJS-style `module.exports` shim so scripts end with
 * `module.exports = { execute }` exactly as documented.
 *
 * Exported as a string constant so it ships inside the package without fs reads.
 */

export const GUEST_PRELUDE = `/* not implemented (P4) */`;
