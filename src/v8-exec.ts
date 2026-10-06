import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { frames } from "./sandbox-wire.ts";
import type { Guest } from "./codemode.ts";
import type { WireMessage } from "./protocol.ts";

/**
 * js_exec as a process per execution: sandbox/v8-exec, a bare V8 isolate, spawned for one
 * execution and killed when it ends. It inherits whatever confines this process (in the image,
 * agent-launcher's uid, no_new_privs and seccomp). Nothing is reused: no pool to keep clean, no
 * snapshot to restore, no watchdog here. The child holds itself to its CPU budget and memory
 * (and RLIMIT_CPU backs that up); the wall clock is executeCode's timer, which kills it.
 *
 * `prespawn` keeps that many processes started ahead, each past V8's setup and waiting for its
 * one execution; `max` bounds processes running at once, further executions waiting for one.
 */
export class V8Exec {
  readonly binary: string;
  readonly args: string[];
  readonly max: number;
  prespawn: number;
  running = 0;
  /** CPU the processes that answered used in all, startup included, as each reported it (scripts/bench-v8-exec.ts). */
  processCpuMs = 0;
  /** Pids of the processes running executions now (scripts/bench-v8-exec.ts reads their memory). */
  readonly pids = new Set<number>();
  private readonly ready: ChildProcess[] = [];
  private readonly waiting: (() => void)[] = [];

  constructor(options: { binary?: string; snapshot?: string | false; jitless?: boolean; max?: number; prespawn?: number; maxAddressSpaceMb?: number; maxDataMb?: number } = {}) {
    this.binary = options.binary ?? v8ExecBinary();
    const snapshot = options.snapshot === undefined ? `${this.binary}${options.jitless ? ".jitless" : ""}.snapshot` : options.snapshot;
    this.args = [
      ...(options.jitless ? ["--jitless"] : []),
      ...(snapshot && existsSync(snapshot) ? ["--snapshot", snapshot] : []),
      ...(options.maxAddressSpaceMb ? ["--max-address-space-mb", String(options.maxAddressSpaceMb)] : []),
      ...(options.maxDataMb ? ["--max-data-mb", String(options.maxDataMb)] : []),
    ];
    this.max = options.max ?? 64;
    // The memory backstop on Linux: RLIMIT_DATA, 512 MB (RLIMIT_AS cannot be used: V8 reserves ~17 GB of address space).
    if (options.maxDataMb === undefined && process.platform === "linux") this.args.push("--max-data-mb", "512");
    this.prespawn = options.prespawn ?? 0;
    this.refill();
  }

  private spawn() {
    // No environment, no inherited descriptors besides the three pipes.
    const child = spawn(this.binary, this.args, { stdio: ["pipe", "pipe", "ignore"], env: {} });
    child.on("error", () => {});
    child.stdin!.on("error", () => {});
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
    let ended = false;
    const start = () => {
      this.running++;
      child = this.ready.shift() ?? this.spawn();
      this.refill();
      write = frames(child.stdout as Socket, message => {
        const cpu = (message as { result?: { processCpuMs?: unknown } })?.result?.processCpuMs;
        if (typeof cpu === "number") this.processCpuMs += cpu;
        deliver(message);
      }, undefined, child.stdin as Socket);
      const pid = child.pid;
      if (pid) this.pids.add(pid);
      child.once("close", (code, signal) => {
        if (pid) this.pids.delete(pid);
        release();
        onClose(signal === "SIGXCPU" ? "Codemode CPU limit exceeded: the sandbox process reached RLIMIT_CPU" : `Codemode sandbox process exited (${signal ?? code})`);
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
      listen(onMessage, close) { deliver = onMessage; onClose = close; },
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

/** The v8-exec binary: AGENT_V8_EXEC, the image's, or this checkout's release build. */
export function v8ExecBinary() {
  if (process.env.AGENT_V8_EXEC) return process.env.AGENT_V8_EXEC;
  if (existsSync("/usr/local/bin/v8-exec")) return "/usr/local/bin/v8-exec";
  return fileURLToPath(new URL("../sandbox/v8-exec/target/release/v8-exec", import.meta.url));
}

let shared: V8Exec | undefined;
/** The process-wide runner, prespawning AGENT_V8_PRESPAWN processes. */
export function v8Exec() {
  return shared ??= new V8Exec({ prespawn: Number(process.env.AGENT_V8_PRESPAWN ?? 0), jitless: process.env.AGENT_V8_JITLESS === "1" });
}
