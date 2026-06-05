#!/usr/bin/env node
/**
 * odw-daemon — CLI for the open-dynamic-workflows local daemon.
 *
 *   start [--foreground] [--port N] [--host H]
 *   stop
 *   status
 *   restart [--resume]
 *   logs [--follow] [--lines N]
 *   run --prompt "<text>" | --script <file> [--cwd <dir>] [--wait]
 *   db-check
 */

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, watchFile, unwatchFile, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { DEFAULT_PORT, loadConfig, ensureHome } from './config.js';
import { daemonPaths, spawnDetached, daemonStatusFromPidFile, stopDaemon, writePidFile, installShutdownHandlers } from './process.js';

const program = new Command();
program.name('odw-daemon').description('Local orchestration daemon for open-dynamic-workflows');

const color = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  head: (s) => `\x1b[38;5;105m${s}\x1b[0m`,
};

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function healthcheck(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

program
  .command('start')
  .description('start the daemon (background by default)')
  .option('--foreground', 'run in the foreground (containers, debugging)')
  .option('--port <port>', 'port to listen on')
  .option('--host <host>', 'host to bind (default 127.0.0.1)')
  .action(async (opts) => {
    const config = loadConfig();
    const port = Number(opts.port ?? config.daemon.port ?? DEFAULT_PORT);

    const existing = await healthcheck(port);
    if (existing) {
      console.log(`${color.ok('✓')} daemon already running on port ${port}`);
      return;
    }

    if (opts.foreground) {
      const { startDaemon } = await import('./index.js');
      const daemon = await startDaemon({ port, host: opts.host });
      writePidFile();
      installShutdownHandlers({ server: daemon.server, store: daemon.store, logger: daemon.logger });
      await daemon.resumability.resumeAll();
      console.log(`${color.ok('✓')} daemon running on ${opts.host ?? '127.0.0.1'}:${daemon.port} (foreground)`);
      return; // keeps running until signalled
    }

    const pid = spawnDetached(opts.port ? ['--port', String(port)] : []);
    // wait for the child to come up (≤15s)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await healthcheck(port)) {
        const { logFile } = daemonPaths();
        console.log(`${color.ok('✓')} daemon started on 127.0.0.1:${port}`);
        console.log(`  pid  ${pid}`);
        console.log(`  log  ${logFile}`);
        return;
      }
    }
    console.error(`${color.err('✗')} daemon did not become healthy within 15s — check logs: ${daemonPaths().logFile}`);
    process.exitCode = 1;
  });

program
  .command('stop')
  .description('stop the daemon')
  .action(async () => {
    const signalled = stopDaemon();
    if (!signalled) {
      console.log(`${color.warn('⚠')} daemon was not running`);
      return;
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (!daemonStatusFromPidFile().running) {
        console.log(`${color.ok('✓')} daemon stopped`);
        return;
      }
    }
    console.error(`${color.err('✗')} daemon did not exit within 5s`);
    process.exitCode = 1;
  });

program
  .command('status')
  .description('daemon health and active workflows')
  .option('--port <port>', 'port to probe')
  .action(async (opts) => {
    const config = loadConfig();
    const port = Number(opts.port ?? config.daemon.port ?? DEFAULT_PORT);
    const pidStatus = daemonStatusFromPidFile();
    const health = await healthcheck(port);
    if (!health) {
      console.log(`${color.err('●')} status   not running${pidStatus.pid ? color.dim(` (stale pid ${pidStatus.pid})`) : ''}`);
      process.exitCode = 1;
      return;
    }
    const lines = [
      ['status', color.ok('running')],
      ['port', String(port)],
      ['pid', String(pidStatus.pid ?? 'unknown')],
      ['uptime', formatDuration(health.uptime)],
      ['active workflows', String(health.activeWorkflows)],
      ['active agents', `${health.activeAgents}/${health.maxConcurrency}`],
      ['queued agents', String(health.queuedAgents)],
    ];
    console.log(color.head('odw daemon'));
    for (const [k, v] of lines) console.log(`  ${k.padEnd(18)} ${v}`);
  });

program
  .command('restart')
  .description('stop, start, and optionally resume interrupted workflows')
  .option('--resume', 'resume interrupted workflows after restart')
  .option('--port <port>')
  .action(async (opts) => {
    stopDaemon();
    for (let i = 0; i < 20 && daemonStatusFromPidFile().running; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const config = loadConfig();
    const port = Number(opts.port ?? config.daemon.port ?? DEFAULT_PORT);
    spawnDetached(['--port', String(port)]);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await healthcheck(port)) break;
    }
    // foreground start already resumes; the flag is honored for parity/docs
    console.log(`${color.ok('✓')} daemon restarted${opts.resume ? ' (interrupted workflows resume automatically)' : ''}`);
  });

program
  .command('logs')
  .description('show daemon logs')
  .option('--follow', 'stream new lines')
  .option('--lines <n>', 'number of trailing lines', '50')
  .action(async (opts) => {
    const { logFile } = daemonPaths();
    if (!existsSync(logFile)) {
      console.log(color.dim('(no log file yet)'));
      return;
    }
    const tail = (n) => {
      const content = readFileSync(logFile, 'utf8').trimEnd().split('\n');
      return content.slice(-n).join('\n');
    };
    console.log(tail(Number(opts.lines)));
    if (opts.follow) {
      let position = statSync(logFile).size;
      watchFile(logFile, { interval: 500 }, () => {
        const size = statSync(logFile).size;
        if (size <= position) return;
        const fd = openSync(logFile, 'r');
        const buffer = Buffer.alloc(size - position);
        readSync(fd, buffer, 0, buffer.length, position);
        closeSync(fd);
        position = size;
        process.stdout.write(buffer.toString('utf8'));
      });
      process.on('SIGINT', () => {
        unwatchFile(logFile);
        process.exit(0);
      });
      await new Promise(() => {}); // follow until interrupted
    }
  });

program
  .command('run')
  .description('plan + execute a workflow from the shell')
  .option('--prompt <text>', 'natural-language workflow prompt')
  .option('--script <file>', 'run a saved orchestration script directly')
  .option('--cwd <dir>', 'working directory for workflow tools', process.cwd())
  .option('--port <port>')
  .option('--no-wait', 'do not wait for completion')
  .action(async (opts) => {
    if (!opts.prompt && !opts.script) {
      console.error(`${color.err('✗')} provide --prompt "<text>" or --script <file>`);
      process.exitCode = 1;
      return;
    }
    const config = loadConfig();
    const port = Number(opts.port ?? config.daemon.port ?? DEFAULT_PORT);
    if (!(await healthcheck(port))) {
      console.error(`${color.err('✗')} daemon is not running — start it with: odw-daemon start`);
      process.exitCode = 1;
      return;
    }

    let plan;
    if (opts.script) {
      const script = readFileSync(resolve(opts.script), 'utf8');
      plan = { script, prompt: `script:${opts.script}`, topology: 'hybrid', estimate: { totalAgents: 0 } };
    } else {
      const planRes = await fetch(`http://127.0.0.1:${port}/workflows/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: opts.prompt }),
      });
      if (!planRes.ok) {
        console.error(`${color.err('✗')} planning failed: ${(await planRes.text()).slice(0, 300)}`);
        process.exitCode = 1;
        return;
      }
      ({ plan } = await planRes.json());
      const e = plan.estimate;
      console.log(color.head('plan'));
      console.log(`  topology     ${plan.topology}`);
      console.log(`  agents       ~${e.totalAgents} (max ${e.maxConcurrent} concurrent)`);
      console.log(`  tokens       ~${e.tokens.toLocaleString()}`);
      console.log(`  est. cost    $${e.costUSD}`);
      console.log(`  est. time    ~${e.minutes} min`);
    }

    const execRes = await fetch(`http://127.0.0.1:${port}/workflows/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan, cwd: resolve(opts.cwd) }),
    });
    if (!execRes.ok) {
      console.error(`${color.err('✗')} exec failed: ${(await execRes.text()).slice(0, 300)}`);
      process.exitCode = 1;
      return;
    }
    const { workflowId } = await execRes.json();
    console.log(`${color.ok('▶')} workflow ${workflowId} running`);

    if (opts.wait === false) return;

    // Poll the record with short, resilient requests (a single long-held
    // connection is fragile over multi-minute runs). Show live progress, then
    // the final result or a clear failure reason — never make the user open a log.
    const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
    let record;
    let lastLine = '';
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/workflows/${workflowId}`, { signal: AbortSignal.timeout(8000) });
        record = await r.json();
      } catch {
        await new Promise((res) => setTimeout(res, 2000));
        continue;
      }
      const line = `  ${record.completed_agents ?? 0} done / ${record.failed_agents ?? 0} failed`;
      if (line !== lastLine) {
        process.stdout.write(`\r${color.dim(line)}        `);
        lastLine = line;
      }
      if (TERMINAL.has(record.status)) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    process.stdout.write('\n');

    if (record.status === 'completed') {
      const res = await fetch(`http://127.0.0.1:${port}/workflows/${workflowId}/result`);
      const body = await res.json();
      console.log(`${color.ok('✓')} completed`);
      console.log(JSON.stringify(body.result, null, 2));
    } else {
      console.error(`${color.err('✗')} workflow ${record.status}`);
      if (record.error) console.error(`  ${color.err('reason:')} ${record.error}`);
      else console.error(color.dim(`  (no reason recorded — see logs: odw-daemon logs)`));
      process.exitCode = 1;
    }
  });

program
  .command('db-check')
  .description('migration dry-run against a temporary database')
  .action(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'odw-dbcheck-'));
    try {
      const { openDatabase } = await import('./db.js');
      const db = openDatabase(join(dir, 'check.db'));
      const version = db.pragma('user_version', { simple: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
      db.close();
      console.log(`${color.ok('✓')} migrations applied cleanly (user_version=${version})`);
      console.log(`  tables: ${tables.join(', ')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

ensureHome();
program.parseAsync(process.argv).catch((error) => {
  console.error(`${color.err('✗')} ${error.message}`);
  process.exit(1);
});
