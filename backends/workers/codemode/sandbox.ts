import {
  RemoteCodemodeSandbox, type CodemodeExecuteOptions, type CodemodeHostCall, type CodemodeOutcome, type CodemodeResult,
  type CodemodeRun, type CodemodeRunOptions, type RemoteCodemodeSandboxOptions,
} from "@earendil-works/pi-codemode/portable";
import { FS_SHIM } from "./fs-shim.ts";
import { SANDBOX_LIMITS } from "../../../src/limits.ts";

/** Calls a script waits on off its clock, as on v8-exec: a sub-agent's answer is not the script's time. */
const OFF_THE_CLOCK = new Set(["delegate"]);

/**
 * Scripts by their start (`startedAt` and seed, as Pi's code mode run records them): which of their calls wait on a
 * person, and whether an input one waited on was closed without an answer. A call from code finds its script in Pi's
 * run document (human.ts), and may do so before the script starts again after a restart.
 */
type Script = { waiting: Map<number, number>; ended?: string; runs: Set<ScriptRun>; expires?: ReturnType<typeof setTimeout> };
const scripts = new Map<string, Script>();
const keyOf = (startedAt: number, seed: number) => `${startedAt}:${seed}`;
function script(key: string) {
  let found = scripts.get(key);
  if (!found) scripts.set(key, found = { waiting: new Map(), runs: new Set() });
  return found;
}
function forget(key: string) {
  const found = scripts.get(key);
  if (found && !found.waiting.size && !found.runs.size && found.ended === undefined) scripts.delete(key);
}

/**
 * Call `id` of a script waits on a person. Once every call the script has out waits on a person or a sub-agent, and it
 * has nothing left to compute, its VM stops and gives back its sandbox slot; the next result starts another VM, which
 * replays to where the script was. Such a wait is not on the script's clock. Returns the release.
 */
export function waitsOnPerson(startedAt: number, seed: number, id: number): () => void {
  const key = keyOf(startedAt, seed), found = script(key);
  // Counted: one call may wait on several inputs at once (an MCP server's batch).
  found.waiting.set(id, (found.waiting.get(id) ?? 0) + 1);
  for (const run of found.runs) run.changed();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (found.waiting.get(id) ?? 1) - 1;
    if (left > 0) found.waiting.set(id, left);
    else found.waiting.delete(id);
    for (const run of found.runs) run.changed();
    forget(key);
  };
}

/**
 * An input the script waited on was closed without an answer (aborted, expired, or a new message came instead): the
 * script ends here with `message`, and the call that asked is not made. A run of it started again before the mark
 * expires ends the same way.
 */
export function endScript(startedAt: number, seed: number, message: string) {
  const key = keyOf(startedAt, seed), found = script(key);
  found.ended ??= message;
  clearTimeout(found.expires);
  found.expires = setTimeout(() => { found.ended = undefined; forget(key); }, 10 * 60_000);
  // Under Node (tests, the local fixture) a ten-minute mark must not keep the process alive after its work is done.
  (found.expires as { unref?: () => void }).unref?.();
  for (const run of found.runs) run.end(message);
}

type Delivery = { seq: number; at: number; id: number; outcome: CodemodeOutcome };
type Inner = { run?: CodemodeRun; controller: AbortController; issued: Set<number>; next: number; parking?: boolean; timedOut?: string; external?: boolean };

/**
 * One durable script run (Pi's `start()`), over as many VMs as it needs: a VM stops while the script waits only on
 * people, and the next one replays every result delivered so far, in order, before it goes on. The VM is deterministic
 * (same start, seed and results), so the replay makes the same calls again, which Pi already has and never sees twice.
 *
 * The runtime's deadline (`timeoutMs`, at most `maxTimeoutMs`) counts the script's own time: computing, and waiting on
 * calls other than people and sub-agents. A script's own `timeout_ms` (Pi's deadline, from its start) counts every wait.
 */
class ScriptRun implements CodemodeRun {
  readonly result: Promise<CodemodeResult>;
  private resolve!: (result: CodemodeResult) => void;
  finished = false;
  private inner?: Inner;
  /** The last stopped VM's result: its output and calls stand for the script's if it ends while no VM runs. */
  private last?: CodemodeResult;
  private readonly deliveries: Delivery[] = [];
  /** Calls the script has made, which Pi has seen, by id: what each was, so a replay is checked against them. */
  private readonly made = new Map<number, string>();
  private issuedMax = 0;
  /** Calls waiting for their result, by id: their names. */
  private readonly outstanding = new Map<number, string>();
  /** Calls the script made after one began to wait on a person, not passed on yet (release). */
  private held: CodemodeHostCall[] = [];
  /** The last result the script processed, as reported to Pi (-1: not even its first run yet). */
  private idle = -1;
  private fingerprint?: string;
  private spent = 0;
  private since?: number;
  private clock?: ReturnType<typeof setTimeout>;
  private wall?: ReturnType<typeof setTimeout>;
  private readonly entry: Script;
  private readonly onAbort = () => this.abort();
  private readonly launch: (options: CodemodeRunOptions) => CodemodeRun;
  private readonly options: CodemodeRunOptions;
  private readonly limitMs: number;

  constructor(launch: (options: CodemodeRunOptions) => CodemodeRun, options: CodemodeRunOptions, limitMs: number) {
    this.launch = launch;
    this.options = options;
    this.limitMs = limitMs;
    this.result = new Promise(resolve => { this.resolve = resolve; });
    this.entry = script(keyOf(options.startedAt, options.seed));
    this.entry.runs.add(this);
    try { this.start(); }
    catch (error) { this.entry.runs.delete(this); forget(keyOf(options.startedAt, options.seed)); throw error; }
    // Pi's own deadline: absolute, so every wait counts.
    if (options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs))
      this.wall = setTimeout(() => this.timeout(`Execution timed out after ${options.timeoutMs} ms`), options.timeoutMs);
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.abort();
    if (this.entry.ended !== undefined) this.end(this.entry.ended);
    this.tick();
  }

  deliver(seq: number, now: number, id: number, outcome: CodemodeOutcome) {
    if (this.finished) return;
    this.deliveries.push({ seq, at: now, id, outcome });
    this.outstanding.delete(id);
    if (this.inner) this.pump();
    else this.start();
    this.tick();
  }

  /** A call began or stopped waiting on a person. */
  changed() {
    if (this.finished) return;
    this.release();
    this.tick();
    this.park();
  }

  end(message: string) {
    if (this.finished) return;
    this.settle({ ok: false, error: { kind: "script", name: "Error", message }, output: this.last?.output ?? [], calls: this.last?.calls ?? [] });
    this.inner?.controller.abort(new Error(message));
  }

  private start() {
    const inner: Inner = { controller: new AbortController(), issued: new Set(), next: 0 };
    this.inner = inner;
    // A new VM makes its held calls again as it replays.
    this.held = [];
    const run = this.launch({
      startedAt: this.options.startedAt, seed: this.options.seed, tools: this.options.tools, globals: this.options.globals,
      store: this.options.store, signal: inner.controller.signal,
      onStarted: fingerprint => {
        if (this.inner !== inner) return;
        if (this.fingerprint === undefined) { this.fingerprint = fingerprint; this.options.onStarted?.(fingerprint); }
        else if (fingerprint !== this.fingerprint) this.fail(`The script cannot resume: the sandbox changed since it started (${this.fingerprint} -> ${fingerprint}).`);
      },
      onCall: call => this.onCall(inner, call),
      onIdle: (seq, issued) => {
        if (this.inner !== inner) return;
        if (seq > this.idle) { this.idle = seq; this.options.onIdle?.(seq, issued); }
        this.tick();
        this.park();
      },
    });
    inner.run = run;
    void run.result.then(result => {
      if (this.inner === inner) this.inner = undefined;
      // Stopped while the script waits on people: the next result starts another VM.
      if (inner.parking && !inner.timedOut && !inner.external) { this.last = result; return; }
      this.settle(inner.timedOut ? { ...result, ok: false, error: { kind: "timeout", message: inner.timedOut } } as CodemodeResult : result);
    });
    this.pump();
  }

  private onCall(inner: Inner, call: CodemodeHostCall) {
    if (this.inner !== inner || this.finished) return;
    inner.issued.add(call.id);
    const made = JSON.stringify([call.target, call.name, call.args ?? null]);
    if (call.id <= this.issuedMax) {
      // Replayed: Pi has this call already, answered or still out.
      if (this.made.get(call.id) !== made) this.fail(`The script took a different path when its VM started again: call ${call.id} is ${call.name}`);
      else this.pump();
      return;
    }
    // Once a call waits on a person, the script's later calls wait for the answer, as on ECS: an input closed without
    // one ends the script (end), and they are never made. A VM stopped meanwhile makes them again as it replays.
    if (this.entry.waiting.size || this.held.length) { this.held.push(call); return; }
    this.forward(call);
  }

  private forward(call: CodemodeHostCall) {
    this.issuedMax = call.id;
    this.made.set(call.id, JSON.stringify([call.target, call.name, call.args ?? null]));
    this.outstanding.set(call.id, call.name);
    this.options.onCall(call);
    this.tick();
  }

  /** No call waits on a person any more: the calls held meanwhile go on, in the order the script made them. */
  private release() {
    if (this.entry.waiting.size || this.finished) return;
    for (const call of this.held.splice(0)) this.forward(call);
  }

  /** Hand the running VM the results it has made the calls for, in order. */
  private pump() {
    const inner = this.inner;
    if (!inner?.run) return;
    while (inner.next < this.deliveries.length && !this.finished && this.inner === inner) {
      const delivery = this.deliveries[inner.next]!;
      if (!inner.issued.has(delivery.id)) return;
      inner.next++;
      inner.run.deliver(delivery.seq, delivery.at, delivery.id, delivery.outcome);
    }
  }

  /** Every result is processed, and every call out waits on a person or a sub-agent, one at least on a person. */
  private get parkable() {
    if (this.idle < this.deliveries.length || !this.outstanding.size) return false;
    let person = false;
    for (const [id, name] of this.outstanding) {
      if (this.entry.waiting.has(id)) person = true;
      else if (!OFF_THE_CLOCK.has(name)) return false;
    }
    return person;
  }

  private park() {
    const inner = this.inner;
    if (this.finished || !inner || inner.parking || !this.parkable) return;
    inner.parking = true;
    inner.controller.abort(new Error("The script waits on a person"));
  }

  /** The runtime's deadline runs while the script computes, or waits on a call other than a person or a sub-agent. */
  private tick() {
    const now = Date.now();
    if (this.since !== undefined) { this.spent += now - this.since; this.since = undefined; }
    clearTimeout(this.clock);
    if (this.finished) return;
    let running = this.idle < this.deliveries.length;
    for (const [id, name] of this.outstanding) if (!this.entry.waiting.has(id) && !OFF_THE_CLOCK.has(name)) running = true;
    if (!running) return;
    this.since = now;
    this.clock = setTimeout(() => this.timeout(`Execution timed out after ${this.limitMs} ms`), Math.max(0, this.limitMs - this.spent));
  }

  private timeout(message: string) {
    if (this.finished) return;
    const inner = this.inner;
    if (inner) { inner.timedOut = message; inner.controller.abort(new Error(message)); return; }
    this.settle({ ok: false, error: { kind: "timeout", message }, output: this.last?.output ?? [], calls: this.last?.calls ?? [] });
  }

  private abort() {
    if (this.finished) return;
    const reason = this.options.signal?.reason;
    const inner = this.inner;
    if (inner) { inner.external = true; inner.controller.abort(reason); return; }
    this.settle({ ok: false, error: { kind: "aborted", message: reason instanceof Error ? reason.message : "Execution aborted" }, output: this.last?.output ?? [], calls: this.last?.calls ?? [] });
  }

  private fail(message: string) {
    if (this.finished) return;
    this.settle({ ok: false, error: { kind: "sandbox", message }, output: this.last?.output ?? [], calls: this.last?.calls ?? [] });
    this.inner?.controller.abort(new Error(message));
  }

  private settle(result: CodemodeResult) {
    if (this.finished) return;
    this.finished = true;
    this.since = undefined;
    clearTimeout(this.clock);
    clearTimeout(this.wall);
    this.options.signal?.removeEventListener("abort", this.onAbort);
    this.entry.runs.delete(this);
    forget(keyOf(this.options.startedAt, this.options.seed));
    this.resolve(result);
  }
}

/** The shared fs compatibility shim is the only code prepended to stock Pi. */
export class SessionCodemodeSandbox extends RemoteCodemodeSandbox {
  /** A script's runtime deadline unless it asks for less (`timeoutMs` in the options: tests only). */
  private readonly defaultTimeoutMs: number;
  constructor(options: RemoteCodemodeSandboxOptions) {
    super(options);
    this.defaultTimeoutMs = Math.min(options.timeoutMs ?? SANDBOX_LIMITS.timeoutMs, SANDBOX_LIMITS.maxTimeoutMs);
  }
  override execute(code: string, options?: CodemodeExecuteOptions) {
    return super.execute(FS_SHIM + code, { ...options, timeoutMs: Math.min(options?.timeoutMs ?? this.defaultTimeoutMs, SANDBOX_LIMITS.maxTimeoutMs) });
  }
  override start(code: string, options: CodemodeRunOptions): CodemodeRun {
    const limit = Math.min(options.timeoutMs ?? this.defaultTimeoutMs, SANDBOX_LIMITS.maxTimeoutMs);
    return new ScriptRun(run => super.start(FS_SHIM + code, run), options, limit);
  }
}
