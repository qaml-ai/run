import { createHash } from "node:crypto";
import { CodemodeSandboxBase, type CodemodeSandboxBaseOptions, type HostToWorkerMessage } from "@earendil-works/pi-codemode/portable";
import type { Guest } from "./v8-exec.ts";
import { SANDBOX_LIMITS } from "./limits.ts";
import { MAX_FRAME_BYTES } from "./sandbox-wire.ts";
import { V8Exec, v8Exec } from "./v8-exec.ts";

// Resolve beside an exported entry: Pi does not export its prelude subpath.
const { PRELUDE_SOURCE } = await import(new URL("./runtime/prelude-source.js", import.meta.resolve("@earendil-works/pi-codemode/portable")).href) as { PRELUDE_SOURCE: string };
const preludeSha256 = createHash("sha256").update(PRELUDE_SOURCE).digest("hex");

type Launcher = ConstructorParameters<typeof CodemodeSandboxBase>[1];
export interface PiV8Options {
  pool?: V8Exec;
  cpuMs?: number;
  /**
   * Wall limit on the script's own time: not time queued for a code slot, nor time waiting on `awaits` calls. Pi's
   * start() otherwise has no deadline.
   */
  timeoutMs?: number;
  /**
   * Tools a script waits on for as long as they take (delegate: another agent's whole turn): while it waits on these
   * alone, the script holds no code slot, its process is outside the pool's `max` (within its budget for waiting
   * processes) and its clock stops; it takes a slot and a process back before it gets their answers.
   */
  awaits?: readonly string[];
  /** Whose script this is: its share of the pool's processes for waiting scripts (`V8Exec.parkedPerTenant`). */
  tenant?: string;
  expectedFingerprint?: string;
  /** Tenant CodeGate admission. Released on process exit, also on failed or cancelled admission, and while the script waits on `awaits` calls. */
  acquireSlot?(signal: AbortSignal): Promise<() => void>;
  /** Once per execution, when it stops: how long it ran from launch, the CPU its script used (when it got to the end), and why it failed (the script's error, with its name, a limit, the sandbox), if it did. */
  onEnd?(end: { ms: number; cpuMs?: number; error?: string; errorName?: string }): void;
}

const record = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
/** Text one script prints: v8-exec's EMIT_CHARS, in bytes. */
const OUTPUT_TEXT_BYTES = 128_000;
/**
 * A result whose JSON holds a lone surrogate (half an emoji, as `"\ud83d"`), its strings made well formed (U+FFFD): v8-exec's
 * JSON parser refuses one, as the JSON standard does.
 */
function wellFormed(message: HostToWorkerMessage): HostToWorkerMessage {
  const fix = (text: string | undefined) => {
    if (text === undefined || !/\\u[dD][89a-fA-F]/.test(text)) return text;
    try { return JSON.stringify(JSON.parse(text), (_key, value) => typeof value === "string" ? value.toWellFormed() : value); }
    catch { return text; }
  };
  if (message.type !== "result") return message;
  return { ...message, ...(message.payload !== undefined ? { payload: fix(message.payload) } : {}), ...(message.properties !== undefined ? { properties: fix(message.properties) } : {}) };
}
const json = (value: string) => { try { JSON.parse(value); return true; } catch { return false; } };

/** Pi's code mode on v8-exec: Pi owns calls and replay; this launcher only owns transport and capacity. */
export function createPiV8Launcher(options: PiV8Options = {}): Launcher {
  const pool = options.pool ?? v8Exec();
  const cpuMs = options.cpuMs ?? 2_000, timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isInteger(cpuMs) || cpuMs < 1 || cpuMs > 30_000 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid Pi V8 limits");
  return (data, events) => {
    if (Buffer.byteLength(data.code) > 256 * 1024) throw new Error("Pi code exceeds 256 KiB");
    const toolNames = new Set(data.tools.map(tool => tool.name));
    const globalNames = new Set(data.globals.map(global => global.name));
    const aliases = new Map<string, string>();
    for (const tool of data.tools) {
      if (!/^[A-Za-z_$][\w$]*$/.test(tool.jsName)) throw new Error("Invalid Pi tool jsName");
      for (const alias of [tool.name, tool.jsName]) {
        if (aliases.has(alias) && aliases.get(alias) !== tool.name) throw new Error("Conflicting Pi tool aliases");
        aliases.set(alias, tool.name);
      }
    }
    // Pi checks helper names; also refuse shadowing deterministic intrinsics and V8 globals.
    const reserved = new Set(["Object", "Function", "Array", "Number", "String", "Boolean", "BigInt", "Symbol", "Math", "Date", "Intl", "JSON", "Reflect", "Proxy", "Promise", "RegExp", "Error", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "performance", "eval", "undefined", "NaN", "Infinity", "WebAssembly", "SharedArrayBuffer", "Atomics"]);
    if (data.globals.some(global => reserved.has(global.name.split(".")[0]))) throw new Error("Pi global shadows a built-in");
    // V8 uses its fixed HEAP_BYTES cap; Pi's per-request memoryLimitBytes is not applied.
    let guest: Guest | undefined, stopped = false, started = false, issued = 0, idle = -1, error: string | undefined, errorName: string | undefined, usedCpuMs: number | undefined;
    const output = { items: 0, bytes: 0, images: 0, imageBytes: 0 };
    const launched = performance.now();
    const pending = new Set<number>(), sequences = new Set<number>();
    const awaits = new Set(options.awaits ?? []), awaited = new Set<number>();
    // Parked: the script, idle, waits only on `awaits` calls, holding no code slot, its process outside the pool's `max`
    // (`Guest.park`) and its clock stopped. Results wait in `queued` while it is parked or `moving` in or out of it.
    // Past that budget it keeps its process (`kept`) and its clock runs.
    let parked: { kept: boolean } | undefined, moving: Promise<void> | undefined;
    const queued: HostToWorkerMessage[] = [];
    let nextResult = 0;
    const admission = new AbortController();
    let release: (() => void) | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const released = () => { release?.(); release = undefined; resolveClosed(); };
    const fail = (message: string) => { if (!stopped) { error ??= message; events.failure({ kind: "sandbox", message }); } };
    // The wall clock runs while the script has its process and code slot, and is not parked.
    let left = timeoutMs, since: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      if (stopped) return;
      const why = parked?.kept ? " waiting on delegate: this node had no room to set a waiting script aside" : "";
      error ??= `Codemode timed out after ${timeoutMs}ms${why}`;
      events.failure({ kind: "timeout", message: `Pi V8 exceeded ${timeoutMs} ms${why}` });
    };
    const runClock = () => { if (!stopped && since === undefined) { since = performance.now(); timer = setTimeout(expire, left); } };
    const stopClock = () => { if (since !== undefined) { clearTimeout(timer); left -= performance.now() - since; since = undefined; } };
    const deliver = (message: HostToWorkerMessage) => guest!.send({ type: "request", id: "pi", method: "pi-result-v1", params: message });
    const post = (message: HostToWorkerMessage) => {
      if (stopped) return;
      message = wellFormed(message);
      if (!data.deterministic) message = { ...message, seq: ++nextResult, now: Date.now() };
      if (!integer(message.id) || !pending.has(message.id) || message.type !== "result" || typeof message.ok !== "boolean"
        || !optionalString(message.payload) || (message.ok && message.payload !== undefined && !json(message.payload))
        || !optionalString(message.properties) || (message.properties !== undefined && (!json(message.properties) || !record(JSON.parse(message.properties))))
        // v8-exec takes each at most SANDBOX_LIMITS.resultBytes (pi.rs); the host keeps a script's results under it (`scriptBytes`).
        || Buffer.byteLength(message.payload ?? "") > SANDBOX_LIMITS.resultBytes || Buffer.byteLength(message.properties ?? "") > SANDBOX_LIMITS.resultBytes) return fail("Malformed Pi result");
      if (data.deterministic && (!integer(message.seq) || message.seq === 0 || sequences.has(message.seq) || !Number.isFinite(message.now))) return fail("Malformed Pi result sequence or clock");
      pending.delete(message.id);
      awaited.delete(message.id);
      if (message.seq !== undefined) sequences.add(message.seq);
      queued.push(message);
      flush();
    };
    // Results go to the script while it runs; a parked one takes its slot and a process back first.
    const flush = () => {
      if (stopped || moving || !guest?.dispatched) return;
      if (parked) { if (queued.length) unpark(); return; }
      for (const message of queued.splice(0)) deliver(message);
    };
    const moved = (work: () => Promise<void>) => {
      moving = work().catch(error => fail(error instanceof Error ? error.message : String(error))).finally(() => { moving = undefined; flush(); });
    };
    // Either way the code slot goes back (the script's children may need it). Parked, its process leaves the pool's
    // `max` and its clock stops. Refused (the budget for waiting processes full, or its process too large to keep
    // waiting), it keeps its process and its clock runs: the wait counts, so it ends on its own deadline, saying why.
    const park = () => moved(async () => {
      if (queued.length) return;
      parked = { kept: !guest!.park?.(options.tenant) };
      if (!parked.kept) stopClock();
      release?.(); release = undefined;
    });
    const unpark = () => moved(async () => {
      const kept = parked!.kept;
      parked = undefined;
      release = await options.acquireSlot?.(admission.signal);
      if (!kept) await guest!.unpark?.();
      if (stopped) { release?.(); release = undefined; return; }
      runClock();
    });
    const receive = (message: unknown) => {
      if (stopped) return;
      if (!record(message) || Buffer.byteLength(JSON.stringify(message)) > MAX_FRAME_BYTES) return fail("Malformed Pi V8 frame");
      if (message.type === "response" && typeof message.error === "string") return fail(message.error);
      if (message.type === "started") {
        if (started || typeof message.fingerprint !== "string") return fail("Malformed Pi fingerprint");
        if (options.expectedFingerprint !== undefined && message.fingerprint !== options.expectedFingerprint) return fail("Pi V8 fingerprint mismatch");
        started = true;
        events.message(message);
        if (!stopped) guest!.send({ type: "request", id: "pi", method: "pi-run-v1", params: undefined });
        return;
      }
      if (!started) return fail("Pi V8 message before fingerprint");
      if (message.type === "call") {
        if (message.id !== issued + 1 || issued >= 256 || pending.size >= 32 || typeof message.name !== "string" || !optionalString(message.args)
          || (message.args !== undefined && (Buffer.byteLength(message.args) > 128 * 1024 || !json(message.args)))
          || !(message.target === "tool" ? toolNames.has(message.name) : message.target === "global" && globalNames.has(message.name))) return fail("Malformed Pi call");
        issued++;
        pending.add(message.id);
        if (message.target === "tool" && awaits.has(message.name)) awaited.add(message.id);
      } else if (message.type === "idle" || message.type === "done") {
        const barrier = message.type === "idle" ? message : message.during;
        if (barrier !== undefined && (!record(barrier) || !integer(barrier.seq) || barrier.seq !== idle + 1
          || barrier.issued !== issued || (barrier.seq > 0 && !sequences.has(barrier.seq)))) return fail("Malformed Pi barrier");
        if (data.deterministic && barrier === undefined) return fail("Missing Pi barrier");
        if (message.type === "idle") {
          if (message.seq !== idle + 1) return fail("Out-of-order Pi idle");
          idle = message.seq;
          // Waiting, and only on `awaits` calls: the script parks until one answers.
          if (pending.size && awaited.size === pending.size && !parked && !moving && !queued.length) park();
        } else if (typeof message.ok !== "boolean" || (message.ok
          ? !optionalString(message.value) || (message.value !== undefined && !json(message.value)) || typeof message.writes !== "string" || !json(message.writes)
          : typeof message.error !== "string" || !json(message.error))) return fail("Malformed Pi completion");
        if (message.type === "done") {
          if (integer(message.cpuMs)) usedCpuMs = message.cpuMs;
          delete message.cpuMs;
          if (!message.ok && error === undefined) {
            const thrown = JSON.parse(message.error);
            error = String(thrown?.message ?? "Script error");
            if (typeof thrown?.name === "string") errorName = thrown.name;
          }
        }
      } else if (message.type === "output") {
        const item = message.item;
        if (!record(item) || !(item.type === "text" ? typeof item.text === "string" && (item.console === undefined || item.console === true)
          : item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")) return fail("Malformed Pi output");
        // v8-exec leaves out what is past its limits and notes it once (sandbox/v8-exec/src/pi.rs `bounded`).
        if (item.type === "text") { output.items++; output.bytes += Buffer.byteLength(item.text); }
        else { output.images++; output.imageBytes += item.data.length; }
        if (output.items > SANDBOX_LIMITS.outputEvents + 3 || output.bytes > OUTPUT_TEXT_BYTES + 1024
          || output.images > SANDBOX_LIMITS.outputImages || output.imageBytes > SANDBOX_LIMITS.outputImageBytes) return fail("Pi output exceeds limit");
      } else if (message.type !== "crash" || typeof message.message !== "string") return fail("Unknown Pi V8 frame");
      events.message(message);
    };
    void (async () => {
      try {
        release = await options.acquireSlot?.(admission.signal);
        if (stopped) return released();
        guest = pool.open();
        guest.listen(receive, reason => { released(); fail(reason); });
        guest.send({ type: "request", id: "pi", method: "pi-start-v1", params: { ...data, prelude: PRELUDE_SOURCE, preludeSha256, cpuMs, wallMs: timeoutMs } });
        // The clock starts once the script has its process, not while it waits its turn for one.
        await guest.admitted;
        if (stopped) return;
        runClock();
        flush();
      } catch (error) { released(); fail(error instanceof Error ? error.message : String(error)); }
    })();
    return { post, async stop() {
      if (!stopped) {
        stopped = true;
        stopClock();
        options.onEnd?.({ ms: Math.round(performance.now() - launched), ...usedCpuMs === undefined ? {} : { cpuMs: usedCpuMs }, ...error === undefined ? {} : { error }, ...errorName === undefined ? {} : { errorName } });
        admission.abort();
        if (guest) { guest.end(); if (!guest.dispatched) released(); } else released();
      }
      await closed;
    } };
  };
}

/** Where an agent's code runs: v8-exec in production; a test or the simulation may give Pi's in-process sandbox. */
export type CodeSandboxes = (options: CodemodeSandboxBaseOptions & PiV8Options) => CodemodeSandboxBase;

export class PiV8Sandbox extends CodemodeSandboxBase {
  constructor(options: CodemodeSandboxBaseOptions & PiV8Options = {}) {
    super(options, createPiV8Launcher(options));
  }
}
