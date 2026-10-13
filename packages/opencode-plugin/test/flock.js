import { spawnSync } from 'node:child_process';

// src/session-lock.js resolves `flock` on a fixed PATH (/usr/bin:/bin), not the caller's. Probe the
// same way so tests branch on exactly what the product will see. Where it is absent (macOS, Windows),
// the contract is the explicit failure that session-lock.test.js already pins, not a silent skip.
export const hasFlock = spawnSync('flock', ['--version'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' }).error?.code !== 'ENOENT';
export const NO_FLOCK = /spawn flock ENOENT/;
export const COULD_NOT_START = /\[ODW could not start: spawn flock ENOENT\./;
// A native Windows temporary directory (D:\...) is refused before flock is spawned.
export const ROOT_NOT_ABSOLUTE = /\[ODW could not start: ODW runtime root must be absolute\./;
