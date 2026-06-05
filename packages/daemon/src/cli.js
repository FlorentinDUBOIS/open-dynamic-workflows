#!/usr/bin/env node
/**
 * odw-daemon CLI (commander):
 *   start [--foreground] [--port] [--host]   start the daemon (detached by default)
 *   stop                                     stop via PID file
 *   status                                   health + active workflows/agents
 *   restart [--resume]                       stop + start (+ resume interrupted)
 *   logs [--follow]                          tail the daemon log
 *   run --prompt "<text>" | --script <file>  run a workflow from the shell
 *   db-check                                 migration dry-run against a temp database
 */

console.error('odw-daemon: not implemented (P4)');
process.exit(1);
