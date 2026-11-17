import { EvalFlags, QuickJS, type JSValueHandle } from "quickjs-wasi";
import quickjsWasm from "../../node_modules/quickjs-wasi/quickjs.wasm";

let cachedWasmInput: WebAssembly.Module | Uint8Array | null = null;

async function loadQuickJsWasm(): Promise<WebAssembly.Module | Uint8Array> {
  if (cachedWasmInput) return cachedWasmInput;
  const rawWasm: unknown = quickjsWasm;
  if (
    rawWasm instanceof WebAssembly.Module ||
    rawWasm instanceof Uint8Array ||
    rawWasm instanceof ArrayBuffer
  ) {
    cachedWasmInput =
      rawWasm instanceof ArrayBuffer ? new Uint8Array(rawWasm) : rawWasm;
    return cachedWasmInput;
  }
  // Plain Node fallback when imported outside workerd bundler
  const fs = await import("node:fs/promises");
  const url = new URL("../../node_modules/quickjs-wasi/quickjs.wasm", import.meta.url);
  const buf = await fs.readFile(url);
  cachedWasmInput = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return cachedWasmInput;
}

export interface SandboxExecutionOptions {
  code: string;
  filename?: string;
  memoryLimitBytes?: number;
  maxInterruptTicks?: number;
  timeoutMs?: number;
  bootstrapGlobalsJs?: string;
  onHostCall: (op: string, args: unknown) => Promise<unknown>;
}

export interface SandboxExecutionResult {
  result: unknown;
  logs: string[];
}

export async function executeQuickJsSandbox(
  opts: SandboxExecutionOptions,
): Promise<SandboxExecutionResult> {
  const wasm = await loadQuickJsWasm();
  const memoryLimit = opts.memoryLimitBytes ?? 16 * 1024 * 1024; // 16 MiB
  const maxTicks = opts.maxInterruptTicks ?? 500_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let ticks = 0;

  const logs: string[] = [];
  let vmDisposed = false;

  const vm = await QuickJS.create({
    wasm,
    memoryLimit,
    maxStackSize: 384 * 1024,
    interruptHandler: () => {
      ticks++;
      if (ticks > maxTicks) return true;
      if ((ticks & 255) === 0 && Date.now() > deadline) return true;
      return false;
    },
  });

  const pendingHostPromises = new Set<Promise<void>>();

  try {
    const logFn = vm.newFunction("__hostLog", (...args: JSValueHandle[]) => {
      const line = args.map((a) => (a.isString ? a.toString() : JSON.stringify(vm.dump(a)))).join(" ");
      logs.push(line);
      return vm.undefined;
    });
    vm.setProp(vm.global, "__hostLog", logFn);
    logFn.dispose();

    const callFn = vm.newFunction(
      "__hostCall",
      (...args: JSValueHandle[]) => {
        const op = args[0] ? args[0].toString() : "";
        const rawPayload = args[1] && !args[1].isUndefined ? args[1].toString() : "null";
        let parsedArgs: unknown = null;
        try {
          parsedArgs = JSON.parse(rawPayload);
        } catch {
          parsedArgs = rawPayload;
        }

        const deferred = vm.newPromise();
        const task = (async () => {
          try {
            const out = await opts.onHostCall(op, parsedArgs);
            if (vmDisposed) return;
            // Reset instruction tick budget across awaited host I/O calls
            ticks = 0;
            const serialized = JSON.stringify(out === undefined ? null : out);
            const strHandle = vm.newString(serialized);
            deferred.resolve(strHandle);
            strHandle.dispose();
          } catch (err) {
            if (vmDisposed) return;
            const msg = err instanceof Error ? err.message : String(err);
            const errHandle = vm.newError(msg);
            deferred.reject(errHandle);
            errHandle.dispose();
          } finally {
            if (!vmDisposed) {
              try {
                vm.executePendingJobs();
              } catch {
                // Handled via rejected promise
              }
            }
          }
        })();

        pendingHostPromises.add(task);
        void task.finally(() => {
          pendingHostPromises.delete(task);
        });

        return deferred.handle;
      },
    );
    vm.setProp(vm.global, "__hostCall", callFn);
    callFn.dispose();

    const prelude = `
      globalThis.console = {
        log: (...a) => __hostLog(...a),
        info: (...a) => __hostLog(...a),
        warn: (...a) => __hostLog(...a),
        error: (...a) => __hostLog(...a),
      };
      globalThis.__invokeHost = async (op, payload) => {
        const raw = await __hostCall(String(op), JSON.stringify(payload === undefined ? null : payload));
        return JSON.parse(raw);
      };
      ${opts.bootstrapGlobalsJs ?? ""}
    `;
    const preludeRes = vm.evalCode(prelude, "<bootstrap>");
    preludeRes.dispose();

    const wrappedUserCode = `await (async () => {\n${opts.code}\n})()`;
    const evalPromiseHandle = vm.evalCode(
      wrappedUserCode,
      opts.filename ?? "<sandbox.js>",
      EvalFlags.ASYNC,
    );
    vm.markPromiseHandled(evalPromiseHandle);

    const settlementPromise = vm.resolvePromise(evalPromiseHandle);
    let settledResult: { value: JSValueHandle } | { error: JSValueHandle } | null = null;
    const monitor = settlementPromise.then((r) => {
      settledResult = r;
      return r;
    });

    while (!settledResult) {
      vm.executePendingJobs();
      if (settledResult) break;
      if (pendingHostPromises.size > 0) {
        await Promise.race([monitor, ...pendingHostPromises]);
      } else {
        // One final microtask drain if no async host ops remain
        vm.executePendingJobs();
        if (!settledResult) {
          settledResult = await monitor;
        }
      }
    }

    evalPromiseHandle.dispose();
    const finalOutcome = settledResult as { value: JSValueHandle } | { error: JSValueHandle };

    if ("error" in finalOutcome) {
      const dumpedErr = vm.dump(finalOutcome.error);
      const errMsg =
        dumpedErr instanceof Error
          ? dumpedErr.message
          : typeof dumpedErr === "object" && dumpedErr !== null && "message" in dumpedErr
            ? String((dumpedErr as { message: unknown }).message)
            : finalOutcome.error.toString();
      finalOutcome.error.dispose();
      throw new Error(errMsg);
    }

    // QuickJS EvalFlags.ASYNC resolves to `{ value: completionValue }`
    let extracted: unknown;
    if (finalOutcome.value.isObject && finalOutcome.value.hasOwnProperty("value")) {
      const inner = finalOutcome.value.getProp("value");
      extracted = vm.dump(inner);
      inner.dispose();
    } else {
      extracted = vm.dump(finalOutcome.value);
    }
    finalOutcome.value.dispose();

    return { result: extracted, logs };
  } finally {
    vmDisposed = true;
    vm.dispose();
  }
}

export async function runCodemodeScript(
  code: string,
  toolDispatcher: (toolName: string, args: Record<string, unknown>) => Promise<unknown>,
  timeoutMs = 30_000,
): Promise<SandboxExecutionResult> {
  const bootstrapGlobalsJs = `
    globalThis.tools = new Proxy({}, {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        return (args = {}) => __invokeHost("tool:" + prop, args);
      }
    });
    globalThis.fs = {
      readFile: async (path) => {
        const res = await __invokeHost("tool:read_file", { path });
        return typeof res === "object" && res !== null && "content" in res ? res.content : res;
      },
      writeFile: async (path, content) => {
        return __invokeHost("tool:write_file", { path, content: String(content) });
      },
      readdir: async (path = "") => {
        const res = await __invokeHost("tool:list_files", { path });
        return typeof res === "object" && res !== null && "entries" in res ? res.entries : res;
      }
    };
  `;

  return executeQuickJsSandbox({
    code,
    filename: "codemode.js",
    timeoutMs,
    bootstrapGlobalsJs,
    onHostCall: async (op, rawArgs) => {
      if (op.startsWith("tool:")) {
        const toolName = op.slice(5);
        const args =
          rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : { value: rawArgs };
        return toolDispatcher(toolName, args);
      }
      throw new Error(`Unsupported codemode host operation: ${op}`);
    },
  });
}
