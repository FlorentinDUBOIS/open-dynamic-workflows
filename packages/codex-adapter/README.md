# odw-codex

Codex CLI adapter for open-dynamic-workflows.

## What this actually is

Codex has no plugin marketplace and no `.codex-plugin` manifest format — its real extension points are **AGENTS.md**, **skill folders**, and **MCP client config**. This adapter uses the first two:

- `skills/odw/SKILL.md` — the skill that teaches Codex to plan and orchestrate through the local daemon
- `scripts/daemon-bridge.js` — zero-dependency CJS bridge to the daemon's HTTP API
- `AGENTS.md` — drop-in instruction block for repos
- `plugin.json` — descriptive metadata only (kept for ecosystem tooling; Codex does not read it)

## Install

```bash
# user-level skill
mkdir -p ~/.agents/skills/odw
cp -r skills/odw/* ~/.agents/skills/odw/
cp -r scripts ~/.agents/skills/odw/scripts

# or repo-level
mkdir -p .agents/skills/odw
cp -r skills/odw/* scripts .agents/skills/odw/
```

Then (optional, for 100+ agents + crash-resume) install the daemon from GitHub (not yet on npm):

```bash
git clone https://github.com/Suraj1235/open-dynamic-workflows
cd open-dynamic-workflows && npm install && npm run setup
odw-daemon start
```

Without the daemon the skill still works — it falls back to Codex's native subagents (hard-capped by the platform).
