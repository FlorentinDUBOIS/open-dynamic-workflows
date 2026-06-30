# odw-antigravity

Google Antigravity adapter for open-dynamic-workflows.

## What this actually is

Antigravity's supported extension points are skills (`~/.gemini/skills/`), saved workflows (`~/.gemini/antigravity/global_workflows/`), MCP servers, and, since it is a VS Code fork, VS Code extensions. This adapter ships:

- `skills/odw/SKILL.md`: canonical ODW skill, using the same bridge script style as the Codex adapter.
- `workflows/odw-run.md`: a saved `/odw-run` workflow.
- MCP config installers for `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-cli/mcp_config.json`, and workspace `.agents/mcp_config.json`.
- The `odw-vscode` extension from this monorepo, which installs in Antigravity unchanged and provides the live dashboard.

There is no official Antigravity automation API. Community CDP bridges exist but are unofficial, so this adapter deliberately does not depend on one.

## Install

From the repository root:

```bash
odw-daemon integrate antigravity
odw-daemon doctor antigravity
```

`integrate antigravity` preserves existing MCP servers and adds `mcpServers.odw` to Antigravity's global config, the Antigravity CLI config, and the workspace-local `.agents` config so both IDE and CLI-style hosts can see the ODW tools. For Gemini CLI's separate `~/.gemini/settings.json` file, run `odw-daemon integrate gemini`.

For 100+ agents and crash-resume, the local daemon still needs to be running:

```bash
git clone https://github.com/Suraj1235/open-dynamic-workflows
cd open-dynamic-workflows
npm install
npm run setup
odw-daemon start
```
