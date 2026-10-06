// Quick checks of v8-exec through executeCode: node --experimental-strip-types scripts/v8-smoke.ts
import { executeCode, presentResult } from "../src/codemode.ts";
import { V8Exec } from "../src/v8-exec.ts";
import type { ToolBridge } from "../src/protocol.ts";

const pool = new V8Exec({ jitless: process.argv.includes("--jitless"), snapshot: process.argv.includes("--no-snapshot") ? false : undefined });
const bridge: ToolBridge = { definitions: [{ name: "echo", description: "Echoes", parameters: { type: "object" } }], call: async (_name, args) => args };
for (const code of [
  "return 1",
  "1 + 2",
  "const x: number = 3; function id<T>(v: T): T { return v } return id<number>(x)",
  "enum Color { Red, Green } return Color.Green",
  'console.log("hi", {a: 1}); return await tools.echo({ n: 5 })',
  "return Object.getOwnPropertyNames(globalThis).sort()",
  'return await import("node:fs")',
  "while (true) {}",
  "const a = []; for (;;) a.push(new Uint8Array(1 << 20))",
  "const a = []; for (;;) a.push({ x: Math.random(), y: [1, 2, 3] })",
  "function r() { return r() + 1 } return r()",
  "throw new TypeError('bad')",
  'return "a".repeat(2e6).indexOf("a".repeat(1e6) + "b")',
  "return typeof process + typeof require + typeof fetch + typeof WebAssembly + typeof SharedArrayBuffer",
]) {
  const started = performance.now();
  const result = await executeCode({ code, bridge, pool, limits: { cpuMs: 1000 } }).then(result => presentResult(result), error => `ERROR ${error.message}`);
  console.log(`${(performance.now() - started).toFixed(1).padStart(7)} ms  ${code.slice(0, 50).padEnd(50)} => ${result.slice(0, 300)}`);
}
pool.close();
