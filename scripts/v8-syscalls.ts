// Linux, with strace: the system calls a v8-exec process makes, in all and once its execution has
// arrived (what sandbox/v8-exec/src/seccomp.rs must allow), and any its seccomp filter killed it for.
// --no-seccomp traces without the filter, to see what a change needs.
//   node --experimental-strip-types scripts/v8-syscalls.ts [--jit] [--no-seccomp]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { frames } from "../src/sandbox-wire.ts";
import { v8ExecBinary } from "../src/v8-exec.ts";

const jitless = !process.argv.includes("--jit");
const snippets = [
  "return 1",
  "const x: number = 2; return x",
  "let s = 0; for (let i = 0; i < 3e6; i++) s += i; return s",
  "return (await tools.echo({ a: 1 })).a",
  "const a = []; for (;;) a.push({ x: Math.random() })",
  "const a = []; try { for (;;) a.push(new Uint8Array(1 << 20)); } catch { return a.length }",
  "while (true) {}",
  "return [new Intl.NumberFormat('de-DE').format(1234.5), new Date(0).toLocaleString(), ['b', 'a'].sort(new Intl.Collator('de').compare)]",
  "enum E { A } return E.A",
];
const all = new Set<string>(), afterRequest = new Set<string>(), killedBy = new Set<string>();
const dir = mkdtempSync("/tmp/v8-syscalls-");
for (const [index, code] of snippets.entries()) {
  const out = join(dir, String(index));
  const child = spawn("strace", ["-f", "-ff", "-qq", "-o", out, v8ExecBinary(), "--max-data-mb", "512", ...(jitless ? ["--jitless"] : []), ...(process.argv.includes("--no-seccomp") ? ["--no-seccomp"] : ["--seccomp-debug"])], { stdio: ["pipe", "pipe", "ignore"] });
  const done = new Promise<void>(resolve => child.once("close", () => resolve()));
  const write = frames(child.stdout as Socket, (message: any) => {
    if (message.type === "request") write({ type: "response", id: message.id, result: JSON.stringify({ a: 1 }) });
  }, undefined, child.stdin as Socket);
  write({ type: "request", id: "x", method: "execute", params: { code, tools: ["echo"], timeoutMs: 10_000, maxOutputCharacters: 1000, cpuMs: 1000 } });
  await done;
  for (const file of readdirSync(dir).filter(name => name.startsWith(`${index}.`))) {
    let arrived = false, reads = 0;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      // Under --seccomp-debug, what the filter refuses fails with ENOSYS (without it, the call would kill the process).
      if (/ = -1 ENOSYS/.test(line) && arrived) killedBy.add(line.slice(0, 160));
      const name = /^([a-z0-9_]+)\(/.exec(line)?.[1];
      if (!name) continue;
      all.add(name);
      if (arrived) afterRequest.add(name);
      // The execute frame arrives in the first read from stdin (buffered: header and body together).
      if (/^read\(0, /.test(line) && ++reads === 1) arrived = true;
    }
    // A filter's kill shows as the thread's last call, which never returned.
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    if (lines.some(line => line.includes("killed by SIGSYS"))) {
      const last = lines.filter(line => /^[a-z0-9_]+\(/.test(line)).at(-1) ?? "";
      if (!/ = /.test(last)) killedBy.add(last.slice(0, 120));
    }
    // Threads other than main (the watchdog) start after the request: everything they do counts.
    if (!readFileSync(join(dir, file), "utf8").includes("execve(")) for (const line of readFileSync(join(dir, file), "utf8").split("\n")) { const name = /^([a-z0-9_]+)\(/.exec(line)?.[1]; if (name) afterRequest.add(name); }
  }
}
console.log(JSON.stringify({ jitless, killedBy: [...killedBy], total: all.size, afterRequest: afterRequest.size, afterRequestCalls: [...afterRequest].sort(), all: [...all].sort() }, null, 1));
