import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Guest } from "./codemode.ts";
import type { WireMessage } from "./protocol.ts";
import { recordV8Exec } from "./metrics.ts";
import { Confined, sandboxDir } from "./sandbox.ts";

/**
 * js_exec on V8, a process per execution: sandbox/v8-exec, a bare V8 isolate (no Node), started for
 * one execution and killed when it ends. Nothing is reused, so there is no pool to keep clean and
 * no watchdog here. In the image agent-launcher starts it (`Confined`): a uid of its own,
 * no environment, no_new_privs and the launcher's seccomp filter. It confines itself further: its
 * own CPU, heap and ArrayBuffer limits, rlimits, and a seccomp allowlist before guest code. The
 * wall clock is executeCode's timer, which kills it.
 *
 * `prespawn` keeps that many processes started ahead, each past V8's setup and waiting for its
 * one execution; `max` bounds processes running executions at once, further ones waiting for one.
 */
export class V8Exec {
  readonly binary: string;
  /** Its arguments when this process starts it; the launcher passes its own (the same, from AGENT_V8_JITLESS). */
  readonly args: string[];
  readonly max: number;
  prespawn: number;
  running = 0;
  /** CPU the processes that answered used in all, startup included, as each reported it (scripts/bench-v8-exec.ts). */
  processCpuMs = 0;
  /** Pids of the processes running executions now, when they are this process's own. */
  readonly pids = new Set<number>();
  private readonly ready: Confined[] = [];
  private readonly waiting: (() => void)[] = [];

  constructor(options: { binary?: string; jitless?: boolean; seccomp?: boolean; max?: number; prespawn?: number; maxDataMb?: number } = {}) {
    this.binary = options.binary ?? v8ExecBinary();
    const jitless = options.jitless ?? envFlag("AGENT_V8_JITLESS", true);
    const seccomp = options.seccomp ?? envFlag("AGENT_V8_SECCOMP", true);
    this.args = [
      ...(jitless ? ["--jitless"] : []),
      ...(seccomp ? [] : ["--no-seccomp"]),
      // RLIMIT_DATA, behind the heap (128 MB) and ArrayBuffer (128 MB) limits: Linux counts what is mapped writable.
      "--max-data-mb", String(options.maxDataMb ?? 512),
    ];
    this.max = options.max ?? 64;
    this.prespawn = options.prespawn ?? 0;
    if (!Number.isInteger(this.max) || this.max < 1 || !Number.isInteger(this.prespawn) || this.prespawn < 0) throw new Error("Invalid v8-exec process limits");
    this.refill();
  }

  private spawn() { return new Confined("v8", { command: this.binary, args: this.args }); }

  private refill() {
    for (let i = this.ready.length - 1; i >= 0; i--) if (this.ready[i].closed) this.ready.splice(i, 1);
    while (this.ready.length < this.prespawn) this.ready.push(this.spawn());
  }

  /** A process started ahead that is still there, or a new one. */
  private take() {
    for (let proc = this.ready.shift(); proc; proc = this.ready.shift()) if (!proc.closed) return proc;
    return this.spawn();
  }

  open(): Guest {
    let child: Confined | undefined;
    const queued: WireMessage[] = [];
    let deliver: (message: unknown) => void = () => {};
    let onClose: (reason: string) => void = () => {};
    let ended = false, answered = false, closed = false;
    const close = (reason: string) => { if (!closed) { closed = true; onClose(reason); } };
    const start = () => {
      this.running++;
      const proc = child = this.take();
      this.refill();
      const pid = proc.pid;
      if (pid) this.pids.add(pid);
      proc.listen(message => {
        const reply = message as { type?: string; result?: { processCpuMs?: unknown } };
        if (reply?.type === "response") answered = true;
        if (typeof reply?.result?.processCpuMs === "number") this.processCpuMs += reply.result.processCpuMs;
        deliver(message);
      }, ({ code, signal, error }) => {
        if (pid) this.pids.delete(pid);
        release();
        // A binary that is not installed (ENOENT) is not a failure to count: the "listening" line reports js_exec as not running.
        if (error) {
          if (error !== "ENOENT") recordV8Exec({ event: "spawn_failed", code: error });
          return close(`Codemode sandbox process could not start (${error})`);
        }
        // Killed by something other than this side: the kernel for its rlimits or seccomp, or the OOM killer.
        if (!ended && !answered && signal) recordV8Exec({ event: "killed", signal });
        close(signal === "SIGSYS" ? "Codemode sandbox process exited (SIGSYS: a system call outside its seccomp allowlist)"
          : signal === "SIGXCPU" || (signal === "SIGKILL" && !ended) ? `Codemode sandbox process exited (${signal}: a resource limit)`
          : `Codemode sandbox process exited (${signal ?? code ?? "no status"})`);
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
        if (!child) return void queued.push(message);
        try { child.send(message); } catch { child.kill(); }
      },
      listen(onMessage, onClosed) { deliver = onMessage; onClose = onClosed; },
      end: () => {
        if (ended) return;
        ended = true;
        if (child) { child.kill(); release(); }
        else this.waiting.splice(this.waiting.indexOf(admit), 1);
      },
    };
    const admit = () => { if (!ended) { (guest as { dispatched: boolean }).dispatched = true; start(); } };
    if (this.running < this.max) admit(); else this.waiting.push(admit);
    return guest;
  }

  close() {
    this.prespawn = 0;
    for (const proc of this.ready.splice(0)) proc.kill();
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
 * This process's runner: AGENT_V8_PRESPAWN processes started ahead (2 under agent-launcher, else none),
 * AGENT_V8_MAX at once (64).
 */
export function v8Exec() {
  return shared ??= new V8Exec({ prespawn: Number(process.env.AGENT_V8_PRESPAWN || (sandboxDir() ? 2 : 0)), max: Number(process.env.AGENT_V8_MAX || 64) });
}
