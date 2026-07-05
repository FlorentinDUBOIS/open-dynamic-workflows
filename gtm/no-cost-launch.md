# No-Cost GTM Plan For Open Dynamic Workflows

ODW is an open-source credibility project. The goal is stars, users, public feedback, and proof that the architecture works across agentic coding tools.

## Positioning

Use this line when the audience already understands Claude Code:

> Claude Code-style dynamic workflows / ultracode for every agentic coder, local-first and MIT.

Use this more careful line when speaking to a broader audience:

> ODW turns multi-agent coding workflows into local, scriptable runs that can plug into agentic coding tools through adapters, MCP, and a daemon.

Avoid saying "parity everywhere" until the evidence matrix supports it.

## Launch Sequence

| Timing | Action | Surface |
| --- | --- | --- |
| T-7 to T-3 | Collect proof pack: fresh install, tests, smoke, doctor, OpenCode run, Codex MCP path, local/Ollama path, crash-resume | `docs/evidence/`, Discussions |
| T-7 to T-3 | Open host validation issues for OpenCode, Codex, Cursor, Antigravity, VS Code, Zed/zcode, Gemini CLI, Kimi | GitHub Issues |
| T-2 | Publish build-in-public thread: what broke while cloning dynamic workflows outside Claude Code | X/LinkedIn |
| T-0 | Post Show HN with evidence-first framing | Hacker News |
| T+1 | Post local/no-cost angle | r/LocalLLaMA |
| T+3 | Publish technical article: "The script is the orchestrator, not the model" | dev.to/blog |
| T+7 | Publish week-one evidence and failures | GitHub Discussion + social |
| T+14 | Publish host-native vs daemon model access post | blog/social |
| T+30 | Publish evidence matrix; decide whether Product Hunt is worth it | GitHub + social |

## Issue Seeds

Open these as public issues when ready:

- `host validation: OpenCode native 20-agent run`
- `host validation: Codex plugin + MCP bridge`
- `host validation: Cursor adapter`
- `host validation: Antigravity adapter`
- `host validation: VS Code extension`
- `host validation: Zed/zcode skill adapter`
- `host validation: Gemini CLI command adapter`
- `host validation: Kimi adapter`
- `good first issue: improve failed host probe message`
- `good first issue: add one real-world workflow fixture`

## Post Templates

### Founder Credibility

```text
I wanted Claude Code-style dynamic workflows outside Claude Code, so I built the local MIT version.

ODW treats the model as the author, but the script as the orchestrator: plan, fan out agents, checkpoint state, resume, and verify.

The honest state: OpenCode is the strongest path; Codex has a plugin/MCP bridge; the other hosts need more validation.

Star it if you want open ultracode. Try one command and paste your host result:
npm run smoke:hosts -- --json
```

### Evidence-First Launch

```text
Show HN: Open Dynamic Workflows - Claude Code-style ultracode for any agentic coder

ODW is a local-first MIT project for dynamic multi-agent coding workflows. It includes a daemon, MCP bridge, QuickJS sandbox, crash-resume state, and adapters for multiple agentic coding hosts.

I am launching it as a technical beta, not a finished parity claim. The ask is simple: star it, run the host smoke, and share what works or fails on your setup.
```

### Week-One Follow-Up

```text
Week 1 ODW evidence report:

Stars:
Install reports:
Host validations:
Failures found:
Fixes shipped:
Still blocked:

This is the useful part of open source: the failures make the product real.
```

## Success Metrics

| Window | Minimum target | Stretch |
| --- | --- | --- |
| 7 days | 50 stars, 5 install reports, 2 external host validations, 3 substantive issues | HN discussion with real technical feedback |
| 30 days | 150 stars, 15 install reports, 5 external host validations, 3 outside contributions | 300+ stars and one respected builder independently testing it |

## Operating Rules

- No paid ads, launch pods, star buying, or artificial upvotes.
- No README expansion until the evidence pack is stable.
- Claims stay evidence-bound: host-native where proven, daemon/MCP integration where that is what exists.
- Every public post should ask for one concrete action: star, run one command, or file one host result.
