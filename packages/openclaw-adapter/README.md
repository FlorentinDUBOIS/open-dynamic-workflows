# odw-openclaw

OpenClaw adapter for open-dynamic-workflows — a [ClawHub](https://clawhub.ai)-publishable skill plus a zero-dependency daemon bridge.

## What this is

A skill folder (`skills/open-dynamic-workflows/`) in ClawHub's format: a `SKILL.md` with `metadata.openclaw` frontmatter, a `scripts/daemon-bridge.js` bridge to the local ODW daemon's HTTP API, and a `.clawhubignore`. The skill teaches OpenClaw to plan, orchestrate, and adversarially verify parallel agents through the daemon.

## Install (local)

Copy the skill into OpenClaw's skills directory:

```bash
cp -r skills/open-dynamic-workflows ~/.openclaw/skills/   # path per your OpenClaw setup
```

Then, for 100+ agents + crash-resume, install the daemon (not on npm yet):

```bash
git clone https://github.com/Suraj1235/open-dynamic-workflows
cd open-dynamic-workflows && npm install && npm run setup
odw-daemon start
```

## Publish to ClawHub

ClawHub publishing uses the `clawhub` CLI and requires **Node ≥ 20.12** (the CLI imports `node:util` `styleText`) and a ClawHub account/login:

```bash
npm install -g clawhub
clawhub login                       # authenticate (one-time)
cd skills/open-dynamic-workflows
clawhub publish                     # publishes this skill folder; metadata is read from SKILL.md frontmatter
```

The publishable unit is the `skills/open-dynamic-workflows/` folder — ClawHub extracts `name`, `description`, `version`, and `metadata.openclaw` from the `SKILL.md` frontmatter.
