// camel-guest: the agent inside a job's VM (docs/design/job-hosts-plan.md, slice 2). It speaks newline-delimited JSON
// on stdin/stdout: in a Firecracker guest its init runs it behind the vsock command channel (socat VSOCK-LISTEN:5000
// EXEC:camel-guest); in the host agent's fake mode the host runs it as a local process on a directory standing in for
// the VM's disk. One request at a time, each answered by one line; while a command runs, `log` lines come first.
//
//   { op: "files", files: [{ path, data, append? }] }  → { ok: true, syncMs }               write files under /repo
//                                                         (append: add to the file: a large one comes in pieces)
//   { op: "camelfs_apply", jobId, timeoutMs }            → { ok: true, applyMs, files, entries: count }
//   { op: "free" }                                      → { ok: true, freeBytes }            the disk's free bytes
//   { op: "run", command, timeoutSeconds, pids?, env? } → { ok: true, exitCode, timedOut, stdout, stderr, commandMs }
//   { op: "collect", outputs: [name] }                  → { ok: true, outputs, missing, collectMs }  from /out
//   { op: "exit" }                                      → { ok: true }, then the guest ends
//
// Limits: the command runs in its own process group, killed whole at its timeout; `pids` caps its processes
// (ulimit -u: only meaningful where the guest owns the machine, so the host asks for it in a VM, not in fake mode);
// stdout and stderr are kept to STREAM_BYTES each and counted past it; each output to OUTPUT_BYTES.
import { connect } from "node:net";
import { FrameReader, WIRE, MODES, checkPath, encodeFrame, jsonFrame } from "./camelfs-wire.ts";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rmdir, rm, stat, statfs, symlink, unlink, writeFile } from "node:fs/promises";
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
  camelfsIndex?: { tree: string; entries: Record<string, unknown>[] };
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
      case "camelfs_apply": return this.apply(request.jobId as string, request.timeoutMs as number);
      case "files": return this.files(request.files as { path: string; data: string; append?: boolean }[]);
      case "free": { const fs = await statfs(this.repo); return { ok: true, freeBytes: Number(fs.bavail) * Number(fs.bsize) }; }
      case "run": return this.run(request as never);
      case "collect": return this.collect(request.outputs as string[]);
      case "exit": return { ok: true };
      default: return { ok: false, error: `Unknown op ${String(request.op).slice(0, 40)}` };
    }
  }

  private async apply(jobId: string, timeoutMs: number) {
    const started = Date.now(), vm = process.env.CAMEL_VSOCK_CONNECT === "1";
    let input: import("node:stream").Readable | undefined, output: import("node:stream").Writable | undefined;
    let child: ReturnType<typeof spawn> | undefined, socket: ReturnType<typeof connect> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, connectTimer: ReturnType<typeof setTimeout> | undefined;
    let expired = false, temp = 0, files = 0;
    const check = () => { if (expired) throw new Error("camelFS apply timed out"); };
    const mode = (value: unknown) => { if (!MODES.includes(value as never)) throw new Error("invalid mode"); return value as string; };
    const size = (value: unknown) => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("invalid size"); return value as number; };
    const hex = (value: unknown) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
    // The fake repo itself is a symlink to its disk; only components below it are traversed.
    const target = async (path: string) => {
      const parts = checkPath(path).split("/"); let dir = this.repo;
      for (const part of parts.slice(0, -1)) {
        check(); dir = join(dir, part);
        try { await mkdir(dir, { mode: 0o755 }); await chmod(dir, 0o755); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        const info = await lstat(dir);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("parent is a symlink or not a directory");
      }
      return join(dir, parts.at(-1)!);
    };
    const cleanup = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        check(); const path = join(dir, entry.name);
        if (entry.isDirectory()) await cleanup(path);
        else if (entry.name.startsWith(".camelfs-tmp-")) await unlink(path);
      }
    };
    try {
      const work = async () => {
        if (vm && !(await readFile("/proc/self/mountinfo", "utf8")).split("\n").some(line => line.split(" ")[4] === "/repo")) throw new Error("the camelFS repo disk is not mounted");
        check();
        if (vm) {
          child = spawn("socat", ["-", "VSOCK-CONNECT:2:5201"], { stdio: ["pipe", "pipe", "ignore"] });
          input = child.stdout!; output = child.stdin!;
          child.on("error", error => input!.destroy(error));
          child.on("exit", () => input!.destroy(new Error("apply connection closed")));
        } else {
          socket = connect({ path: process.env.CAMEL_VSOCK_UDS + "_5201", allowHalfOpen: true }); input = socket; output = socket;
        }
        output.on("error", () => {});
        const reader = new FrameReader(input);
        // socat's spawn event does not mean vsock connected: the first header proves it.
        connectTimer = setTimeout(() => input!.destroy(new Error("apply connect timed out after 10 s")), 10_000);
        const next = async () => { check(); const payload = await reader.next(); if (payload === null) throw new Error("unexpected EOF in apply stream"); check(); return payload; };
        const header = jsonFrame(await next()); clearTimeout(connectTimer);
        if (header.v !== 1 || header.kind !== "apply" || header.jobId !== jobId || !hex(header.fromTree) || !hex(header.toTree)) throw new Error("invalid apply header or jobId");
        const entries: Record<string, unknown>[] = [];
        for (;;) {
          const frame = jsonFrame(await next());
          if (frame.indexEnd === true) { if (frame.count !== entries.length) throw new Error("index count mismatch"); break; }
          if (!Array.isArray(frame.index)) throw new Error("expected index frame");
          for (const entry of frame.index) {
            if (!entry || typeof entry !== "object") throw new Error("invalid index entry");
            checkPath(entry.path); mode(entry.mode); size(entry.size);
            if (!hex(entry.sha1)) throw new Error("invalid index sha1");
            if (entries.length >= 1_000_000) throw new Error("index exceeds 1000000 entries");
            entries.push({ path: entry.path, mode: entry.mode, sha1: entry.sha1, size: entry.size });
          }
        }
        await cleanup(this.repo);
        for (;;) {
          const op = jsonFrame(await next());
          if (op.end === true) { if (op.error !== undefined) throw new Error(String(op.error)); break; }
          const path = await target(op.path as string); check();
          if (op.op === "put") {
            if (mode(op.mode) === "120000") throw new Error("mode 120000 is invalid with put");
            let remaining = size(op.size);
            let temporary: string, file;
            // Exclusive creation avoids following a leftover or daemon-supplied temporary symlink.
            for (;;) {
              temporary = join(dirname(path), `.camelfs-tmp-${++temp}`);
              if (temporary === path) continue;
              try { file = await open(temporary, "wx", 0o600); break; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
            }
            try {
              while (remaining) {
                const bytes = await next();
                if (!bytes.length || bytes.length > WIRE.rawMax || bytes.length > remaining) throw new Error("raw frame crosses declared size or exceeds rawMax");
                let offset = 0;
                while (offset < bytes.length) { check(); const written = await file.write(bytes, offset); offset += written.bytesWritten; }
                remaining -= bytes.length;
              }
              check(); await file.sync(); await file.close(); check();
              await rename(temporary, path); await chmod(path, op.mode === "100755" ? 0o755 : 0o644);
            } finally { await file.close(); await unlink(temporary).catch(() => {}); }
          } else if (op.op === "del") {
            await unlink(path);
            let dir = dirname(path);
            while (dir !== this.repo) {
              try { await rmdir(dir); } catch (error) { if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code!)) break; throw error; }
              dir = dirname(dir);
            }
          } else if (op.op === "link") {
            if (typeof op.target !== "string" || Buffer.byteLength(op.target) > 4096 || op.target.includes("\0")) throw new Error("invalid link target");
            await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; }); await symlink(op.target, path);
          } else if (op.op === "mode") {
            if (mode(op.mode) === "120000" || (await lstat(path)).isSymbolicLink()) throw new Error("mode cannot change a symlink");
            await chmod(path, op.mode === "100755" ? 0o755 : 0o644);
          } else throw new Error("unknown apply op");
          files++;
        }
        const indexed: Record<string, unknown>[] = [];
        for (const entry of entries) {
          const info = await lstat(await target(entry.path as string), { bigint: true });
          indexed.push({ ...entry, ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
        }
        check(); const index = { tree: header.toTree as string, entries: indexed };
        const dir = vm ? "/run/camelfs" : join(this.root, ".camelfs");
        await mkdir(dir, { recursive: true }); check(); await writeFile(join(dir, "index.json"), JSON.stringify(index)); check();
        this.camelfsIndex = index;
        return { ok: true, applyMs: Date.now() - started, files, entries: indexed.length };
      };
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new Error("camelFS apply timed out")); }, Math.max(1, timeoutMs));
      });
      const result = await Promise.race([work(), deadline]);
      if (output && !output.destroyed) await new Promise<void>(resolve => output!.end(encodeFrame({ applied: true, applyMs: result.applyMs }), resolve));
      return result;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      if (output && !output.destroyed) await new Promise<void>(resolve => output!.end(encodeFrame({ applied: false, error: message }), resolve));
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer); clearTimeout(connectTimer);
      input?.destroy(); child?.kill();
    }
  }

  private async files(files: { path: string; data: string; append?: boolean }[]) {
    const started = Date.now();
    await mkdir(this.repo, { recursive: true }); await mkdir(this.out, { recursive: true });
    for (const file of files ?? []) {
      const target = inside(this.repo, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.data, "base64"), { flag: file.append ? "a" : "w" });
    }
    return { ok: true, syncMs: Date.now() - started };
  }

  private run(request: { command: string; timeoutSeconds: number; pids?: number; env?: Record<string, string> }) {
    const started = Date.now();
    const stdout = new Capped(GUEST_LIMITS.streamBytes), stderr = new Capped(GUEST_LIMITS.streamBytes);
    // The pid cap: a cgroup's pids.max where the guest has cgroup v2 (a VM: the command runs as root, which ulimit -u does
    // not bind), else ulimit -u. Either failing to apply ends the command (125) rather than running it uncapped.
    // Not a security boundary: the command is root in its own VM and can raise pids.max or leave the cgroup. It keeps an
    // honest job's runaway forks in check; what bounds a hostile one is its VM (its vCPUs and memory), never this.
    const cap = Number.isInteger(request.pids) && request.pids! > 0 ? request.pids! : 0;
    const pids = !cap ? "" : `if [ -w /sys/fs/cgroup/cgroup.subtree_control ]; then g=/sys/fs/cgroup/camel-job-$$; `
      + `{ grep -q pids /sys/fs/cgroup/cgroup.subtree_control || echo +pids > /sys/fs/cgroup/cgroup.subtree_control; } && mkdir -p $g && echo ${cap} > $g/pids.max && echo $$ > $g/cgroup.procs || exit 125; `
      + `else ulimit -u ${cap} 2>/dev/null || exit 125; fi; `;
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
