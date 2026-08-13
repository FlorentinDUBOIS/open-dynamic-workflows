import { mkdir, chmod, lstat, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const LOCK_CONFLICT = 75;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

function runtimeRoot(environment = process.env) {
  const base = environment.XDG_RUNTIME_DIR || (environment.HOME ? join(environment.HOME, '.cache', 'remote-runtime') : '');
  if (!base || !base.startsWith('/')) throw new Error('ODW runtime root must be absolute');
  return join(base, 'remote', 'odw');
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`ODW lock root must be a real directory: ${path}`);
  await chmod(path, 0o700);
}

export async function acquireSessionLock(sessionID, options = {}) {
  if (!SAFE_SESSION_ID.test(sessionID)) throw new Error('invalid ODW session id for lock path');
  const root = options.root ?? runtimeRoot(options.environment);
  await privateDirectory(root);
  const path = join(root, `${sessionID}.lock`);
  const file = await open(path, 'a+', 0o600);
  await file.chmod(0o600);
  await file.close();

  const child = spawn(
    options.flock ?? 'flock',
    ['--no-fork', '--nonblock', '--conflict-exit-code', String(LOCK_CONFLICT), path, options.holder ?? 'dd', 'of=/dev/null', 'status=none'],
    { stdio: ['pipe', 'ignore', 'pipe'], env: { PATH: options.path ?? '/usr/bin:/bin' } },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const outcome = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ acquired: true });
    }, options.probeMs ?? 40);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === LOCK_CONFLICT ? { acquired: false } : { error: new Error(`ODW lock holder exited ${code ?? signal}: ${stderr.trim()}`) });
    });
  });
  if (outcome.error) throw outcome.error;
  if (!outcome.acquired) return null;

  let released = false;
  return {
    path,
    pid: child.pid,
    async release() {
      if (released) return;
      released = true;
      child.stdin.end();
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', resolve);
      });
    },
  };
}
