# odw-antigravity

Google Antigravity adapter for open-dynamic-workflows.

## What this actually is

Antigravity's supported extension points are **skills** (`~/.gemini/skills/`), **saved workflows** (`~/.gemini/antigravity/global_workflows/`), **MCP servers**, and — since it is a VS Code fork — **VS Code extensions**. This adapter ships:

- `skills/odw/SKILL.md` — canonical odw skill (same format as the Codex adapter)
- `workflows/odw-run.md` — a saved `/odw-run` workflow
- the `odw-vscode` extension from this monorepo installs in Antigravity unchanged and provides the live dashboard

There is **no official Antigravity automation API**; community CDP bridges exist but are unofficial, so this adapter deliberately does not depend on one.

## Install

```bash
mkdir -p ~/.gemini/skills/odw
cp -r skills/odw/* ~/.gemini/skills/odw/
cp -r ../codex-adapter/scripts ~/.gemini/skills/odw/scripts   # shared bridge
cp workflows/odw-run.md ~/.gemini/antigravity/global_workflows/

# optional, for 100+ agents + crash-resume:
npm install -g odw-daemon && odw-daemon start
```
