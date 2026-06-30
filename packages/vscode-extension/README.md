# odw-vscode

VS Code extension for Open Dynamic Workflows.

## What it provides

- Activity bar container named Dynamic Workflows.
- Workflow tree view backed by the local `odw-daemon` API.
- Dashboard webview for workflow status, agent counts, costs, and prompts.
- Status bar item that distinguishes healthy, offline, and auth-token-needed daemon states.
- Commands to run, pause, resume, stop, and inspect workflows.

## Install from this repo

From the repository root:

```bash
odw-daemon integrate vscode
odw-daemon doctor vscode
odw-daemon start
```

The installer copies this unpacked extension into `~/.vscode/extensions/open-dynamic-workflows.odw-vscode-0.1.0`. Restart VS Code after installing so the extension host discovers it.

When daemon auth is enabled, the extension reads the token from the `odw.daemonToken` setting, `ODW_DAEMON_TOKEN`, or `~/.odw/daemon.token`, in that order.
