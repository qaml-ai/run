import { InlineCodemodeSandbox, loadQuickJSWasm, type CodemodeRunOptions } from "@earendil-works/pi-codemode";
import type { CodeSandboxes } from "../src/codemode-pi-launcher.ts";

// Read once, as this module loads: the simulation refuses real I/O once it runs.
const wasm = await loadQuickJSWasm();

/**
 * Code mode on Pi's own QuickJS, on this thread: for tests and the simulation, which run without v8-exec. `opened`
 * counts the scripts it started.
 */
export function inlineSandboxes(): CodeSandboxes & { opened: number } {
  const sandboxes = Object.assign((options: Parameters<CodeSandboxes>[0]) => {
    const sandbox = new InlineCodemodeSandbox({ wasm, ...options.tools ? { tools: options.tools } : {}, ...options.timeoutMs ? { timeoutMs: options.timeoutMs } : {} });
    const start = sandbox.start.bind(sandbox), execute = sandbox.execute.bind(sandbox);
    sandbox.start = (code: string, run: CodemodeRunOptions) => { sandboxes.opened++; return start(code, run); };
    sandbox.execute = (code, run) => { sandboxes.opened++; return execute(code, run); };
    return sandbox;
  }, { opened: 0 });
  return sandboxes;
}
