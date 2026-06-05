/**
 * Guest prelude — plain JavaScript evaluated INSIDE the QuickJS sandbox before
 * the orchestration script. Implements the runtime primitives on top of the
 * __host_* bridges (JSON strings in, JSON strings out; async bridges return
 * VM promises). Higher-order primitives live entirely guest-side, so no
 * closures ever cross the boundary.
 *
 * Host bridge contract:
 *   async:  __host_agent(json), __host_tool(json), __host_checkpoint(json)
 *           → promise of '{"ok":true,"value":...}' | '{"ok":false,"error":"..."}'
 *   sync:   __host_budget(), __host_args(), __host_log(json), __host_phase(json)
 *           → same envelope, immediately
 */

export const GUEST_PRELUDE = String.raw`
"use strict";

var module = { exports: {} };
var exports = module.exports;

function __unwrap(envelopeJson) {
  var envelope = JSON.parse(envelopeJson);
  if (envelope && envelope.ok) return envelope.value;
  var err = new Error((envelope && envelope.error) || "host bridge error");
  if (envelope && envelope.code) err.code = envelope.code;
  throw err;
}

function __callAsync(bridge, payload) {
  return bridge(JSON.stringify(payload === undefined ? null : payload)).then(__unwrap);
}

// ── primitives ───────────────────────────────────────────────────────────────

function agent(options) {
  if (!options || typeof options !== "object") throw new Error("agent(options) requires an options object");
  if (!options.prompt) throw new Error("agent: prompt is required");
  return __callAsync(__host_agent, options);
}

function parallel(tasks, opts) {
  if (!Array.isArray(tasks)) throw new Error("parallel(tasks) requires an array of functions");
  var max = (opts && opts.maxConcurrency) || tasks.length || 1;
  if (max >= tasks.length) {
    return Promise.all(tasks.map(function (t) { return typeof t === "function" ? t() : t; }));
  }
  var results = new Array(tasks.length);
  var next = 0;
  function worker() {
    if (next >= tasks.length) return Promise.resolve();
    var index = next++;
    var task = tasks[index];
    return Promise.resolve(typeof task === "function" ? task() : task)
      .then(function (r) { results[index] = r; })
      .then(worker);
  }
  var workers = [];
  for (var w = 0; w < max; w++) workers.push(worker());
  return Promise.all(workers).then(function () { return results; });
}

function pipeline(items, stages) {
  if (!Array.isArray(items)) throw new Error("pipeline(items, stages) requires an items array");
  if (!Array.isArray(stages)) throw new Error("pipeline(items, stages) requires a stages array");
  // Each item flows through all stages independently — no barrier between stages.
  return Promise.all(items.map(function (item, index) {
    var acc = Promise.resolve(item);
    stages.forEach(function (stage) {
      acc = acc.then(function (prev) { return stage(prev, item, index); });
    });
    return acc.catch(function () { return null; }); // a failed item drops to null
  }));
}

function loop(condition, body, opts) {
  var maxIterations = (opts && opts.maxIterations) || 100;
  var i = 0;
  function step(last) {
    return Promise.resolve(condition()).then(function (done) {
      if (done) return last;
      if (i++ >= maxIterations) throw new Error("loop: exceeded maxIterations (" + maxIterations + ")");
      return Promise.resolve(body()).then(step);
    });
  }
  return step(undefined);
}

function verify(config) {
  if (!config || config.target === undefined) throw new Error("verify({target,...}) requires a target");
  var mode = config.mode || "adversarial";
  var critics = config.critics || [];
  if (!critics.length) throw new Error("verify: at least one critic is required");
  var threshold = config.consensusThreshold || Math.ceil(critics.length / 2);
  var minConfidence = config.minConfidence || 0;
  var targetJson = JSON.stringify(config.target).slice(0, 60000);

  var calls = critics.map(function (critic) {
    return function () {
      return agent({
        role: critic.role || "false-positive-hunter",
        prompt: (critic.prompt || "Critique these findings.") +
          " Findings to review: " + targetJson +
          ' Return JSON: {"approved": boolean, "confidence": number between 0 and 1, "critique": string, "rejectedItems": array}',
        schema: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
            confidence: { type: "number" },
            critique: { type: "string" },
            rejectedItems: { type: "array" }
          },
          required: ["approved", "confidence"]
        },
        model: critic.model,
        maxTokens: critic.maxTokens || 4000
      }).catch(function (e) {
        return { approved: false, confidence: 0, critique: "critic failed: " + e.message, rejectedItems: [] };
      });
    };
  });

  return parallel(calls).then(function (verdicts) {
    var confident = verdicts.filter(function (v) { return (v.confidence || 0) >= minConfidence; });
    var approvals = confident.filter(function (v) { return v.approved; }).length;
    var passed = mode === "consensus"
      ? approvals >= threshold
      : approvals >= threshold; // adversarial: target survives if ≥ threshold critics fail to reject
    return {
      passed: passed,
      mode: mode,
      approvals: approvals,
      threshold: threshold,
      verdicts: verdicts,
      target: config.target
    };
  });
}

function phase(name, meta) {
  try { __host_phase(JSON.stringify({ name: String(name), meta: meta || {} })); } catch (e) { /* non-fatal */ }
}

function log(message, level) {
  try { __host_log(JSON.stringify({ message: String(message), level: level || "info" })); } catch (e) { /* non-fatal */ }
}

function checkpoint(data) {
  return __callAsync(__host_checkpoint, data === undefined ? null : data);
}

function budget() {
  return __unwrap(__host_budget());
}

function args() {
  return __unwrap(__host_args());
}

// ── context.tools ────────────────────────────────────────────────────────────

function __makeTool(name) {
  return function () {
    var toolArgs = Array.prototype.slice.call(arguments);
    return __callAsync(__host_tool, { tool: name, args: toolArgs });
  };
}

var context = {
  tools: {
    glob: __makeTool("glob"),
    read_file: __makeTool("read_file"),
    write_file: __makeTool("write_file"),
    run_bash: __makeTool("run_bash"),
    search: __makeTool("search"),
    git: __makeTool("git"),
    runBash: __makeTool("run_bash") // alias used by some scripts
  },
  strategy: null, // populated by the runner before execute()
  args: args
};

var console = { log: function (m) { log(String(m), "info"); }, error: function (m) { log(String(m), "error"); } };
`;
