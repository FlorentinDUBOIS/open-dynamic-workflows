# odw-cursor

Cursor adapter for Open Dynamic Workflows.

## What it provides

- Project MCP config at `.cursor/mcp.json`.
- An always-on Cursor rule that routes `workflow:`, `ultracode`, and `/deep-research` requests to the ODW MCP tools.
- A project-local Cursor Agent skill at `.cursor/skills/odw` so users can type `/odw` in Agent chat and get the workflow playbook plus local daemon bridge scripts.

## Install

From the repository root:

```bash
odw-daemon integrate cursor
odw-daemon doctor cursor
odw-daemon start
```

Reload the Cursor window after installing so Agent chat discovers the new project skill.
