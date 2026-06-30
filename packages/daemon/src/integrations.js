/**
 * Agentic-coder integration installers.
 *
 * MCP is the universal lane: Cursor, Codex, Kimi Code, Zed, Cline/Windsurf-
 * style clients, and other MCP hosts can all point at
 * packages/mcp-server/src/index.js. Native adapters remain available where the
 * host exposes better hooks (OpenCode plugin, Codex/Antigravity/OpenClaw
 * skills).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const MANAGED_BEGIN = '# BEGIN open-dynamic-workflows';
const MANAGED_END = '# END open-dynamic-workflows';
const AGENTS_BEGIN = '<!-- BEGIN open-dynamic-workflows -->';
const AGENTS_END = '<!-- END open-dynamic-workflows -->';
const GEMINI_BEGIN = '<!-- BEGIN open-dynamic-workflows -->';
const GEMINI_END = '<!-- END open-dynamic-workflows -->';

export function mcpServerCommand({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  return {
    command: 'node',
    args: [slash(join(repoRoot, 'packages', 'mcp-server', 'src', 'index.js'))],
  };
}

export function installCursorMcp({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(targetDir, '.cursor', 'mcp.json');
  const current = writeMcpServersJson(path, repoRoot);
  const rulePath = installCursorRule({ targetDir });
  const skillPath = installCursorSkill({ targetDir, repoRoot });
  return { kind: 'cursor', path, rulePath, skillPath, server: current.mcpServers.odw };
}

export function installGenericMcpConfig({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(targetDir, '.mcp.json');
  const current = writeMcpServersJson(path, repoRoot);
  const instructionsPath = installAgentInstructions({ targetDir, host: 'generic MCP hosts' });
  return { kind: 'mcp', path, instructionsPath, server: current.mcpServers.odw };
}

export function installKimiMcp({ home = homedir(), targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(home, '.kimi-code', 'mcp.json');
  const current = writeMcpServersJson(path, repoRoot);
  const instructionsPath = installAgentInstructions({ targetDir, host: 'Kimi Code' });
  const skillPath = installKimiSkill({ targetDir, repoRoot });
  return { kind: 'kimi', path, instructionsPath, skillPath, server: current.mcpServers.odw };
}

export function installGeminiMcp({ home = homedir(), targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(home, '.gemini', 'settings.json');
  const current = writeMcpServersJson(path, repoRoot);
  const instructionsPath = installGeminiInstructions({ targetDir });
  return { kind: 'gemini', path, instructionsPath, server: current.mcpServers.odw };
}

export function installZedMcp({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(targetDir, '.zed', 'settings.json');
  const current = readJson(path, { context_servers: {} });
  current.context_servers = objectOrEmpty(current.context_servers);
  current.context_servers.odw = mcpServerCommand({ repoRoot });
  writeJson(path, current);
  const instructionsPath = installAgentInstructions({ targetDir, host: 'Zed' });
  return { kind: 'zed', path, instructionsPath, server: current.context_servers.odw };
}

export function installCodexMcp({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const path = join(home, '.codex', 'config.toml');
  const current = readText(path, '');
  const block = [
    MANAGED_BEGIN,
    '[mcp_servers.odw]',
    'command = "node"',
    `args = [${JSON.stringify(mcpServerCommand({ repoRoot }).args[0])}]`,
    MANAGED_END,
    '',
  ].join('\n');
  writeText(path, replaceManagedBlock(current, block));
  return { kind: 'codex-mcp', path };
}

export function installCodexSkill({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(home, '.agents', 'skills', 'odw');
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'skills', 'odw'), dest);
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'scripts'), join(dest, 'scripts'));
  return { kind: 'codex-skill', path: dest };
}

export function installCursorSkill({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(targetDir, '.cursor', 'skills', 'odw');
  copyFresh(join(repoRoot, 'packages', 'cursor-adapter', 'skills', 'odw'), dest);
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'scripts'), join(dest, 'scripts'));
  return dest;
}

export function installKimiSkill({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(targetDir, '.kimi', 'skills', 'odw');
  copyFresh(join(repoRoot, 'packages', 'kimi-adapter', 'skills', 'odw'), dest);
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'scripts'), join(dest, 'scripts'));
  return dest;
}

export function installAntigravity({ home = homedir(), targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const skillDest = join(home, '.gemini', 'skills', 'odw');
  copyFresh(join(repoRoot, 'packages', 'antigravity-adapter', 'skills', 'odw'), skillDest);
  copyFresh(join(repoRoot, 'packages', 'codex-adapter', 'scripts'), join(skillDest, 'scripts'));

  const workflowDest = join(home, '.gemini', 'antigravity', 'global_workflows', 'odw-run.md');
  ensureDir(dirname(workflowDest));
  cpSync(join(repoRoot, 'packages', 'antigravity-adapter', 'workflows', 'odw-run.md'), workflowDest);

  const geminiMcpPath = join(home, '.gemini', 'config', 'mcp_config.json');
  const antigravityCliMcpPath = join(home, '.gemini', 'antigravity-cli', 'mcp_config.json');
  const workspaceMcpPath = join(targetDir, '.agents', 'mcp_config.json');
  writeMcpServersJson(geminiMcpPath, repoRoot);
  writeMcpServersJson(antigravityCliMcpPath, repoRoot);
  writeMcpServersJson(workspaceMcpPath, repoRoot);

  return {
    kind: 'antigravity',
    skillPath: skillDest,
    workflowPath: workflowDest,
    geminiMcpPath,
    antigravityCliMcpPath,
    workspaceMcpPath,
  };
}

export function installOpenClaw({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const dest = join(home, '.openclaw', 'skills', 'open-dynamic-workflows');
  copyFresh(join(repoRoot, 'packages', 'openclaw-adapter', 'skills', 'open-dynamic-workflows'), dest);
  return { kind: 'openclaw', path: dest };
}

export function installOpencodePlugin({ targetDir = process.cwd(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const pluginDir = join(targetDir, '.opencode', 'plugins');
  ensureDir(pluginDir);
  const pluginPath = join(pluginDir, 'odw.mjs');
  const pluginUrl = pathToFileURL(join(repoRoot, 'packages', 'opencode-plugin', 'src', 'index.js')).href;
  writeText(pluginPath, [
    '// Generated by open-dynamic-workflows. Keep this tiny wrapper in your project.',
    `export { default } from ${JSON.stringify(pluginUrl)};`,
    `export * from ${JSON.stringify(pluginUrl)};`,
    '',
  ].join('\n'));

  const commandsDest = join(targetDir, '.opencode', 'commands');
  ensureDir(commandsDest);
  cpSync(join(repoRoot, 'packages', 'opencode-plugin', 'commands', 'ultracode.md'), join(commandsDest, 'ultracode.md'));
  cpSync(join(repoRoot, 'packages', 'opencode-plugin', 'commands', 'workflows.md'), join(commandsDest, 'workflows.md'));
  return { kind: 'opencode', pluginPath, commandsPath: commandsDest };
}

export function installVscodeExtension({ home = homedir(), repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const src = join(repoRoot, 'packages', 'vscode-extension');
  const manifest = readJson(join(src, 'package.json'), {});
  const extensionId = `${manifest.publisher}.${manifest.name}-${manifest.version}`;
  const dest = join(home, '.vscode', 'extensions', extensionId);
  copyFresh(src, dest);
  return { kind: 'vscode', path: dest };
}

export function installAgentIntegration(kind, options = {}) {
  switch (kind) {
    case 'mcp':
    case 'generic-mcp':
      return installGenericMcpConfig(options);
    case 'codex':
      return { kind, steps: [installCodexMcp(options), installCodexSkill(options)] };
    case 'codex-mcp':
      return installCodexMcp(options);
    case 'codex-skill':
      return installCodexSkill(options);
    case 'cursor':
      return installCursorMcp(options);
    case 'kimi':
    case 'kimi-code':
      return installKimiMcp(options);
    case 'gemini':
    case 'gemini-cli':
      return installGeminiMcp(options);
    case 'zed':
      return installZedMcp(options);
    case 'zcode':
      return { kind, steps: [installGenericMcpConfig(options), installZedMcp(options)] };
    case 'opencode':
      return installOpencodePlugin(options);
    case 'vscode':
    case 'vs-code':
      return installVscodeExtension(options);
    case 'antigravity':
      return installAntigravity(options);
    case 'openclaw':
      return installOpenClaw(options);
    case 'all':
      return {
        kind,
        steps: [
          installGenericMcpConfig(options),
          installCodexMcp(options),
          installCodexSkill(options),
          installCursorMcp(options),
          installKimiMcp(options),
          installGeminiMcp(options),
          installZedMcp(options),
          installOpencodePlugin(options),
          installVscodeExtension(options),
          installAntigravity(options),
          installOpenClaw(options),
        ],
      };
    default:
      throw new Error(`unknown integration "${kind}" (valid: mcp, codex, codex-mcp, codex-skill, cursor, kimi, gemini, zed, zcode, opencode, vscode, antigravity, openclaw, all)`);
  }
}

export function doctorAgentIntegration(kind = 'all', options = {}) {
  const checks = doctorChecksFor(kind, options);
  return {
    kind,
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function doctorChecksFor(kind, options = {}) {
  switch (kind) {
    case 'mcp':
    case 'generic-mcp':
      return [
        checkMcpJson('generic mcp config', join(options.targetDir ?? process.cwd(), '.mcp.json'), 'mcpServers', options),
        checkAgentInstructions('generic agent instructions', options.targetDir ?? process.cwd()),
      ];
    case 'codex':
      return [...doctorChecksFor('codex-mcp', options), ...doctorChecksFor('codex-skill', options)];
    case 'codex-mcp':
      return [checkText('codex mcp config', join(options.home ?? homedir(), '.codex', 'config.toml'), [
        '[mcp_servers.odw]',
        mcpServerCommand(options).args[0],
      ])];
    case 'codex-skill':
      return [
        checkExists('codex skill', join(options.home ?? homedir(), '.agents', 'skills', 'odw', 'SKILL.md')),
        checkExists('codex daemon bridge', join(options.home ?? homedir(), '.agents', 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
      ];
    case 'cursor':
      return [
        checkMcpJson('cursor mcp config', join(options.targetDir ?? process.cwd(), '.cursor', 'mcp.json'), 'mcpServers', options),
        checkText('cursor workflow rule', join(options.targetDir ?? process.cwd(), '.cursor', 'rules', 'open-dynamic-workflows.mdc'), [
          'alwaysApply: true',
          'odw_run',
          'ultracode',
        ]),
        checkExists('cursor agent skill', join(options.targetDir ?? process.cwd(), '.cursor', 'skills', 'odw', 'SKILL.md')),
        checkExists('cursor daemon bridge', join(options.targetDir ?? process.cwd(), '.cursor', 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
      ];
    case 'kimi':
    case 'kimi-code':
      return [
        checkMcpJson('kimi mcp config', join(options.home ?? homedir(), '.kimi-code', 'mcp.json'), 'mcpServers', options),
        checkAgentInstructions('kimi agent instructions', options.targetDir ?? process.cwd()),
        checkText('kimi flow skill', join(options.targetDir ?? process.cwd(), '.kimi', 'skills', 'odw', 'SKILL.md'), [
          'type: flow',
          '/flow:odw',
          'daemon-bridge.js --check',
        ]),
        checkExists('kimi daemon bridge', join(options.targetDir ?? process.cwd(), '.kimi', 'skills', 'odw', 'scripts', 'daemon-bridge.js')),
      ];
    case 'gemini':
    case 'gemini-cli':
      return [
        checkMcpJson('gemini mcp config', join(options.home ?? homedir(), '.gemini', 'settings.json'), 'mcpServers', options),
        checkGeminiInstructions('gemini project instructions', options.targetDir ?? process.cwd()),
      ];
    case 'zed':
      return [
        checkMcpJson('zed context server config', join(options.targetDir ?? process.cwd(), '.zed', 'settings.json'), 'context_servers', options),
        checkAgentInstructions('zed agent instructions', options.targetDir ?? process.cwd()),
      ];
    case 'zcode':
      return [...doctorChecksFor('mcp', options), ...doctorChecksFor('zed', options)];
    case 'opencode':
      return [
        checkExists('opencode plugin wrapper', join(options.targetDir ?? process.cwd(), '.opencode', 'plugins', 'odw.mjs')),
        checkExists('opencode ultracode command', join(options.targetDir ?? process.cwd(), '.opencode', 'commands', 'ultracode.md')),
        checkExists('opencode workflows command', join(options.targetDir ?? process.cwd(), '.opencode', 'commands', 'workflows.md')),
      ];
    case 'vscode':
    case 'vs-code':
      return [
        checkExists('vscode extension', join(vscodeExtensionPath(options), 'package.json')),
        checkExists('vscode extension entrypoint', join(vscodeExtensionPath(options), 'extension.js')),
        checkExists('vscode extension icon', join(vscodeExtensionPath(options), 'media', 'icon.svg')),
      ];
    case 'antigravity':
      return [
        checkExists('antigravity skill', join(options.home ?? homedir(), '.gemini', 'skills', 'odw', 'SKILL.md')),
        checkExists('antigravity saved workflow', join(options.home ?? homedir(), '.gemini', 'antigravity', 'global_workflows', 'odw-run.md')),
        checkMcpJson('antigravity gemini mcp config', join(options.home ?? homedir(), '.gemini', 'config', 'mcp_config.json'), 'mcpServers', options),
        checkMcpJson('antigravity cli mcp config', join(options.home ?? homedir(), '.gemini', 'antigravity-cli', 'mcp_config.json'), 'mcpServers', options),
        checkMcpJson('antigravity workspace mcp config', join(options.targetDir ?? process.cwd(), '.agents', 'mcp_config.json'), 'mcpServers', options),
      ];
    case 'openclaw':
      return [checkExists('openclaw skill', join(options.home ?? homedir(), '.openclaw', 'skills', 'open-dynamic-workflows', 'SKILL.md'))];
    case 'all':
      return [
        ...doctorChecksFor('mcp', options),
        ...doctorChecksFor('codex', options),
        ...doctorChecksFor('cursor', options),
        ...doctorChecksFor('kimi', options),
        ...doctorChecksFor('gemini', options),
        ...doctorChecksFor('zed', options),
        ...doctorChecksFor('opencode', options),
        ...doctorChecksFor('vscode', options),
        ...doctorChecksFor('antigravity', options),
        ...doctorChecksFor('openclaw', options),
      ];
    default:
      throw new Error(`unknown integration "${kind}" (valid: mcp, codex, codex-mcp, codex-skill, cursor, kimi, gemini, zed, zcode, opencode, vscode, antigravity, openclaw, all)`);
  }
}

function installAgentInstructions({ targetDir = process.cwd(), host = 'MCP host' } = {}) {
  const path = join(targetDir, 'AGENTS.md');
  const block = [
    AGENTS_BEGIN,
    '## Open Dynamic Workflows',
    '',
    `For ${host}, route substantial workflow requests through the ODW MCP server when it is available.`,
    '',
    'Use ODW when the user says `workflow:`, `ultracode`, `/deep-research`, or asks for broad multi-file work that benefits from planning, parallel agents, verification, or crash-resumable execution.',
    '',
    '- Call `odw_health` first when uncertain whether the daemon is reachable.',
    '- Use `odw_run` for direct execution. Use `odw_plan` first when the user asks to review the plan, the task is expensive, or mutation risk is high.',
    '- Report the workflow id, topology, agent count, and cost/time estimate instead of redoing the work manually.',
    '- Use `odw_status`, `odw_result`, and `odw_list` to monitor and summarize running work.',
    '- If ODW is unavailable, say exactly what is missing (`odw-daemon start` or `odw-daemon doctor <agent>`) and then fall back to the host agent native planning only if useful.',
    '',
    AGENTS_END,
    '',
  ].join('\n');
  writeText(path, replaceManagedSection(readText(path, ''), block, AGENTS_BEGIN, AGENTS_END));
  return path;
}

function installCursorRule({ targetDir = process.cwd() } = {}) {
  const path = join(targetDir, '.cursor', 'rules', 'open-dynamic-workflows.mdc');
  writeText(path, [
    '---',
    'description: Route workflow, ultracode, and deep-research requests through Open Dynamic Workflows',
    'alwaysApply: true',
    '---',
    '',
    '# Open Dynamic Workflows',
    '',
    'When the user says `workflow:`, `ultracode`, `/deep-research`, or asks for broad multi-file work that benefits from planning, parallel agents, verification, or crash-resumable execution, prefer the ODW MCP tools.',
    '',
    '- Call `odw_health` first when uncertain whether the daemon is reachable.',
    '- Use `odw_run` for direct execution. Use `odw_plan` first when the user asks to review the plan, the task is expensive, or mutation risk is high.',
    '- Report the workflow id, topology, agent count, and cost/time estimate instead of redoing the work manually.',
    '- Use `odw_status`, `odw_result`, and `odw_list` to monitor and summarize running work.',
    '- If ODW is unavailable, say exactly what is missing (`odw-daemon start` or `odw-daemon doctor cursor`) and then fall back to Cursor-native planning only if useful.',
    '',
  ].join('\n'));
  return path;
}

function installGeminiInstructions({ targetDir = process.cwd() } = {}) {
  const path = join(targetDir, 'GEMINI.md');
  const block = [
    GEMINI_BEGIN,
    '## Open Dynamic Workflows',
    '',
    'For Gemini CLI, route substantial workflow requests through the ODW MCP server when it is available.',
    '',
    'Use ODW when the user says `workflow:`, `ultracode`, `/deep-research`, or asks for broad multi-file work that benefits from planning, parallel agents, verification, or crash-resumable execution.',
    '',
    '- Gemini CLI exposes ODW tools with the MCP prefix: `mcp_odw_odw_health`, `mcp_odw_odw_plan`, `mcp_odw_odw_run`, `mcp_odw_odw_status`, `mcp_odw_odw_result`, `mcp_odw_odw_list`, and `mcp_odw_odw_control`.',
    '- Call `mcp_odw_odw_health` first when uncertain whether the daemon is reachable.',
    '- Use `mcp_odw_odw_run` (`odw_run`) for direct execution. Use `mcp_odw_odw_plan` (`odw_plan`) first when the user asks to review the plan, the task is expensive, or mutation risk is high.',
    '- Report the workflow id, topology, agent count, and cost/time estimate instead of redoing the work manually.',
    '- Use `mcp_odw_odw_status`, `mcp_odw_odw_result`, and `mcp_odw_odw_list` to monitor and summarize running work.',
    '- If ODW is unavailable, say exactly what is missing (`odw-daemon start` or `odw-daemon doctor gemini`) and then fall back to Gemini-native planning only if useful.',
    '',
    GEMINI_END,
    '',
  ].join('\n');
  writeText(path, replaceManagedSection(readText(path, ''), block, GEMINI_BEGIN, GEMINI_END));
  return path;
}

function checkMcpJson(label, path, section, options) {
  if (!existsSync(path)) return check(false, label, path, 'missing');
  let json;
  try {
    json = JSON.parse(readText(path, '{}'));
  } catch (error) {
    return check(false, label, path, `invalid JSON: ${error.message}`);
  }
  const server = json?.[section]?.odw;
  if (!server || typeof server !== 'object') return check(false, label, path, `missing ${section}.odw`);
  const expected = mcpServerCommand(options);
  if (server.command !== expected.command) return check(false, label, path, `expected command ${expected.command}`);
  if (!Array.isArray(server.args) || server.args[0] !== expected.args[0]) {
    return check(false, label, path, 'odw server path does not match this checkout');
  }
  return check(true, label, path, 'ready');
}

function checkText(label, path, fragments) {
  if (!existsSync(path)) return check(false, label, path, 'missing');
  const text = readText(path, '');
  const missing = fragments.find((fragment) => !text.includes(fragment));
  if (missing) return check(false, label, path, `missing ${missing}`);
  return check(true, label, path, 'ready');
}

function checkAgentInstructions(label, targetDir) {
  return checkText(label, join(targetDir, 'AGENTS.md'), [
    AGENTS_BEGIN,
    'odw_run',
    'ultracode',
  ]);
}

function checkGeminiInstructions(label, targetDir) {
  return checkText(label, join(targetDir, 'GEMINI.md'), [
    GEMINI_BEGIN,
    'odw_run',
    'ultracode',
  ]);
}

function checkExists(label, path) {
  return check(existsSync(path), label, path, existsSync(path) ? 'ready' : 'missing');
}

function check(ok, label, path, message) {
  return { ok, label, path, message };
}

function writeMcpServersJson(path, repoRoot) {
  const current = readJson(path, { mcpServers: {} });
  current.mcpServers = objectOrEmpty(current.mcpServers);
  current.mcpServers.odw = mcpServerCommand({ repoRoot });
  writeJson(path, current);
  return current;
}

function vscodeExtensionPath(options = {}) {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const manifest = readJson(join(repoRoot, 'packages', 'vscode-extension', 'package.json'), {});
  return join(options.home ?? homedir(), '.vscode', 'extensions', `${manifest.publisher}.${manifest.name}-${manifest.version}`);
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function copyFresh(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  ensureDir(dirname(dest));
  cpSync(src, dest, { recursive: true });
}

function replaceManagedBlock(text, block) {
  return replaceManagedSection(text, block, MANAGED_BEGIN, MANAGED_END);
}

function replaceManagedSection(text, block, begin, end) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '').trimEnd();
  const pattern = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`, 'm');
  if (pattern.test(clean)) return `${clean.replace(pattern, block).trimEnd()}\n`;
  return `${clean}${clean ? '\n\n' : ''}${block}`;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readText(path, JSON.stringify(fallback)));
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readText(path, fallback) {
  try {
    const raw = readFileSync(path, 'utf8');
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } catch {
    return fallback;
  }
}

function writeText(path, text) {
  ensureDir(dirname(path));
  writeFileSync(path, text, 'utf8');
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function slash(path) {
  return resolve(path).replace(/\\/g, '/');
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
