import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WireMessage } from "./protocol.ts";
import { recordV8Exec } from "./metrics.ts";
import { Confined } from "./sandbox.ts";

/** One execution's link to its v8-exec process. */
export interface Guest {
  readonly dispatched: boolean;
  send(message: WireMessage): void;
  listen(onMessage: (message: unknown) => void, onClose: (reason: string) => void): void;
  end(): void;
  /** Resolves once the execution has its process (`V8Exec.max`): at once, or after waiting its turn. */
  readonly admitted?: Promise<void>;
  /**
   * Stop counting this execution's process against `V8Exec.max` while its script only waits (on delegate, another agent's
   * whole turn): within the pool's budget for waiting processes, `tenant`'s share of it. False when that is full.
   */
  park?(tenant: string | undefined): boolean;
  /** Count it again, once a process is free under `max`, before the script goes on. */
  unpark?(): Promise<void>;
}

/**
 * Code on V8, a process per execution: sandbox/v8-exec, a bare V8 isolate (no Node), started for
 * one execution and killed when it ends. Nothing is reused, so there is no pool to keep clean and
 * no watchdog here. In the image agent-launcher starts it (`Confined`): a uid of its own,
 * no environment, no_new_privs and the launcher's seccomp filter. It confines itself further: its
 * own CPU, heap and ArrayBuffer limits, rlimits, and a seccomp allowlist before guest code. The
 * wall clock is the Pi launcher's timer, which kills it.
 *
 * `prespawn` keeps that many processes started ahead, each past V8's setup and waiting for its
 * one execution; `max` bounds processes running executions at once, further ones waiting for one.
 */
export class V8Exec {
  readonly binary: string;
  /** Its arguments when this process starts it; the launcher passes its own (the same, from AGENT_V8_JITLESS). */
  readonly args: string[];
  readonly max: number;
  /** Processes whose scripts only wait (`Guest.park`), outside `max`: on the node, and one tenant's. */
  readonly parkedMax: number;
  readonly parkedPerTenant: number;
  /** The most a process may hold resident (RSS, bytes) to be parked: its memory is not freed while it waits. */
  readonly parkedMaxRss: number;
  prespawn: number;
  running = 0;
  parked = 0;
  private readonly parkedBy = new Map<string, number>();
  /** Pids of the processes running executions now, when they are this process's own. */
  readonly pids = new Set<number>();
  private readonly ready: Confined[] = [];
  private readonly waiting: (() => void)[] = [];

  constructor(options: { binary?: string; jitless?: boolean; seccomp?: boolean; max?: number; parkedMax?: number; parkedPerTenant?: number; parkedMaxRssMb?: number; prespawn?: number; maxDataMb?: number } = {}) {
    const defaults = options.binary === undefined || options.jitless === undefined || options.seccomp === undefined ? v8Settings(process.env) : undefined;
    this.binary = options.binary ?? defaults!.binary;
    const jitless = options.jitless ?? defaults!.jitless;
    const seccomp = options.seccomp ?? defaults!.seccomp;
    this.args = [
      ...(jitless ? ["--jitless"] : []),
      ...(seccomp ? [] : ["--no-seccomp"]),
      // RLIMIT_DATA, behind the heap (128 MB) and ArrayBuffer (128 MB) limits: Linux counts what is mapped writable.
      "--max-data-mb", String(options.maxDataMb ?? 512),
    ];
    this.max = options.max ?? 64;
    this.parkedMax = options.parkedMax ?? 32;
    this.parkedPerTenant = options.parkedPerTenant ?? 8;
    this.parkedMaxRss = (options.parkedMaxRssMb ?? 64) * 1024 * 1024;
    this.prespawn = options.prespawn ?? 0;
    if (!Number.isInteger(this.max) || this.max < 1 || !Number.isInteger(this.prespawn) || this.prespawn < 0
      || !Number.isInteger(this.parkedMax) || this.parkedMax < 0 || !Number.isInteger(this.parkedPerTenant) || this.parkedPerTenant < 0
      || !(this.parkedMaxRss > 0)) throw new Error("Invalid v8-exec process limits");
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
        const reply = message as { type?: string };
        if (reply?.type === "response") answered = true;
        deliver(message);
      }, ({ code, signal, error }) => {
        if (pid) this.pids.delete(pid);
        release();
        // A binary that is not installed (ENOENT) is not a failure to count: the "listening" line reports code as not running.
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
    // Parked: its process counted under `parked` (and its tenant's), not `running`; `resume` waiting to count it again.
    let parked: { tenant?: string } | undefined, resume: (() => void) | undefined;
    const unparked = () => {
      this.parked--;
      if (parked?.tenant !== undefined) {
        const left = this.parkedBy.get(parked.tenant)! - 1;
        if (left) this.parkedBy.set(parked.tenant, left); else this.parkedBy.delete(parked.tenant);
      }
      parked = undefined;
    };
    const release = () => {
      if (released || !child) return;
      released = true;
      if (resume) { this.waiting.splice(this.waiting.indexOf(resume), 1); resume = undefined; }
      if (parked) return unparked();
      this.running--;
      this.waiting.shift()?.();
    };
    const admitted = Promise.withResolvers<void>();
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
      admitted: admitted.promise,
      park: tenant => {
        if (!child || released || parked || resume || this.parked >= this.parkedMax
          || (tenant !== undefined && (this.parkedBy.get(tenant) ?? 0) >= this.parkedPerTenant)
          // Its memory unknown (no pid, as from an agent-launcher that does not report it, or no /proc): too large to park.
          || !((resident(child.pid) ?? Infinity) <= this.parkedMaxRss)) return false;
        parked = { tenant };
        this.parked++;
        if (tenant !== undefined) this.parkedBy.set(tenant, (this.parkedBy.get(tenant) ?? 0) + 1);
        this.running--;
        this.waiting.shift()?.();
        return true;
      },
      // First in line: it holds memory meanwhile, and its answers are in.
      unpark: () => new Promise<void>(resolve => {
        if (!parked || released) return resolve();
        const go = () => { resume = undefined; unparked(); this.running++; resolve(); };
        if (this.running < this.max) go(); else this.waiting.unshift(resume = go);
      }),
    };
    const admit = () => { if (!ended) { (guest as { dispatched: boolean }).dispatched = true; start(); admitted.resolve(); } };
    if (this.running < this.max) admit(); else this.waiting.push(admit);
    return guest;
  }

  close() {
    this.prespawn = 0;
    for (const proc of this.ready.splice(0)) proc.kill();
  }
}

/** A process's resident memory in bytes, where /proc tells it (Linux); undefined elsewhere or once it is gone. */
function resident(pid: number | undefined): number | undefined {
  if (!pid) return undefined;
  try { return Number(/^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]) * 1024 || undefined; }
  catch { return undefined; }
}

const envFlag = (env: NodeJS.ProcessEnv, name: string, fallback: boolean) => {
  const value = env[name];
  return value === undefined || value === "" ? fallback : !/^(0|false|no|off)$/i.test(value);
};

/** The v8-exec binary: AGENT_V8_EXEC, the image's, or this checkout's release build (npm run build:v8-exec). */
export function v8ExecBinary(env: NodeJS.ProcessEnv = process.env) {
  if (env.AGENT_V8_EXEC) return env.AGENT_V8_EXEC;
  if (existsSync("/usr/local/bin/v8-exec")) return "/usr/local/bin/v8-exec";
  return fileURLToPath(new URL("../sandbox/v8-exec/target/release/v8-exec", import.meta.url));
}

/**
 * A runner's settings from `env`: AGENT_V8_EXEC, AGENT_V8_JITLESS and AGENT_V8_SECCOMP (both on by default),
 * AGENT_V8_PRESPAWN processes started ahead (2 under agent-launcher, else none), AGENT_V8_MAX at once (64), and
 * AGENT_V8_PARKED_MAX (32) and AGENT_V8_PARKED_PER_TENANT (8) whose scripts only wait on delegate, beside those, each
 * at most AGENT_V8_PARKED_MAX_RSS_MB (64) resident when it parks: a parked process holds 22 MB (an idle script) to 42 MB
 * (one holding 100,000 small objects), and up to about 260 MB (V8's heap and ArrayBuffer limits) holding large data.
 */
export function v8Settings(env: NodeJS.ProcessEnv) {
  return {
    binary: v8ExecBinary(env), jitless: envFlag(env, "AGENT_V8_JITLESS", true), seccomp: envFlag(env, "AGENT_V8_SECCOMP", true),
    prespawn: Number(env.AGENT_V8_PRESPAWN || (env.AGENT_SANDBOX_DIR ? 2 : 0)), max: Number(env.AGENT_V8_MAX || 64),
    parkedMax: Number(env.AGENT_V8_PARKED_MAX || 32), parkedPerTenant: Number(env.AGENT_V8_PARKED_PER_TENANT || 8),
    parkedMaxRssMb: Number(env.AGENT_V8_PARKED_MAX_RSS_MB || 64),
  };
}

let shared: V8Exec | undefined;
/** This process's own runner, from its environment: an agent process's, and Pi's when given none. A node makes its own (nodeDeps). */
export function v8Exec() {
  return shared ??= new V8Exec(v8Settings(process.env));
}
