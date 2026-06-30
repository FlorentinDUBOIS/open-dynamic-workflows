# odw-antigravity

Google Antigravity adapter for open-dynamic-workflows.

## What this actually is

Antigravity's supported extension points are plugins, skills, saved workflows, MCP servers, and, since it is a VS Code fork, VS Code extensions. This adapter ships:

- `plugin/`: canonical Antigravity plugin-layout bundle with `plugin.json`, plugin-scoped `mcp_config.json`, `skills/`, and `rules/`. The installer stages it into all three documented locations: `~/.gemini/config/plugins/odw`, `~/.gemini/antigravity-cli/plugins/odw`, and workspace `.agents/plugins/odw`.
- `skills/odw/SKILL.md`: canonical ODW skill, installed into both `~/.gemini/config/skills/odw` and the legacy `~/.gemini/skills/odw` path, using the same bridge script style as the Codex adapter.
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

`integrate antigravity` preserves existing MCP servers and adds `mcpServers.odw` to Antigravity's global config, the Antigravity CLI config, and the workspace-local `.agents` config so both IDE and CLI-style hosts can see the ODW tools. It also installs first-class plugin bundles into `~/.gemini/config/plugins/odw`, `~/.gemini/antigravity-cli/plugins/odw`, and `.agents/plugins/odw`, then keeps direct skill installs in Antigravity's config-scoped skills directory (`~/.gemini/config/skills/odw`) and legacy skill directory (`~/.gemini/skills/odw`) as compatibility fallbacks. For Gemini CLI's separate `~/.gemini/settings.json` file, run `odw-daemon integrate gemini`.

For 100+ agents and crash-resume, the local daemon still needs to be running:

```bash
git clone https://github.com/Suraj1235/open-dynamic-workflows
cd open-dynamic-workflows
npm install
npm run setup
odw-daemon start
```
