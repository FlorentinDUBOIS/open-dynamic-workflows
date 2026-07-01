# odw-gemini

Gemini CLI adapter for Open Dynamic Workflows.

## What it provides

- Global MCP config at `~/.gemini/settings.json`.
- Managed project instructions in `GEMINI.md`.
- Project-local custom slash commands at `.gemini/commands/odw.toml` and `.gemini/commands/ultracode.toml`.

## Install

From the repository root:

```bash
odw-daemon integrate gemini
odw-daemon doctor gemini
odw-daemon start
```

Then run `/odw <task>` or `/ultracode <task>` inside Gemini CLI.
