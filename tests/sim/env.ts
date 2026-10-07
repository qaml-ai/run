import { AsyncResource, createHook } from "node:async_hooks";
import { createRequire, syncBuiltinESMExports } from "node:module";
import FakeTimers from "@sinonjs/fake-timers";
import { nodeContext, type Clock, type Random } from "../../src/node-context.ts";

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

/** What a simulated node's clock is off by: `skewMs` on its wall clock, `drift` on its monotonic clock's rate. */
export type ClockSkew = { skewMs?: number; drift?: number };

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
  readonly clock: ReturnType<typeof FakeTimers.install>;
  readonly random: ReturnType<typeof prng>;
  readonly start: number;
  readonly leaks: string[] = [];
  /** What nodes and the world wrote to the console, with the virtual time and who wrote it (`names` maps a node's clock to its name). */
  readonly logs: { at: number; by: string; line: string }[] = [];
  readonly names = new Map<Clock, string>();
  private readonly restore: (() => void)[] = [];
  private readonly baseClock: Clock;
  /** Each node's pending timers, by its clock (which is how code running for it is told apart), and the crashed nodes'. */
  private readonly timers = new Map<Clock, Set<unknown>>();
  private readonly crashed = new Set<Clock>();

  /** `quiet`: the console's lines go to `logs` only, not to the terminal. */
  constructor(seed: string, start = Date.UTC(2030, 0, 1), quiet = false) {
    this.start = start;
    this.random = prng(`world:${seed}`);
    this.clock = FakeTimers.install({ now: start, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance", "hrtime"], loopLimit: 10_000_000, shouldClearNativeTimers: true });
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
    const owned = (set: typeof setTimeout, once: boolean) => ((given: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const callback = AsyncResource.bind(given);
      const node = nodeContext()?.clock;
      if (!node) return set(callback, ms, ...args);
      if (this.crashed.has(node)) { const dead = set(() => {}, 0); clearTimeout(dead); return dead; }
      let mine = this.timers.get(node);
      if (!mine) this.timers.set(node, mine = new Set());
      const pending = mine;
      // A one-off timer that ran is no longer pending.
      const timer: ReturnType<typeof setTimeout> = set(once ? (...given: unknown[]) => { pending.delete(timer); callback(...given); } : callback, ms, ...args);
      pending.add(timer);
      owners.set(timer, pending);
      return timer;
    }) as typeof setTimeout;
    const owners = new WeakMap<object, Set<unknown>>();
    const unowned = (clear: typeof clearTimeout) => ((timer?: ReturnType<typeof setTimeout>) => {
      if (timer && typeof timer === "object") owners.get(timer)?.delete(timer);
      clear(timer);
    }) as typeof clearTimeout;
    patch(globalThis, "clearTimeout", unowned(globalThis.clearTimeout));
    patch(globalThis, "clearInterval", unowned(globalThis.clearInterval as typeof clearTimeout) as typeof clearInterval);
    const fakeSetTimeout = globalThis.setTimeout, fakeSetInterval = globalThis.setInterval;
    patch(globalThis, "setTimeout", owned(fakeSetTimeout, true));
    patch(globalThis, "setInterval", owned(fakeSetInterval as unknown as typeof setTimeout, false) as unknown as typeof setInterval);

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

    // Files: synchronous, so they finish where they start.
    patch(fsPromises, "mkdir", (async (path: string, options?: object) => fs.mkdirSync(path, options as never)) as typeof fsPromises.mkdir);
    patch(fsPromises, "rm", (async (path: string, options?: object) => fs.rmSync(path, options as never)) as typeof fsPromises.rm);
    syncBuiltinESMExports();

    // Real I/O started while installed.
    const REAL = new Set(["TCPWRAP", "TCPCONNECTWRAP", "TCPSERVERWRAP", "GETADDRINFOREQWRAP", "FSREQCALLBACK", "FSREQPROMISE", "PROCESSWRAP", "PIPEWRAP", "ZLIB", "WORKER", "UDPWRAP", "TLSWRAP"]);
    const hook = createHook({
      init: (_id, type) => { if (REAL.has(type)) this.leaks.push(`${type}\n${new Error().stack!.split("\n").filter(line => line.includes("file://")).slice(0, 6).join("\n")}`); },
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

  /** The clock of a node off by `skew`: its own wall and monotonic time, on the simulation's timers. */
  nodeClock(skew: ClockSkew): Clock {
    const clock = this.clock;
    const start = this.start;
    return {
      now: () => clock.now + (skew.skewMs ?? 0),
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

  /** Move time on by `ms`, running every timer that comes due and what it starts. */
  advance(ms: number) { return this.clock.tickAsync(ms); }

  /** Run until `promise` settles, `stepMs` of virtual time at a time, failing past `limitMs`. */
  async settle<T>(promise: Promise<T>, limitMs = 10 * 60_000, stepMs = 10): Promise<T> {
    let settled = false;
    const watched = promise.finally(() => { settled = true; });
    watched.catch(() => {});
    for (const deadline = this.elapsed + limitMs; !settled;) {
      if (this.elapsed >= deadline) throw new Error(`Still pending after ${limitMs} virtual ms`);
      await this.clock.tickAsync(stepMs);
    }
    return watched;
  }

  uninstall() {
    for (const restore of this.restore.reverse()) restore();
    this.restore.length = 0;
    syncBuiltinESMExports();
    this.clock.uninstall();
  }
}
