# odw-zed

Zed Agent adapter for Open Dynamic Workflows.

## What it provides

- Project context-server config at `.zed/settings.json`.
- Managed project instructions in `AGENTS.md`.
- A project-local Zed Agent Skill at `.agents/skills/odw` so users can type `/odw` from Zed's agent message editor.
- A project-local ultracode alias at `.agents/skills/ultracode` so users can type `/ultracode` for the same ODW engine.

## Install

From the repository root:

```bash
odw-daemon integrate zed
odw-daemon doctor zed
odw-daemon start
```

Restart or reload the Zed project after installing so the Agent panel discovers the project skills.
