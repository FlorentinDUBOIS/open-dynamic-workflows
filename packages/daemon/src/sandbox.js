/**
 * Script sandbox — quickjs-emscripten (WASM QuickJS, engine-level isolation).
 * No fs, no network, no process, no require, no eval inside the guest.
 *
 * Async host bridges return VM deferred promises (newPromise → resolve →
 * executePendingJobs), so many calls can be in flight simultaneously and
 * guest-side Promise.all works. Sync bridges return JSON strings directly.
 * CPU guard: per-slice wall-clock interrupt. Memory: setMemoryLimit.
 */

import { createRequire } from 'node:module';
import { GUEST_PRELUDE } from './guest-prelude.js';

const require = createRequire(import.meta.url);
const { getQuickJS } = require('quickjs-emscripten');

const OK = (value) => JSON.stringify({ ok: true, value: value === undefined ? null : value });
const FAIL = (error) =>
  JSON.stringify({ ok: false, error: String(error?.message ?? error).slice(0, 2000), code: error?.code });

/**
 * @param {{
 *   hostBridges: {
 *     agent: (payload: any) => Promise<any>,
 *     tool: (payload: any) => Promise<any>,
 *     checkpoint: (payload: any) => Promise<any>,
 *     compact?: (payload: {value: any, opts: object}) => Promise<any>,
 *     log?: (payload: {message: string, level: string}) => void,
 *     phase?: (payload: {name: string, meta: object}) => void,
 *     budget?: () => any,
 *     args?: () => any,
 *   },
 *   strategy?: object,
 *   memoryLimitBytes?: number,
 *   sliceTimeoutMs?: number,
 *   totalTimeoutMs?: number,
 * }} options
 * @returns {Promise<{runScript: (scriptSource: string) => Promise<any>, dispose: () => void}>}
 */
export async function createSandbox(options) {
  const bridges = options.hostBridges;
  if (!bridges?.agent) throw new Error('createSandbox: hostBridges.agent is required');

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(options.memoryLimitBytes ?? 256 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);

  // Per-slice CPU guard: bounds contiguous synchronous execution, not awaited time.
  const sliceTimeoutMs = options.sliceTimeoutMs ?? 1000;
  let sliceStart = Date.now();
  runtime.setInterruptHandler(() => Date.now() - sliceStart > sliceTimeoutMs);
  const resetSlice = () => {
    sliceStart = Date.now();
  };

  const vm = runtime.newContext();
  let disposed = false;
  let fatal = null; // a WASM/runtime-level failure that makes the VM unusable
  const inflight = new Set();

  const pump = () => {
    if (disposed || fatal) return;
    try {
      resetSlice();
      runtime.executePendingJobs();
    } catch (error) {
      // A QuickJS/WASM-level abort ("Aborted(Assertion failed...)") leaves the
      // VM unusable. Capture it as a clean error instead of letting a raw WASM
      // assertion escape into the daemon and the user's terminal.
      fatal = new Error('the workflow runtime hit an internal sandbox error and was stopped');
      fatal.cause = String(error?.message ?? error).slice(0, 300);
    }
  };

  /** Install an async bridge: guest gets a VM promise resolved with an envelope JSON string. */
  const installAsync = (name, impl) => {
    vm.newFunction(name, (payloadHandle) => {
      let payload;
      try {
        payload = JSON.parse(vm.getString(payloadHandle));
      } catch (error) {
        return vm.newString(FAIL(error));
      }
      const deferred = vm.newPromise();
      const work = Promise.resolve()
        .then(() => impl(payload))
        .then(
          (value) => {
            if (!disposed) deferred.resolve(vm.newString(OK(value)));
          },
          (error) => {
            if (!disposed) deferred.resolve(vm.newString(FAIL(error)));
          }
        )
        .finally(() => inflight.delete(work));
      inflight.add(work);
      deferred.settled.then(pump);
      return deferred.handle;
    }).consume((fn) => vm.setProp(vm.global, name, fn));
  };

  /** Install a sync bridge returning an envelope JSON string immediately. */
  const installSync = (name, impl) => {
    vm.newFunction(name, (payloadHandle) => {
      try {
        const payload = payloadHandle ? JSON.parse(vm.getString(payloadHandle)) : undefined;
        return vm.newString(OK(impl(payload)));
      } catch (error) {
        return vm.newString(FAIL(error));
      }
    }).consume((fn) => vm.setProp(vm.global, name, fn));
  };

  installAsync('__host_agent', bridges.agent);
  installAsync('__host_tool', bridges.tool ?? (() => Promise.reject(new Error('tools are not available in this run'))));
  installAsync('__host_checkpoint', bridges.checkpoint ?? (() => Promise.resolve(null)));
  // Compaction bridge; defaults to identity so sandboxes built without it (and
  // older compiled scripts that never call compact()) behave exactly as before.
  installAsync('__host_compact', bridges.compact ?? ((payload) => Promise.resolve(payload?.value ?? null)));
  installSync('__host_log', (p) => {
    bridges.log?.(p);
    return null;
  });
  installSync('__host_phase', (p) => {
    bridges.phase?.(p);
    return null;
  });
  installSync('__host_budget', () => bridges.budget?.() ?? null);
  installSync('__host_args', () => bridges.args?.() ?? {});

  // Evaluate the prelude once.
  resetSlice();
  vm.unwrapResult(vm.evalCode(GUEST_PRELUDE, 'prelude.js')).dispose();

  if (options.strategy) {
    resetSlice();
    vm.unwrapResult(
      vm.evalCode(`context.strategy = ${JSON.stringify(options.strategy)};`, 'strategy.js')
    ).dispose();
  }

  return {
    /**
     * Evaluate an orchestration script and run its exported execute(context).
     * @param {string} scriptSource
     * @returns {Promise<any>}
     */
    async runScript(scriptSource) {
      if (disposed) throw new Error('sandbox disposed');
      try {
        resetSlice();
        const evalResult = vm.evalCode(String(scriptSource), 'workflow.js');
        unwrapOrThrow(vm, evalResult).dispose();

        resetSlice();
        const runResult = vm.evalCode(
          `(function () {
             if (!module.exports || typeof module.exports.execute !== "function") {
               throw new Error("script must export execute via module.exports = { execute }");
             }
             return Promise.resolve(module.exports.execute(context));
           })()`,
          'runner.js'
        );
        const promiseHandle = unwrapOrThrow(vm, runResult);

        const totalTimeoutMs = options.totalTimeoutMs ?? 3600_000;
        const resolved = await withTimeout(vm.resolvePromise(promiseHandle), totalTimeoutMs, pump, () => fatal);
        promiseHandle.dispose();
        if (fatal) throw fatal;

        const resultHandle = unwrapOrThrow(vm, resolved);
        const value = vm.dump(resultHandle);
        resultHandle.dispose();
        return value;
      } catch (error) {
        if (fatal) throw fatal;
        // Convert any low-level WASM/Emscripten abort into a clean message.
        if (/Aborted|abort\(|RuntimeError|memory access|unreachable/i.test(String(error?.message ?? error))) {
          const clean = new Error('the workflow runtime hit an internal sandbox error and was stopped');
          clean.cause = String(error?.message ?? error).slice(0, 300);
          throw clean;
        }
        throw error;
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        vm.dispose();
        runtime.dispose();
      } catch {
        /* double-dispose safety */
      }
    },
  };
}

function unwrapOrThrow(vm, result) {
  if (result.error) {
    const detail = vm.dump(result.error);
    result.error.dispose();
    const message =
      typeof detail === 'object' && detail !== null
        ? `${detail.name ?? 'Error'}: ${detail.message ?? JSON.stringify(detail)}`
        : String(detail);
    throw new Error(`script error — ${message}`);
  }
  return result.value;
}

function withTimeout(promise, ms, pump, getFatal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`workflow exceeded total timeout (${ms / 1000}s)`)), ms);
    // keep the VM job queue moving while we wait; bail out fast on a fatal VM error
    const tick = setInterval(() => {
      pump();
      const fatal = getFatal?.();
      if (fatal) reject(fatal);
    }, 25);
    promise
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        clearInterval(tick);
      });
  });
}
