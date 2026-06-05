/**
 * Script sandbox — quickjs-emscripten (WASM QuickJS, engine-level isolation).
 * No fs, no network, no process, no require, no eval inside the guest.
 *
 * Boundary design:
 *  - Host exposes ONLY thin async bridges crossing as JSON strings:
 *      __host_agent, __host_tool, __host_checkpoint, __host_log,
 *      __host_phase, __host_budget, __host_args
 *  - Each bridge returns a VM deferred promise (newPromise → resolve →
 *    executePendingJobs) so MANY calls can be in flight → guest Promise.all works.
 *  - parallel/pipeline/verify/loop are implemented IN-GUEST (guest-prelude.js);
 *    no closures ever cross the boundary.
 *  - CPU guard: interrupt handler cycle budget. Memory: setMemoryLimit.
 *    Wall-clock budgets enforced host-side (timeouts.perAgent/perPhase/total).
 */

/**
 * @param {{hostBridges: Record<string, (payloadJson: string) => Promise<string>|string>,
 *          memoryLimitBytes?: number, interruptCycles?: number, logger?: object}} options
 * @returns {Promise<{runScript: (scriptSource: string) => Promise<any>, dispose: () => void}>}
 */
export async function createSandbox(options) {
  void options;
  throw new Error('not implemented (P4)');
}
