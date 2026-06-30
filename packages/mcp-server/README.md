# odw-mcp-server

Universal [MCP](https://modelcontextprotocol.io) server for open-dynamic-workflows. Any MCP client — Claude Desktop, Cursor, Codex, Windsurf, Cline, ... — gets tools to plan, run and monitor dynamic multi-agent workflows through the local odw daemon.

## What it exposes

| Tool | What it does |
|---|---|
| `odw_health` | daemon status + active workflow/agent counts |
| `odw_plan` | plan a workflow; returns a compact summary (`planId`, topology, agents, cost/time) — the full plan is cached server-side, the compiled script never enters your context |
| `odw_run` | execute by `prompt` (plan+run) or by cached `planId`; `wait=true` blocks until done (~10 min cap) |
| `odw_status` | per-workflow phase, node stats, agents completed/failed, cost, failure reason |
| `odw_result` | fetch a workflow's result; `wait=true` blocks server-side |
| `odw_control` | pause / resume / stop a running workflow |
| `odw_list` | all workflows with id/status/topology/created_at |

The server is stdio-based and probes the daemon lazily: it starts fine before the daemon does, and each tool call tells you exactly what's wrong ("daemon offline — start it with: `odw-daemon start`" vs "daemon requires an auth token ...").

## Configuration snippets

Preferred local setup from a clone:

```bash
odw-daemon integrate mcp     # writes .mcp.json + AGENTS.md for generic MCP clients
odw-daemon integrate codex   # writes ~/.codex/config.toml
odw-daemon integrate cursor  # writes .cursor/mcp.json + a Cursor rule
odw-daemon integrate kimi    # writes ~/.kimi-code/mcp.json + AGENTS.md
odw-daemon integrate zed     # writes .zed/settings.json context_servers + AGENTS.md
odw-daemon integrate antigravity # writes Gemini/Antigravity mcp_config.json files + skill/workflow
odw-daemon doctor mcp        # verifies the config and daemon health
```

Generic MCP clients (`.mcp.json`), Kimi Code (`~/.kimi-code/mcp.json`), Gemini/Antigravity (`~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-cli/mcp_config.json`, `.agents/mcp_config.json`), Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and Codex (`~/.codex/config.toml` MCP section) all accept the same command shape. The installer also writes small local instructions (`AGENTS.md`, a Cursor rule, or native skills/workflows) so `workflow:`, `ultracode`, and `/deep-research` requests naturally route to the ODW tools.

```json
{
  "mcpServers": {
    "odw": {
      "command": "npx",
      "args": ["-y", "odw-mcp-server"]
    }
  }
}
```

Local-path variant (running from a clone of this repo, no npm publish needed):

```json
{
  "mcpServers": {
    "odw": {
      "command": "node",
      "args": ["/path/to/open-dynamic-workflows/packages/mcp-server/src/index.js"]
    }
  }
}
```

Codex TOML equivalent:

```toml
[mcp_servers.odw]
command = "npx"
args = ["-y", "odw-mcp-server"]
```

Zed settings equivalent:

```json
{
  "context_servers": {
    "odw": {
      "command": "npx",
      "args": ["-y", "odw-mcp-server"]
    }
  }
}
```

## Environment variables

| Variable | Effect |
|---|---|
| `ODW_DAEMON_PORT` | daemon port override (default: `daemon.port` from `~/.odw/config.json`, else `7345`) |
| `ODW_DAEMON_TOKEN` | auth token override — takes precedence over the token file |
| `ODW_HOME` | odw home directory override (default `~/.odw`) |

## The daemon must be running

This package is only the MCP bridge — the actual orchestration engine is the daemon:

```bash
git clone https://github.com/Suraj1235/open-dynamic-workflows
cd open-dynamic-workflows && npm install && npm run setup
odw-daemon start
```

When daemon auth is enabled, the token lives at `~/.odw/daemon.token` (64 hex chars). The MCP server picks it up automatically; set `ODW_DAEMON_TOKEN` to override. `GET /health` is tokenless by design, everything else requires the bearer token. Token values are never logged.
