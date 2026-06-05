# Changelog

This project does not use version numbers. Entries are marked by milestone.

## Initial public release

The first working cut of open-dynamic-workflows.

- **Core** — natural-language → task graph, topology selection (mapreduce, pipeline, adversarial, consensus, tree search, hybrid), hyper-scoped specialist roles, and a compiler that emits the `execute(context)` orchestration script. Pure, no I/O.
- **Daemon** — QuickJS-WASM sandbox with the full primitive set (`agent`, `parallel`, `pipeline`, `verify`, `loop`, `phase`, `log`, `checkpoint`, `budget`, `args`, `context.tools`); concurrency queue with retry/backoff and per-agent timeouts; provider adapters for Anthropic, OpenAI (and any OpenAI-compatible endpoint), and Ollama; SQLite/WAL state with deterministic crash-resume; per-workflow token and cost budgets; HTTP + WebSocket API on `127.0.0.1`; a full CLI (`start`, `stop`, `status`, `restart --resume`, `logs`, `run`, `db-check`).
- **Adapters** — OpenCode plugin (triggers, custom tools, slash commands, daemon-or-native fallback); Codex skill folder + bridge; Antigravity skill + saved workflow; VS Code extension (tree view, dashboard webview, status bar).
- **Examples** — security audit, JS→TS migration, deep research.
- **Safety** — sandbox isolation, approval-gated mutations, key redaction, loopback-only binding, hard budgets.
