import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { frames } from "./sandbox-wire.ts";
import type { Guest } from "./codemode.ts";
import type { WireMessage } from "./protocol.ts";
import { recordV8Exec } from "./metrics.ts";

/**
 * js_exec on V8, a process per execution: sandbox/v8-exec, a bare V8 isolate (no Node), spawned for
 * one execution and killed when it ends. Nothing is reused, so there is no pool to keep clean and
 * no watchdog here. It inherits whatever confines this process (in the image, a sandbox process's
 * uid, no_new_privs and agent-launcher's seccomp filter), and confines itself further: its own CPU,
 * heap and ArrayBuffer limits, rlimits, and a seccomp allowlist before guest code. The wall clock
 * is executeCode's timer, which kills it.
 *
 * `prespawn` keeps that many processes started ahead, each past V8's setup and waiting for its
 * one execution; `max` bounds processes running executions at once, further ones waiting for one.
 */
export class V8Exec {
  readonly binary: string;
  readonly args: string[];
  readonly max: number;
  readonly trap: boolean;
  prespawn: number;
  running = 0;
  /** CPU the processes that answered used in all, startup included, as each reported it (scripts/bench-v8-exec.ts). */
  processCpuMs = 0;
  /** Pids of the processes running executions now. */
  readonly pids = new Set<number>();
  private readonly ready: ChildProcess[] = [];
  private readonly waiting: (() => void)[] = [];

  constructor(options: { binary?: string; jitless?: boolean; seccomp?: boolean; max?: number; prespawn?: number; maxDataMb?: number } = {}) {
    this.binary = options.binary ?? v8ExecBinary();
    const jitless = options.jitless ?? envFlag("AGENT_V8_JITLESS", true);
    const seccomp = options.seccomp ?? envFlag("AGENT_V8_SECCOMP", true);
    // AGENT_V8_SECCOMP=trap (debugging): a refused call is reported on this process's stderr, by number, instead of killing silently.
    this.trap = process.env.AGENT_V8_SECCOMP === "trap";
    this.args = [
      ...(jitless ? ["--jitless"] : []),
      ...(seccomp ? [] : ["--no-seccomp"]),
      ...(this.trap ? ["--seccomp-trap"] : []),
      // RLIMIT_DATA, behind the heap (128 MB) and ArrayBuffer (128 MB) limits: Linux counts what is mapped writable.
      "--max-data-mb", String(options.maxDataMb ?? 512),
    ];
    this.max = options.max ?? 64;
    this.prespawn = options.prespawn ?? 0;
    if (!Number.isInteger(this.max) || this.max < 1 || !Number.isInteger(this.prespawn) || this.prespawn < 0) throw new Error("Invalid v8-exec process limits");
    this.refill();
  }

  private spawn() {
    // No environment, and no descriptors besides the three pipes.
    const child = spawn(this.binary, this.args, { stdio: ["pipe", "pipe", this.trap ? "inherit" : "ignore"], env: {} });
    child.stdin!.on("error", () => {});
    // A binary that is not installed (ENOENT) is not a failure to count: the "listening" line reports the engine as
    // unavailable, and a metric line here would print before it.
    child.once("error", error => { const code = (error as NodeJS.ErrnoException).code; if (code !== "ENOENT") recordV8Exec({ event: "spawn_failed", code }); });
    return child;
  }

  private refill() {
    for (let i = this.ready.length - 1; i >= 0; i--) if (this.ready[i].exitCode !== null || this.ready[i].signalCode !== null) this.ready.splice(i, 1);
    while (this.ready.length < this.prespawn) this.ready.push(this.spawn());
  }

  open(): Guest {
    let child: ChildProcess | undefined;
    let write: ((message: unknown) => void) | undefined;
    const queued: WireMessage[] = [];
    let deliver: (message: unknown) => void = () => {};
    let onClose: (reason: string) => void = () => {};
    let ended = false, answered = false, closed = false;
    const close = (reason: string) => { if (!closed) { closed = true; onClose(reason); } };
    const start = () => {
      this.running++;
      const proc = child = this.ready.shift() ?? this.spawn();
      this.refill();
      write = frames(proc.stdout as Socket, message => {
        const reply = message as { type?: string; result?: { processCpuMs?: unknown } };
        if (reply?.type === "response") answered = true;
        if (typeof reply?.result?.processCpuMs === "number") this.processCpuMs += reply.result.processCpuMs;
        deliver(message);
      }, undefined, proc.stdin as Socket);
      const pid = proc.pid;
      if (pid) this.pids.add(pid);
      proc.once("error", error => { release(); close(`Codemode sandbox process could not start (${(error as NodeJS.ErrnoException).code ?? "error"})`); });
      proc.once("close", (code, signal) => {
        if (pid) this.pids.delete(pid);
        release();
        // Killed by something other than this side: the kernel for its rlimits or seccomp, or the OOM killer.
        if (!ended && !answered && signal) recordV8Exec({ event: "killed", signal });
        close(signal === "SIGSYS" ? "Codemode sandbox process exited (SIGSYS: a system call outside its seccomp allowlist)"
          : signal === "SIGXCPU" || (signal === "SIGKILL" && !ended) ? `Codemode sandbox process exited (${signal}: a resource limit)`
          : `Codemode sandbox process exited (${signal ?? code})`);
      });
      for (const message of queued.splice(0)) guest.send(message);
    };
    let released = false;
    const release = () => {
      if (released || !child) return;
      released = true;
      this.running--;
      this.waiting.shift()?.();
    };
    const guest: Guest = {
      dispatched: false,
      send(message) {
        if (!write) return void queued.push(message);
        try { write(message); } catch { child!.kill("SIGKILL"); }
      },
      listen(onMessage, onClosed) { deliver = onMessage; onClose = onClosed; },
      end: () => {
        if (ended) return;
        ended = true;
        if (child) { child.kill("SIGKILL"); release(); }
        else this.waiting.splice(this.waiting.indexOf(admit), 1);
      },
    };
    const admit = () => { if (!ended) { (guest as { dispatched: boolean }).dispatched = true; start(); } };
    if (this.running < this.max) admit(); else this.waiting.push(admit);
    return guest;
  }

  close() {
    this.prespawn = 0;
    for (const child of this.ready.splice(0)) child.kill("SIGKILL");
  }
}

const envFlag = (name: string, fallback: boolean) => {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : !/^(0|false|no|off)$/i.test(value);
};

/** The v8-exec binary: AGENT_V8_EXEC, the image's, or this checkout's release build (npm run build:v8-exec). */
export function v8ExecBinary() {
  if (process.env.AGENT_V8_EXEC) return process.env.AGENT_V8_EXEC;
  if (existsSync("/usr/local/bin/v8-exec")) return "/usr/local/bin/v8-exec";
  return fileURLToPath(new URL("../sandbox/v8-exec/target/release/v8-exec", import.meta.url));
}

let shared: V8Exec | undefined;
/**
 * This process's runner, for executions on V8 without sandbox processes: AGENT_V8_PRESPAWN processes
 * started ahead (none by default), AGENT_V8_MAX at once (64).
 */
export function v8Exec() {
  return shared ??= new V8Exec({ prespawn: Number(process.env.AGENT_V8_PRESPAWN || 0), max: Number(process.env.AGENT_V8_MAX || 64) });
}
