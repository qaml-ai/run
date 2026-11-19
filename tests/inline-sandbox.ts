import { InlineCodemodeSandbox, loadQuickJSWasm, type CodemodeRunOptions } from "@earendil-works/pi-codemode";
import type { CodeSandboxes } from "../src/codemode-pi-launcher.ts";

const wasm = await loadQuickJSWasm();

/**
 * Run code mode tests on Pi's in-process QuickJS sandbox. `opened` counts scripts started.
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
