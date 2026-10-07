import { AsyncResource, createHook } from "node:async_hooks";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { BinaryLike, ScryptOptions } from "node:crypto";
import FakeTimers from "@sinonjs/fake-timers";
import { nodeContext, type Clock, type Random } from "../../src/node-context.ts";
import { SimSocket } from "./duplex.ts";

const require = createRequire(import.meta.url);
const crypto = require("node:crypto") as typeof import("node:crypto");
const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
const fs = require("node:fs") as typeof import("node:fs");

/** A seeded generator (sfc32): the same seed, the same numbers, on any machine. */
export function prng(seed: string) {
  // xmur3 spreads the seed into four 32-bit words.
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  const word = () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; };
  let a = word(), b = word(), c = word(), d = word();
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  const random: Random & { int(below: number): number } = {
    float: next,
    bytes: size => { const out = Buffer.alloc(size); for (let i = 0; i < size; i++) out[i] = Math.floor(next() * 256); return out; },
    int: below => Math.floor(next() * below),
  };
  return random;
}

/**
 * What a simulated node's clock is off by: `skewMs` on its wall clock (a jump changes it while the node runs), `wallDrift`
 * on its wall clock's rate, `drift` on its monotonic clock's rate.
 */
export type ClockSkew = { skewMs?: number; drift?: number; wallDrift?: number };

/**
 * The simulation's environment, for the whole process (one simulation at a time):
 * - **Time.** @sinonjs/fake-timers fakes Date, performance, hrtime and the timers, so time moves only when the
 *   simulation moves it (`advance`). Date.now and performance.now are then each node's (its `clock`, with its skew and
 *   drift) when code runs for a node (nodeContext), and the base clock otherwise: the database and the fakes.
 * - **Randomness.** Math.random and node:crypto's random functions (randomUUID, randomBytes, randomInt, randomFill,
 *   getRandomValues; also globalThis.crypto's) draw from seeded generators: each node's own, else the world's.
 *   syncBuiltinESMExports makes `import { randomUUID } from "node:crypto"` see them.
 * - **Files.** The few files a node touches on simulated paths (agents' working directories) are made and removed
 *   synchronously, so no thread pool decides an order.
 * - **Leaks.** Any real I/O (sockets, DNS, file requests, child processes, workers, zlib) started while installed is
 *   recorded (`leaks`): a source of nondeterminism to remove.
 *
 * What stays real: process.nextTick, queueMicrotask and setImmediate, whose order the program fixes.
 */
export class SimEnv {
  /** The simulation's clock: fake timers, or (realTime) the machine's own, paced by real sleeps. */
  readonly clock: { readonly now: number; tickAsync(ms: number): Promise<unknown>; uninstall(): unknown };
  /** Whether time is the machine's (the real-Postgres mode): runs are then not deterministic, and real I/O is expected. */
  readonly realTime: boolean;
  readonly random: ReturnType<typeof prng>;
  readonly start: number;
  readonly leaks: string[] = [];
  /** What nodes and the world wrote to the console, with the virtual time and who wrote it (`names` maps a node's clock to its name). */
  readonly logs: { at: number; by: string; line: string }[] = [];
  readonly names = new Map<Clock, string>();
  /** With SIM_TRACE_TIMERS set: every timer that fired, when, for whom and where it was set (for finding where runs part). */
  readonly timerTrace: string[] = [];
  private readonly restore: (() => void)[] = [];
  private readonly baseClock: Clock;
  /** Each node's pending timers, by its clock (which is how code running for it is told apart), and the crashed nodes'. */
  private readonly timers = new Map<Clock, Set<unknown>>();
  private readonly crashed = new Set<Clock>();
  /** Paused nodes: what is waiting for each to run again (its timers that came due, its sockets' data), in order. */
  private readonly paused = new Map<Clock, { queue: (() => void)[]; timers: Set<unknown>; resumed: PromiseWithResolvers<void> }>();

  /**
   * `quiet`: the console's lines go to `logs` only, not to the terminal. `realTime`: keep the machine's clock and timers
   * (for a real database, whose I/O takes real time); everything else (per-node contexts, crashes, pauses, seeded
   * randomness) is as in a simulated run, but the order of events is the machine's.
   */
  constructor(seed: string, start = Date.UTC(2030, 0, 1), quiet = false, realTime = false) {
    this.realTime = realTime;
    const machine = { now: Date.now.bind(Date), setTimeout: globalThis.setTimeout };
    this.start = realTime ? machine.now() : start;
    this.random = prng(`world:${seed}`);
    this.clock = realTime
      ? { get now() { return machine.now(); }, tickAsync: (ms: number) => new Promise<number>(resolve => machine.setTimeout(() => resolve(machine.now()), ms)), uninstall: () => [] }
      : FakeTimers.install({ now: start, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "hrtime"], loopLimit: 10_000_000, shouldClearNativeTimers: true });
    const clock = this.clock;
    this.baseClock = this.nodeClock({});
    const nowOf = () => nodeContext()?.clock ?? this.baseClock;
    const patch = <T extends object, K extends keyof T>(target: T, name: K, value: T[K]) => {
      const original = target[name];
      target[name] = value;
      this.restore.push(() => { target[name] = original; });
    };
    patch(Date, "now", () => nowOf().now());
    patch(performance, "now", () => nowOf().monotonic());
    void clock;
    // Timers belong to the node that set them, so a crash can take them all, and a crashed node sets none.
    // Fake timers run their callbacks from the simulation's loop, not in the async context that set them as real timers
    // do: each callback is bound to its setter's context, so a node's timer runs as that node.
    const tracing = !!process.env.SIM_TRACE_TIMERS;
    const owned = (set: typeof setTimeout, once: boolean) => ((given: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      let callback = AsyncResource.bind(given);
      if (tracing) {
        const site = new Error().stack!.split("\n").slice(2).find(line => !line.includes("tests/sim/env.ts") && !line.includes("node:"))?.trim() ?? "?";
        const by = nodeContext()?.clock;
        const run = callback;
        callback = ((...given: unknown[]) => { this.timerTrace.push(`${this.clock.now - start} ${by ? this.names.get(by) : "world"} ${site.replace(/\(.*\/(src|tests|node_modules)\//, "($1/")}`); return run(...given); }) as typeof callback;
      }
      const node = nodeContext()?.clock;
      if (!node) return set(callback, ms, ...args);
      if (this.crashed.has(node)) { const dead = set(() => {}, 0); clearTimeout(dead); return dead; }
      let mine = this.timers.get(node);
      if (!mine) this.timers.set(node, mine = new Set());
      const pending = mine;
      // A one-off timer that ran is no longer pending.
      // A paused node's timer that comes due runs when it resumes, once, as a stopped process's late timer does.
      const run = (...given: unknown[]) => {
        const pause = this.paused.get(node);
        if (!pause) return callback(...given);
        if (pause.timers.has(timer)) return;
        pause.timers.add(timer);
        // Unless it is cleared before the node gets to it.
        pause.queue.push(() => { if (!cleared.has(timer as object)) callback(...given); });
      };
      const timer: ReturnType<typeof setTimeout> = set(once ? (...given: unknown[]) => { pending.delete(timer); run(...given); } : run, ms, ...args);
      pending.add(timer);
      owners.set(timer, pending);
      return timer;
    }) as typeof setTimeout;
    const owners = new WeakMap<object, Set<unknown>>();
    const cleared = new WeakSet<object>();
    const unowned = (clear: typeof clearTimeout) => ((timer?: ReturnType<typeof setTimeout>) => {
      if (timer && typeof timer === "object") { owners.get(timer)?.delete(timer); cleared.add(timer); }
      clear(timer);
    }) as typeof clearTimeout;
    patch(globalThis, "clearTimeout", unowned(globalThis.clearTimeout));
    patch(globalThis, "clearInterval", unowned(globalThis.clearInterval as typeof clearTimeout) as typeof clearInterval);
    const fakeSetTimeout = globalThis.setTimeout, fakeSetInterval = globalThis.setInterval;
    patch(globalThis, "setTimeout", owned(fakeSetTimeout, true));
    patch(globalThis, "setInterval", owned(fakeSetInterval as unknown as typeof setTimeout, false) as unknown as typeof setInterval);

    // AbortSignal.timeout runs on Node's internal timers, which fake timers do not reach: one on the simulation's clock
    // (and, through setTimeout, the caller's node) instead.
    patch(AbortSignal, "timeout", ((ms: number) => {
      const controller = new AbortController();
      // Unref'd, as the real one is: a pending timeout keeps nothing alive.
      setTimeout(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), ms).unref?.();
      return controller.signal;
    }) as typeof AbortSignal.timeout);

    // Randomness: the node's stream, else the world's.
    const source = () => nodeContext()?.random ?? this.random;
    const bytes = (size: number) => source().bytes(size);
    const fill = <V extends ArrayBufferView>(view: V) => { Buffer.from(view.buffer, view.byteOffset, view.byteLength).set(bytes(view.byteLength)); return view; };
    const uuid = () => {
      const b = bytes(16);
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const hex = b.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
    };
    patch(Math, "random", () => source().float());
    patch(crypto, "randomUUID", uuid as typeof crypto.randomUUID);
    patch(crypto, "randomBytes", ((size: number, callback?: (error: Error | null, buffer: Buffer) => void) => {
      const out = bytes(size);
      if (callback) { process.nextTick(callback, null, out); return undefined; }
      return out;
    }) as typeof crypto.randomBytes);
    patch(crypto, "randomInt", ((min: number, max?: number, callback?: (error: Error | null, value: number) => void) => {
      if (max === undefined || typeof max === "function") { callback = max as never; max = min; min = 0; }
      const value = min + Math.floor(source().float() * (max - min));
      if (callback) { process.nextTick(callback, null, value); return undefined; }
      return value;
    }) as typeof crypto.randomInt);
    patch(crypto, "randomFillSync", ((view: ArrayBufferView) => fill(view)) as typeof crypto.randomFillSync);
    // Key derivation runs on libuv's thread pool, which finishes in real time: done synchronously instead, its callback
    // on the next tick.
    patch(crypto, "scrypt", ((password: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions | ((error: Error | null, key: Buffer) => void), callback?: (error: Error | null, key: Buffer) => void) => {
      if (typeof options === "function") { callback = options; options = {}; }
      let key: Buffer;
      try { key = crypto.scryptSync(password, salt, keylen, options); } catch (error) { process.nextTick(callback!, error as Error, Buffer.alloc(0)); return; }
      process.nextTick(callback!, null, key);
    }) as typeof crypto.scrypt);
    patch(globalThis.crypto, "getRandomValues", ((view: ArrayBufferView) => fill(view)) as typeof globalThis.crypto.getRandomValues);
    patch(globalThis.crypto, "randomUUID", uuid);

    // The console: every line kept, with when and by whom.
    for (const method of ["log", "error", "warn", "info"] as const) {
      const original = console[method];
      patch(console, method, ((...args: unknown[]) => {
        const node = nodeContext()?.clock;
        this.logs.push({ at: this.clock.now - start, by: node ? this.names.get(node) ?? "node" : "world", line: args.map(String).join(" ") });
        if (!quiet) original.apply(console, args);
      }) as typeof console.log);
    }

    // Sockets deliver to their node through `deliver`, so a paused node reads nothing.
    patch(SimSocket, "gate", (owner, work) => this.deliver(owner as Clock, work));
    patch(SimSocket, "owner", () => nodeContext()?.clock);

    // Files: synchronous, so they finish where they start.
    patch(fsPromises, "mkdir", (async (path: string, options?: object) => fs.mkdirSync(path, options as never)) as typeof fsPromises.mkdir);
    patch(fsPromises, "rm", (async (path: string, options?: object) => fs.rmSync(path, options as never)) as typeof fsPromises.rm);
    syncBuiltinESMExports();

    // Real I/O started while installed.
    const REAL = new Set(["TCPWRAP", "TCPCONNECTWRAP", "TCPSERVERWRAP", "GETADDRINFOREQWRAP", "FSREQCALLBACK", "FSREQPROMISE", "PROCESSWRAP", "PIPEWRAP", "ZLIB", "WORKER", "UDPWRAP", "TLSWRAP"]);
    const hook = createHook({
      init: (_id, type) => { if (REAL.has(type) && !realTime) this.leaks.push(`${type}\n${new Error().stack!.split("\n").filter(line => line.includes("file://")).slice(0, 6).join("\n")}`); },
    });
    hook.enable();
    this.restore.push(() => hook.disable());
  }

  /**
   * A node's process dies: its pending timers never run, and it sets no more. (Its I/O is cut by the network, database
   * and store; code of it still awaiting something finds every call failing.)
   */
  crash(clock: Clock) {
    this.crashed.add(clock);
    for (const timer of this.timers.get(clock) ?? []) clearTimeout(timer as never);
    this.timers.delete(clock);
  }

  /**
   * A node's process stops for `ms` (SIGSTOP, a long GC pause, a starved CPU): none of its timers run and nothing reaches
   * it (sockets, the database, notifications) until it resumes; then what came due runs at once, late, in order.
   * Peers and the database go on. Settles when it resumes.
   */
  pause(clock: Clock, ms: number) {
    if (this.paused.has(clock) || this.crashed.has(clock)) return Promise.resolve();
    const pause = { queue: [] as (() => void)[], timers: new Set<unknown>(), resumed: Promise.withResolvers<void>() };
    this.paused.set(clock, pause);
    // The world's timer, not the node's: a paused node's own timers wait.
    this.world.runInAsyncScope(() => setTimeout(() => {
      this.paused.delete(clock);
      for (const work of pause.queue) work();
      pause.resumed.resolve();
    }, ms));
    return pause.resumed.promise;
  }
  /** Whether a node is paused now. */
  isPaused(clock: Clock) { return this.paused.has(clock); }
  /** Resolves once `clock`'s node is running (at once unless it is paused). */
  whenRunning(clock: Clock): Promise<void> { return this.paused.get(clock)?.resumed.promise ?? Promise.resolve(); }
  /** Run `work` for `clock`'s node now, or when it resumes if it is paused (in order with what else waits). */
  deliver(clock: Clock | undefined, work: () => void) {
    const pause = clock && this.paused.get(clock);
    if (pause) pause.queue.push(work); else work();
  }
  private readonly world = new AsyncResource("SimEnv");

  /** The clock of a node off by `skew`: its own wall and monotonic time, on the simulation's timers. */
  nodeClock(skew: ClockSkew): Clock {
    const clock = this.clock;
    const start = this.start;
    return {
      now: () => clock.now + (skew.skewMs ?? 0) + Math.round((clock.now - start) * (skew.wallDrift ?? 0)),
      monotonic: () => (clock.now - start) * (1 + (skew.drift ?? 0)),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: timer => clearTimeout(timer),
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: timer => clearInterval(timer),
      sleep: (ms, options) => new Promise<void>((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) return reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
        const abort = () => { clearTimeout(timer); reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR", cause: signal?.reason })); };
        signal?.addEventListener("abort", abort, { once: true });
      }),
    };
  }

  /** Virtual milliseconds since the simulation began. */
  get elapsed() { return this.clock.now - this.start; }

  /** Whether something is moving the clock now: only one may, or runs would interleave by the real machine's speed. */
  private driving = false;
  private async drive<T>(work: () => Promise<T>): Promise<T> {
    if (this.driving) throw new Error("The simulation's clock is already being moved: settle and advance may not run at once");
    this.driving = true;
    try { return await work(); } finally { this.driving = false; }
  }

  /** Move time on by `ms`, running every timer that comes due and what it starts. */
  advance(ms: number) { return this.drive(() => this.clock.tickAsync(ms)); }

  /** Run until `promise` settles, `stepMs` of virtual time at a time, failing past `limitMs`. */
  settle<T>(promise: Promise<T>, limitMs = 10 * 60_000, stepMs = 10): Promise<T> {
    let settled = false;
    const watched = promise.finally(() => { settled = true; });
    watched.catch(() => {});
    return this.drive(async () => {
      for (const deadline = this.elapsed + limitMs; !settled;) {
        if (this.elapsed >= deadline) throw new Error(`Still pending after ${limitMs} virtual ms`);
        await this.clock.tickAsync(stepMs);
      }
      return watched;
    });
  }

  uninstall() {
    for (const restore of this.restore.reverse()) restore();
    this.restore.length = 0;
    syncBuiltinESMExports();
    this.clock.uninstall();
  }
}
