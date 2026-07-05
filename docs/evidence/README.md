# ODW Evidence Pack

ODW should earn attention with reproducible proof, not launch copy. This folder tracks the public evidence maintainers want before expanding claims in the README.

## Current Claim Boundaries

- **OpenCode:** strongest validated path. ODW can run through the daemon and has a host-native route when the host exposes model access.
- **Codex:** plugin and MCP path are installable locally. Codex does not currently expose a documented host-native model API to third-party plugins, so full ODW runs use the local daemon/provider path.
- **Cursor, Antigravity, VS Code, Zed/zcode, Gemini CLI, Kimi:** adapter paths exist, but each needs more external host validation before parity claims should be strengthened.
- **Local-first mode:** daemon/provider mode supports local endpoints such as Ollama where configured.

## Proof Checklist

Run these from a fresh clone and paste notable output into issues or discussions:

```bash
npm ci
npm test
npm run test:external
npm run lint
npm audit --audit-level=high
npm run smoke:hosts -- --json
npm run odw -- doctor all --json
```

Host-specific proof is strongest when it includes:

- Host name and version.
- ODW commit SHA.
- OS and Node version.
- Whether the model path was host-native, daemon with provider key, daemon with local/Ollama endpoint, or MCP bridge only.
- A real workflow result, not only adapter discovery.

## Validation Matrix

| Host | Expected path | Evidence target | Status wording |
| --- | --- | --- | --- |
| OpenCode | Native host model where available, daemon fallback | 20-agent run, resume, smoke output | Proven strongest path when reproduced |
| Codex | Codex plugin + MCP bridge + ODW daemon | plugin install, tool list, plan/run, doctor | Installable integration path |
| Cursor | Rules/skill adapter + daemon | install, doctor, smoke, workflow | Needs external validation |
| Antigravity | skill/workflow adapter + daemon | install, doctor, smoke, workflow | Needs external validation |
| VS Code | extension/client + daemon | extension load, doctor, workflow | Needs external validation |
| Zed/zcode | skill adapter + daemon | install, doctor, smoke, workflow | Needs external validation |
| Gemini CLI | command adapter + daemon | install, doctor, smoke, workflow | Needs external validation |
| Kimi | skill adapter + daemon | install, doctor, smoke, workflow | Needs external validation |

## Public CTA

When sharing ODW, keep the ask simple:

```text
Star it if you want open ultracode. Try it on your coder. Paste one host result from `npm run smoke:hosts -- --json`.
```
