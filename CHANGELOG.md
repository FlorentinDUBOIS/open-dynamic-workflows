# Changelog

This project does not use version numbers. Entries are marked by milestone.

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
