// Debugging: run executions in the v8-exec binary directly, one process each, printing every frame
// and how each process ended. Arguments starting with -- go to the binary; the rest are code.
//   node --experimental-strip-types scripts/v8-one.ts 'return 1' 'while (true) {}' --jitless
import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { frames } from "../src/sandbox-wire.ts";
import { v8ExecBinary } from "../src/v8-exec.ts";

const args = process.argv.slice(2).filter((arg, i, all) => arg.startsWith("--") || /^\d+$/.test(arg) && all[i - 1]?.startsWith("--max"));
const codes = process.argv.slice(2).filter(arg => !args.includes(arg));
for (const code of codes.length ? codes : ["return 1"]) {
  const child = spawn(v8ExecBinary(), args, { stdio: ["pipe", "pipe", "inherit"] });
  const write = frames(child.stdout as Socket, (message: any) => {
    console.log(JSON.stringify(message).slice(0, 300));
    if (message.type === "request") write({ type: "response", id: message.id, result: JSON.stringify({ ok: true }) });
  }, undefined, child.stdin as Socket);
  write({ type: "request", id: "x", method: "execute", params: { code, tools: ["echo"], timeoutMs: 10_000, maxOutputCharacters: 1000, cpuMs: 2000 } });
  const [exit, signal] = await new Promise<[number | null, string | null]>(resolve => child.once("close", (exit, signal) => resolve([exit, signal])));
  console.log(JSON.stringify({ code: code.slice(0, 60), exit, signal }));
}
