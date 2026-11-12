// camel-guest: the agent inside a job's VM (docs/design/job-hosts-plan.md, slice 2). It speaks newline-delimited JSON
// on stdin/stdout: in a Firecracker guest its init runs it behind the vsock command channel (socat VSOCK-LISTEN:5000
// EXEC:camel-guest); in the host agent's fake mode the host runs it as a local process on a directory standing in for
// the VM's disk. One request at a time, each answered by one line; while a command runs, `log` lines come first.
//
//   { op: "files", files: [{ path, data }] }          → { ok: true, syncMs }                write files under /repo
//   { op: "free" }                                      → { ok: true, freeBytes }            the disk's free bytes
//   { op: "run", command, timeoutSeconds, pids?, env? } → { ok: true, exitCode, timedOut, stdout, stderr, commandMs }
//   { op: "collect", outputs: [name] }                  → { ok: true, outputs, missing, collectMs }  from /out
//   { op: "exit" }                                      → { ok: true }, then the guest ends
//
// Limits: the command runs in its own process group, killed whole at its timeout; `pids` caps its processes
// (ulimit -u: only meaningful where the guest owns the machine, so the host asks for it in a VM, not in fake mode);
// stdout and stderr are kept to STREAM_BYTES each and counted past it; each output to OUTPUT_BYTES.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join, normalize } from "node:path";

export const GUEST_LIMITS = Object.freeze({ streamBytes: 8 * 1024 * 1024, outputBytes: 8 * 1024 * 1024, outputTotalBytes: 8 * 1024 * 1024, logChunkBytes: 16 * 1024 });

type Request = { op: string; [key: string]: unknown };
type Stream = { data: string; size: number; truncated: boolean };

/** A relative path under a root: no absolute, `..` or NUL. */
export function inside(root: string, path: string) {
  const relative = normalize(path.replace(/^\/+/, ""));
  if (!relative || relative.startsWith("..") || relative.includes("\0") || relative === ".") throw new Error(`Invalid path: ${JSON.stringify(path).slice(0, 200)}`);
  return join(root, relative);
}

class Capped {
  private chunks: Buffer[] = [];
  private kept = 0;
  size = 0;
  private readonly max: number;
  constructor(max: number) { this.max = max; }
  push(chunk: Buffer) {
    this.size += chunk.length;
    if (this.kept >= this.max) return;
    const part = chunk.subarray(0, this.max - this.kept);
    this.chunks.push(part); this.kept += part.length;
  }
  result(): Stream { return { data: Buffer.concat(this.chunks).toString("base64"), size: this.size, truncated: this.size > this.kept }; }
}

/** Where a running command's process group is written, so whoever ends the VM can end the command too (vm.ts). */
export const PGID_FILE = ".job.pgid";

export class Guest {
  readonly repo: string;
  readonly out: string;
  private readonly root: string;
  private readonly send: (line: unknown) => void;
  /** The running command's process group, until it ends. */
  private group?: number;
  constructor(root: string, send: (line: unknown) => void) {
    // In a VM the root is "/": /repo and /out, as a container job has them. In fake mode it is the job's directory.
    this.root = root; this.repo = join(root, "repo"); this.out = join(root, "out"); this.send = send;
  }
  /** End the running command's whole process group (the guest is told to stop, or its channel closed). */
  killCommand() {
    if (this.group === undefined) return;
    try { process.kill(-this.group, "SIGKILL"); } catch { /* already gone */ }
    this.group = undefined;
  }

  async handle(request: Request): Promise<unknown> {
    switch (request.op) {
      case "files": return this.files(request.files as { path: string; data: string }[]);
      case "free": { const fs = await statfs(this.repo); return { ok: true, freeBytes: Number(fs.bavail) * Number(fs.bsize) }; }
      case "run": return this.run(request as never);
      case "collect": return this.collect(request.outputs as string[]);
      case "exit": return { ok: true };
      default: return { ok: false, error: `Unknown op ${String(request.op).slice(0, 40)}` };
    }
  }

  private async files(files: { path: string; data: string }[]) {
    const started = Date.now();
    await mkdir(this.repo, { recursive: true }); await mkdir(this.out, { recursive: true });
    for (const file of files ?? []) {
      const target = inside(this.repo, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.data, "base64"));
    }
    return { ok: true, syncMs: Date.now() - started };
  }

  private run(request: { command: string; timeoutSeconds: number; pids?: number; env?: Record<string, string> }) {
    const started = Date.now();
    const stdout = new Capped(GUEST_LIMITS.streamBytes), stderr = new Capped(GUEST_LIMITS.streamBytes);
    const pids = Number.isInteger(request.pids) && request.pids! > 0 ? `ulimit -u ${request.pids} 2>/dev/null || exit 125; ` : "";
    return new Promise(resolve => {
      const child = spawn("bash", ["-lc", `${pids}${request.command}`], {
        cwd: this.repo, detached: true, stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: this.repo, JOB_OUT: this.out, ...request.env ?? {} },
      });
      let timedOut = false;
      this.group = child.pid;
      void writeFile(join(this.root, PGID_FILE), String(child.pid)).catch(() => {});
      const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } }, Math.max(1, request.timeoutSeconds) * 1000);
      const log = (stream: "stdout" | "stderr", capped: Capped) => (chunk: Buffer) => {
        capped.push(chunk);
        for (let i = 0; i < chunk.length; i += GUEST_LIMITS.logChunkBytes) this.send({ event: "log", stream, data: chunk.subarray(i, i + GUEST_LIMITS.logChunkBytes).toString("base64") });
      };
      child.stdout.on("data", log("stdout", stdout));
      child.stderr.on("data", log("stderr", stderr));
      child.on("close", code => {
        clearTimeout(timer);
        this.group = undefined;
        void rm(join(this.root, PGID_FILE), { force: true }).catch(() => {});
        resolve({ ok: true, exitCode: timedOut ? null : code, timedOut, stdout: stdout.result(), stderr: stderr.result(), commandMs: Date.now() - started });
      });
      child.on("error", error => { clearTimeout(timer); resolve({ ok: false, error: error.message.slice(0, 300) }); });
    });
  }

  private async collect(names: string[]) {
    const started = Date.now();
    const outputs: Record<string, Stream> = {}, missing: string[] = [];
    let total = 0;
    for (const name of names ?? []) {
      const path = inside(this.out, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) { missing.push(name); continue; }
        const room = Math.max(0, Math.min(GUEST_LIMITS.outputBytes, GUEST_LIMITS.outputTotalBytes - total));
        const bytes = (await readFile(path)).subarray(0, room);
        total += bytes.length;
        outputs[name] = { data: bytes.toString("base64"), size: info.size, truncated: info.size > bytes.length };
      } catch { missing.push(name); }
    }
    return { ok: true, outputs, missing, collectMs: Date.now() - started };
  }
}

/** Serve one channel: requests in, answers (and log lines) out, until `exit` or the input ends. */
export async function serve(root: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
  const send = (line: unknown) => output.write(`${JSON.stringify(line)}\n`);
  const guest = new Guest(root, send);
  // A guest told to stop, or whose channel closes, takes its command with it: a detached group outlives its parent.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { guest.killCommand(); process.exit(143); });
  input.on("end", () => guest.killCommand());
  input.on("close", () => guest.killCommand());
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let request: Request;
    try { request = JSON.parse(line) as Request; } catch { send({ ok: false, error: "Invalid request" }); continue; }
    try { send(await guest.handle(request)); }
    catch (error) { send({ ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "Guest failure" }); }
    if (request.op === "exit") return;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const at = process.argv.indexOf("--root");
  await serve(at > 0 ? process.argv[at + 1]! : "/", process.stdin, process.stdout);
}
