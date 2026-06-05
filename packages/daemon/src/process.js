/**
 * Daemon process lifecycle: detached background spawn (cross-platform),
 * PID file management, graceful SIGTERM/SIGINT drain.
 * Windows + POSIX: spawn(execPath, [main,...], {detached:true, stdio:['ignore',logFd,logFd], windowsHide:true}).unref()
 */

/** @returns {{pidFile: string, logFile: string}} */
export function daemonPaths() {
  throw new Error('not implemented (P4)');
}

/** Spawn the daemon detached; returns child PID. */
export function spawnDetached(args) {
  void args;
  throw new Error('not implemented (P4)');
}

/** @returns {{running: boolean, pid?: number}} */
export function daemonStatusFromPidFile() {
  throw new Error('not implemented (P4)');
}

/** Send termination signal to the daemon by PID file. */
export function stopDaemon() {
  throw new Error('not implemented (P4)');
}

/**
 * Install graceful-shutdown handlers on a live server process:
 * drain HTTP, close ws, close DB, remove PID file, exit 0 within the window.
 */
export function installShutdownHandlers({ server, db, logger, timeoutMs }) {
  void server; void db; void logger; void timeoutMs;
  throw new Error('not implemented (P4)');
}
