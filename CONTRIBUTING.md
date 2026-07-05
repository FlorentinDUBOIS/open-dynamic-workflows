# Contributing

Thanks for looking. A few things that will save you time.

## Layout

It's an npm-workspaces monorepo. `packages/core` is pure logic with no I/O — planning, topology selection, script generation — and it's where most behavior lives. `packages/daemon` is the engine that runs the scripts. Everything else is a thin adapter for one host (OpenCode, Codex, Antigravity, VS Code).

The rule that keeps it sane: **adapters never import the daemon.** They talk to it over HTTP on `127.0.0.1:7345`, the same as any other client. If you find yourself reaching across that line, stop.

## Setup

```bash
npm install        # installs all workspaces
npm test           # node:test across every package
npm run lint
```

You need Node 20 or newer (the SQLite driver's prebuilt binaries and `p-queue`'s ESM-only build both want it).

## Tests

Everything is `node:test` — no framework to learn. The daemon's integration tests spin up a real HTTP server against an in-process mock model, so they're fast and need no API key. If you change anything in the runtime or sandbox, run the crash-resume test specifically; it's the one that catches state bugs.

Coverage is enforced at 80% lines on `core` and `daemon`.

## A few conventions

- Plain JavaScript with JSDoc types in the daemon and core — no build step in the install path, on purpose.
- `packages/daemon/schema.sql` and `packages/core/src/types.js` are the source of truth for the SQLite schema and the type contracts; `packages/daemon/src/server.js` defines the HTTP routes. Change the contract there first, then the implementation.
- Don't add a dependency to the sandbox boundary without a very good reason, and pin it exactly if you do.

## Where to start

The shipped code is the map: start from `packages/core` (pure planning logic) and `packages/daemon/src` (the engine), and read `HANDOFF.md` for the operational picture.
