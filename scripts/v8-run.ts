// Run one snippet in v8-exec: node --experimental-strip-types scripts/v8-run.ts [--jit] [--no-seccomp] 'code'
import { executeCode, presentResult } from "../src/codemode.ts";
import { V8Exec } from "../src/v8-exec.ts";
import type { ToolBridge } from "../src/protocol.ts";

const flags = process.argv.slice(2).filter(arg => arg.startsWith("--"));
const code = process.argv.slice(2).filter(arg => !arg.startsWith("--")).join("\n");
const pool = new V8Exec({ jitless: !flags.includes("--jit"), seccomp: !flags.includes("--no-seccomp") });
const bridge: ToolBridge = { definitions: [{ name: "echo", description: "Echoes", parameters: { type: "object" } }], call: async (_name, args) => args };
const started = performance.now();
console.log(await executeCode({ code, bridge, pool, timeoutMs: 30_000 }).then(result => presentResult(result), error => `ERROR ${error.message}`));
console.log(`${(performance.now() - started).toFixed(1)} ms`);
pool.close();
