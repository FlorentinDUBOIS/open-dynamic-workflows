# Changelog

This project does not use version numbers. Entries are marked by milestone.

## Context-window hardening (small-model lifeline)

Mirrors how Claude Code runs arbitrarily large tasks without exhausting the model window — sub-agent isolation and filesystem-as-memory already existed here; this adds the missing **compaction** layer so the engine never overflows a model's input window, which is the difference between a run surviving and crashing on small/free models.

- **Model context-window registry** (`odw-core`) — per-model input windows, with the llama-3 (8K) vs llama-3.1 (128K) disambiguation, and a deliberately conservative **8192-token default for unknown / `ollama:*` / `*-free` ids** (over-budgeting compacts a little early; under-budgeting crashes the call).
- **Tokenizer-free token estimator** — content-aware char/token divisors (denser for code/JSON/CJK) plus a safety margin, biased to over-count so the safe failure mode wins.
- **Pre-call context-fit guard** — before each agent call the input is measured against `(window − reserved output) × safetyFactor`; if it would overflow, only the **user-content portion** is compacted (system prompt + schema instruction are reserved and never cut). It is a pure pass-through when the input fits, and proactive compaction is **skipped for unknown-window models** so custom/local endpoints keep today's behavior.
- **Self-healing overflow recovery** — a provider `context_length_exceeded` / "prompt is too long" 400 is now classified as a distinct, **bounded** `context_overflow` (cross-provider phrase set incl. Anthropic's), and the queue compacts-and-retries instead of hard-failing the workflow. Terminating by construction (attempt cap + monotonic shrink); never added to the blind-retry set.
- **Structure-preserving compaction** — `compact()` (guest primitive) and the script-generator's dependency-context injection drop **whole** array items / object properties to a budget instead of the old blind `JSON.stringify(...).slice(N)` that could cut mid-structure; output always re-parses as valid JSON, and it is byte-identical when the value already fits.
- **Semantic `summarize()`** — opt-in map-reduce compression for prose, routed through the normal tracked `agent()` bridge (budget-counted, cached, abortable).
- **Studio Prime workflow upgrade** — parallel + `summarize()`d research (and it now actually *uses* P3 research, which the prior version discarded), context-safe `compact()` hand-off between phases, a hardened fix-until-green loop (root-cause diagnosis, repeated-failure escalation, and a one-file-at-a-time fallback for weak models), and sharper Apex verification.

## Reliability & polish pass

- **Self-correcting agent retries** — when a model returns malformed or schema-invalid JSON, the retry now re-prompts with the exact validation error and the previous bad output, so weaker/free models recover instead of failing the run.
- **More tolerant JSON extraction** — single-quoted strings, unquoted keys, Python-style `True/False/None`, and leading prose are now repaired before parsing.
- **Clear failure reasons** — failed runs surface the cause at the top level (`odw-daemon status`, `GET /workflows/:id`, and `odw-daemon run` print `reason:`). Raw QuickJS/WASM aborts are wrapped instead of leaking into the terminal.
- **Resilient `run`** — replaced the single long-held result connection with short polling that shows live progress; no more dropped multi-minute waits.
- **Windows-aware safety** — default `blockedCommands` now include destructive PowerShell/cmd patterns, matched case-insensitively.
- **Docs** — documented `baseURLs.default` for any OpenAI-compatible endpoint; clarified install-from-GitHub (and the unrelated npm name); corrected test counts.

## Initial public release

The first working cut of open-dynamic-workflows.

- **Core** — natural-language → task graph, topology selection (mapreduce, pipeline, adversarial, consensus, tree search, hybrid), hyper-scoped specialist roles, and a compiler that emits the `execute(context)` orchestration script. Pure, no I/O.
- **Daemon** — QuickJS-WASM sandbox with the full primitive set (`agent`, `parallel`, `pipeline`, `verify`, `loop`, `phase`, `log`, `checkpoint`, `budget`, `args`, `context.tools`); concurrency queue with retry/backoff and per-agent timeouts; provider adapters for Anthropic, OpenAI (and any OpenAI-compatible endpoint), and Ollama; SQLite/WAL state with deterministic crash-resume; per-workflow token and cost budgets; HTTP + WebSocket API on `127.0.0.1`; a full CLI (`start`, `stop`, `status`, `restart --resume`, `logs`, `run`, `db-check`).
- **Adapters** — OpenCode plugin (triggers, custom tools, slash commands, daemon-or-native fallback); Codex skill folder + bridge; Antigravity skill + saved workflow; VS Code extension (tree view, dashboard webview, status bar).
- **Examples** — security audit, JS→TS migration, deep research.
- **Safety** — sandbox isolation, approval-gated mutations, key redaction, loopback-only binding, hard budgets.
