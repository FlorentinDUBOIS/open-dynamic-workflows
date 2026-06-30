# odw-kimi

Kimi Code CLI adapter for Open Dynamic Workflows.

## What it provides

- Global MCP config at `~/.kimi-code/mcp.json`.
- Managed project instructions in `AGENTS.md`.
- A project-local flow skill at `.kimi/skills/odw` so users can run `/flow:odw` or load `/skill:odw` from Kimi Code CLI.

## Install

From the repository root:

```bash
odw-daemon integrate kimi
odw-daemon doctor kimi
odw-daemon start
```

Restart Kimi Code CLI after installing so it discovers the project flow skill.
