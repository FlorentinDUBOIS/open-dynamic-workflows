/**
 * Open Dynamic Workflows — VS Code extension (plain CJS, no bundler).
 * Tree view + webview dashboard + status bar, all backed by the local
 * odw daemon's HTTP/WS API. Also works in VS Code forks (Antigravity).
 */

'use strict';

/** @param {import('vscode').ExtensionContext} context */
function activate(context) {
  void context;
  throw new Error('not implemented (P4)');
}

function deactivate() {}

module.exports = { activate, deactivate };
