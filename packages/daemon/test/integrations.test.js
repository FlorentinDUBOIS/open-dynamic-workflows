import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  doctorAgentIntegration,
  installAgentIntegration,
  installCodexMcp,
  installCursorMcp,
  installGenericMcpConfig,
  installKimiMcp,
  installOpencodePlugin,
  installZedMcp,
  mcpServerCommand,
} from '../src/integrations.js';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), name));
}

test('mcpServerCommand points every MCP host at the local ODW MCP server', () => {
  const command = mcpServerCommand({ repoRoot });
  assert.equal(command.command, 'node');
  assert.ok(command.args[0].endsWith('packages/mcp-server/src/index.js'));
});

test('installCursorMcp writes an idempotent .cursor/mcp.json with an odw server', () => {
  const targetDir = tempDir('odw-cursor-');
  try {
    installCursorMcp({ targetDir, repoRoot });
    installCursorMcp({ targetDir, repoRoot });

    const path = join(targetDir, '.cursor', 'mcp.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(data.mcpServers), ['odw']);
    assert.equal(data.mcpServers.odw.command, 'node');
    assert.ok(data.mcpServers.odw.args[0].includes('mcp-server'));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installGenericMcpConfig writes an importable project MCP config', () => {
  const targetDir = tempDir('odw-generic-mcp-');
  try {
    writeFileSync(join(targetDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        existing: { command: 'node', args: ['server.js'] },
      },
    }));

    installGenericMcpConfig({ targetDir, repoRoot });
    installGenericMcpConfig({ targetDir, repoRoot });

    const data = JSON.parse(readFileSync(join(targetDir, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(data.mcpServers).sort(), ['existing', 'odw']);
    assert.equal(data.mcpServers.odw.command, 'node');
    assert.ok(data.mcpServers.odw.args[0].includes('mcp-server'));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installKimiMcp writes Kimi Code CLI global MCP config', () => {
  const home = tempDir('odw-kimi-');
  try {
    installKimiMcp({ home, repoRoot });
    installKimiMcp({ home, repoRoot });

    const data = JSON.parse(readFileSync(join(home, '.kimi-code', 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(data.mcpServers), ['odw']);
    assert.equal(data.mcpServers.odw.command, 'node');
    assert.ok(data.mcpServers.odw.args[0].includes('mcp-server'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installZedMcp writes project Zed context server settings', () => {
  const targetDir = tempDir('odw-zed-');
  try {
    mkdirSync(join(targetDir, '.zed'), { recursive: true });
    writeFileSync(join(targetDir, '.zed', 'settings.json'), JSON.stringify({
      theme: 'One Dark',
      context_servers: {
        existing: { command: 'node', args: ['server.js'] },
      },
    }));

    installZedMcp({ targetDir, repoRoot });
    installZedMcp({ targetDir, repoRoot });

    const data = JSON.parse(readFileSync(join(targetDir, '.zed', 'settings.json'), 'utf8'));
    assert.equal(data.theme, 'One Dark');
    assert.deepEqual(Object.keys(data.context_servers).sort(), ['existing', 'odw']);
    assert.equal(data.context_servers.odw.command, 'node');
    assert.ok(data.context_servers.odw.args[0].includes('mcp-server'));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installCodexMcp preserves existing config and replaces the managed odw block', () => {
  const home = tempDir('odw-codex-');
  try {
    const codexDir = join(home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'config.toml'), 'model = "gpt-5"\n', { flag: 'w' });

    installCodexMcp({ home, repoRoot });
    installCodexMcp({ home, repoRoot });

    const text = readFileSync(join(codexDir, 'config.toml'), 'utf8');
    assert.match(text, /model = "gpt-5"/);
    assert.equal((text.match(/\[mcp_servers\.odw\]/g) ?? []).length, 1);
    assert.match(text, /command = "node"/);
    assert.match(text, /mcp-server\/src\/index\.js/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('installOpencodePlugin writes a local plugin wrapper and slash commands', () => {
  const targetDir = tempDir('odw-opencode-');
  try {
    installOpencodePlugin({ targetDir, repoRoot });
    const plugin = readFileSync(join(targetDir, '.opencode', 'plugins', 'odw.mjs'), 'utf8');
    assert.match(plugin, /packages\/opencode-plugin\/src\/index\.js/);
    assert.ok(existsSync(join(targetDir, '.opencode', 'commands', 'ultracode.md')));
    assert.ok(existsSync(join(targetDir, '.opencode', 'commands', 'workflows.md')));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installAgentIntegration copies native skill folders for codex, antigravity, and openclaw', () => {
  const home = tempDir('odw-skills-');
  try {
    const codex = installAgentIntegration('codex-skill', { home, repoRoot });
    const antigravity = installAgentIntegration('antigravity', { home, repoRoot });
    const openclaw = installAgentIntegration('openclaw', { home, repoRoot });

    assert.ok(existsSync(join(home, '.agents', 'skills', 'odw', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.gemini', 'skills', 'odw', 'SKILL.md')));
    assert.ok(existsSync(join(home, '.gemini', 'antigravity', 'global_workflows', 'odw-run.md')));
    assert.ok(existsSync(join(home, '.openclaw', 'skills', 'open-dynamic-workflows', 'SKILL.md')));
    assert.equal(codex.kind, 'codex-skill');
    assert.equal(antigravity.kind, 'antigravity');
    assert.equal(openclaw.kind, 'openclaw');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli integrate command installs a requested agent integration', () => {
  const targetDir = tempDir('odw-cli-target-');
  const home = tempDir('odw-cli-home-');
  try {
    const output = execFileSync(
      process.execPath,
      [
        join(repoRoot, 'packages', 'daemon', 'src', 'cli.js'),
        'integrate',
        'kimi',
        '--target',
        targetDir,
        '--home',
        home,
        '--repo',
        repoRoot,
      ],
      { encoding: 'utf8', env: { ...process.env, ODW_HOME: home } }
    );
    assert.match(output, /kimi/);
    assert.ok(existsSync(join(home, '.kimi-code', 'mcp.json')));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctorAgentIntegration reports missing integration files without throwing', () => {
  const targetDir = tempDir('odw-doctor-missing-target-');
  const home = tempDir('odw-doctor-missing-home-');
  try {
    const result = doctorAgentIntegration('kimi', { targetDir, home, repoRoot });

    assert.equal(result.kind, 'kimi');
    assert.equal(result.ok, false);
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].ok, false);
    assert.match(result.checks[0].message, /missing/);
    assert.match(result.checks[0].path, /\.kimi-code/);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('doctorAgentIntegration verifies every installed integration in all mode', () => {
  const targetDir = tempDir('odw-doctor-all-target-');
  const home = tempDir('odw-doctor-all-home-');
  try {
    installAgentIntegration('all', { targetDir, home, repoRoot });

    const result = doctorAgentIntegration('all', { targetDir, home, repoRoot });
    assert.equal(result.kind, 'all');
    assert.equal(result.ok, true);
    assert.ok(result.checks.length >= 11);
    assert.ok(result.checks.some((check) => check.label === 'kimi mcp config'));
    assert.ok(result.checks.some((check) => check.label === 'zed context server config'));
    assert.ok(result.checks.every((check) => check.ok));
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('cli doctor command prints a failing readiness report', () => {
  const targetDir = tempDir('odw-cli-doctor-target-');
  const home = tempDir('odw-cli-doctor-home-');
  try {
    assert.throws(
      () => execFileSync(
        process.execPath,
        [
          join(repoRoot, 'packages', 'daemon', 'src', 'cli.js'),
          'doctor',
          'mcp',
          '--target',
          targetDir,
          '--home',
          home,
          '--repo',
          repoRoot,
        ],
        { encoding: 'utf8', env: { ...process.env, ODW_HOME: home } }
      ),
      (error) => {
        assert.equal(error.status, 1);
        assert.match(error.stdout, /mcp integration/);
        assert.match(error.stdout, /missing/);
        return true;
      }
    );
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
