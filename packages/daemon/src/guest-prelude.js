/**
 * Guest prelude — plain JavaScript evaluated INSIDE the QuickJS sandbox before
 * the orchestration script. Implements the runtime primitives on top of the
 * __host_* bridges (JSON strings in, JSON strings out; async bridges return
 * VM promises). Higher-order primitives live entirely guest-side, so no
 * closures ever cross the boundary.
 *
 * verify() is optionally TEST-GATED: a testCommand runs through the run_bash
 * tool bridge in parallel with the critic fan-out, and the verdict passes only
 * when the critic quorum passes AND the command exits 0 (fail-closed when the
 * bridge refuses to run it). mode 'test-gated' = adversarial quorum + a
 * mandatory testCommand.
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

// compact(value, opts): structure-preserving compaction to a char budget. Drops
// WHOLE array items / object properties (never mid-JSON) via the host bridge, so
// the result always re-parses. Cheap guest-side short-circuit returns the value
// untouched when it already fits — no host round-trip, byte-identical output.
function compact(value, opts) {
  var maxChars = (opts && opts.maxChars) || 20000;
  try {
    var s = JSON.stringify(value);
    if (s === undefined || s.length <= maxChars) return Promise.resolve(value);
  } catch (e) { /* unserializable: let the host decide */ }
  return __callAsync(__host_compact, { value: value, opts: { maxChars: maxChars } });
}

// summarize(text, opts): SEMANTIC (lossy) compression via map-reduce over the
// normal agent() bridge — so every call is budget-counted, cached, and abortable
// (no untracked side-channel). Opt-in; use for prose, never for IDs/schemas that
// must survive verbatim (prefer compact() there). Returns a string.
function summarize(text, opts) {
  opts = opts || {};
  var s = typeof text === "string" ? text : JSON.stringify(text);
  if (s === undefined) return Promise.resolve("");
  var maxChars = opts.maxChars || 4000;
  if (s.length <= maxChars) return Promise.resolve(s);
  var chunkSize = opts.chunkSize || 12000;
  var instr = opts.instructions ||
    "Summarize the following, preserving key facts, names, numbers, file paths, and decisions. Be concise.";
  function ask(part) {
    return agent({ role: opts.role || "summarizer", prompt: instr + "\n\n" + part, model: opts.model, maxTokens: opts.maxTokens || 1000 })
      .then(function (r) { return typeof r === "string" ? r : (r && r.summary) || JSON.stringify(r); })
      .catch(function () { return String(part).slice(0, 1000); });
  }
  var chunks = [];
  for (var i = 0; i < s.length; i += chunkSize) chunks.push(s.slice(i, i + chunkSize));
  return parallel(chunks.map(function (c) { return function () { return ask(c); }; })).then(function (parts) {
    var joined = parts.join("\n");
    if (joined.length <= maxChars) return joined;        // reduced enough
    return ask(joined.slice(0, chunkSize * 2));          // one reduce pass over the summaries
  });
}

function verify(config) {
  if (!config || config.target === undefined) throw new Error("verify({target,...}) requires a target");
  var mode = config.mode || "adversarial";
  // 'test-gated' aliases adversarial quorum semantics but REQUIRES a test
  // command — for code, the test suite is the ultimate critic.
  if (mode === "test-gated" && !config.testCommand) {
    throw new Error("verify: mode 'test-gated' requires a testCommand");
  }
  var critics = config.critics || [];
  if (!critics.length) throw new Error("verify: at least one critic is required");
  var threshold = config.consensusThreshold || Math.ceil(critics.length / 2);
  var minConfidence = config.minConfidence || 0;
  var maxChars = config.maxChars || 60000;

  // Structure-preserving compaction of the target BEFORE building critic prompts
  // (await first — compact() is async, so a one-liner here would serialize a
  // Promise into every prompt). Byte-identical when the target fits in maxChars.
  return compact(config.target, { maxChars: maxChars }).then(function (compacted) {
    var targetJson = JSON.stringify(compacted);
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

    // Test gate: testCommand runs through the run_bash bridge IN PARALLEL with
    // the critic fan-out (testTimeout is informational only — run_bash enforces
    // its own 120s cap). A bridge refusal (approval gate, blocked command,
    // dryRun) fails CLOSED: a gate that cannot run is a failed gate, not a crash.
    var testRun = null;
    if (config.testCommand) {
      testRun = __callAsync(__host_tool, { tool: "run_bash", args: [String(config.testCommand)] }).then(
        function (r) {
          r = r || {};
          var code = typeof r.exitCode === "number" ? r.exitCode : null;
          return {
            exitCode: code,
            output: String(r.stdout === undefined ? "" : r.stdout).slice(0, 4000),
            error: code === null ? "run_bash returned no exit code" : null
          };
        },
        function (e) {
          return { exitCode: null, output: "", error: (e && e.message) || String(e) };
        }
      );
    }

    return Promise.all([parallel(calls), testRun]).then(function (settled) {
      var verdicts = settled[0];
      var testGate = settled[1];
      var confident = verdicts.filter(function (v) { return (v.confidence || 0) >= minConfidence; });
      var approvals = confident.filter(function (v) { return v.approved; }).length;
      var rejections = confident.filter(function (v) { return !v.approved; }).length;
      // consensus: needs a positive quorum of confident approvals.
      // adversarial (and its 'test-gated' alias): target survives unless a quorum
      //   of confident critics REJECTS it (an errored/unconfident critic cannot
      //   sink an adversarial pass, but does weaken a consensus pass — that
      //   asymmetry is the point of the two modes).
      var quorumPassed = mode === "consensus" ? approvals >= threshold : rejections < threshold;
      var rejectedItems = [];
      confident.forEach(function (v) {
        (v.rejectedItems || []).forEach(function (item) { rejectedItems.push(item); });
      });
      var result = {
        // test-gated: quorum AND a clean exit 0 — a null exitCode (bridge
        // refusal) can never pass.
        passed: testGate ? quorumPassed && testGate.exitCode === 0 : quorumPassed,
        mode: mode,
        approvals: approvals,
        rejections: rejections,
        threshold: threshold,
        rejectedItems: rejectedItems,
        verdicts: verdicts,
        target: config.target
      };
      if (testGate) {
        result.testCommand = config.testCommand;
        result.testExitCode = testGate.exitCode;
        result.testOutput = testGate.output;
        result.testError = testGate.error;
      }
      return result;
    });
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
    web_search: __makeTool("web_search"),
    web_fetch: __makeTool("web_fetch"),
    runBash: __makeTool("run_bash") // alias used by some scripts
  },
  strategy: null, // populated by the runner before execute()
  args: args
};

var console = { log: function (m) { log(String(m), "info"); }, error: function (m) { log(String(m), "error"); } };
`;
