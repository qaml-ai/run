import { createHash } from "node:crypto";
import { CodemodeSandboxBase, type CodemodeSandboxBaseOptions, type HostToWorkerMessage } from "@earendil-works/pi-codemode/portable";
import type { Guest } from "./codemode.ts";
import { MAX_FRAME_BYTES } from "./sandbox-wire.ts";
import { V8Exec, v8Exec } from "./v8-exec.ts";

// Resolve beside an exported entry: Pi does not export its prelude subpath.
const { PRELUDE_SOURCE } = await import(new URL("./runtime/prelude-source.js", import.meta.resolve("@earendil-works/pi-codemode/portable")).href) as { PRELUDE_SOURCE: string };
const preludeSha256 = createHash("sha256").update(PRELUDE_SOURCE).digest("hex");

type Launcher = ConstructorParameters<typeof CodemodeSandboxBase>[1];
export interface PiV8Options {
  pool?: V8Exec;
  cpuMs?: number;
  /** Hard wall limit, including time queued for capacity. Pi's start() otherwise has no deadline. */
  timeoutMs?: number;
  expectedFingerprint?: string;
  /** Tenant CodeGate admission. Released on process exit, also on failed or cancelled admission. */
  acquireSlot?(signal: AbortSignal): Promise<() => void>;
}

const record = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const json = (value: string) => { try { JSON.parse(value); return true; } catch { return false; } };

/** Unused by production. Pi owns calls and replay; this launcher only owns transport and capacity. */
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
    let guest: Guest | undefined, stopped = false, started = false, issued = 0, idle = -1, output = 0, items = 0;
    const pending = new Set<number>(), sequences = new Set<number>();
    const queued: HostToWorkerMessage[] = [];
    let nextResult = 0;
    const admission = new AbortController();
    let release: (() => void) | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const released = () => { release?.(); release = undefined; resolveClosed(); };
    const fail = (message: string) => { if (!stopped) events.failure({ kind: "sandbox", message }); };
    const timer = setTimeout(() => { if (!stopped) events.failure({ kind: "timeout", message: `Pi V8 exceeded ${timeoutMs} ms` }); }, timeoutMs);
    const post = (message: HostToWorkerMessage) => {
      if (stopped) return;
      if (!data.deterministic) message = { ...message, seq: ++nextResult, now: Date.now() };
      if (!integer(message.id) || !pending.has(message.id) || message.type !== "result" || typeof message.ok !== "boolean"
        || !optionalString(message.payload) || (message.payload !== undefined && Buffer.byteLength(message.payload) > 1024 * 1024)
        || (message.ok && message.payload !== undefined && !json(message.payload))
        || !optionalString(message.properties) || (message.properties !== undefined && (Buffer.byteLength(message.properties) > 1024 * 1024 || !json(message.properties) || !record(JSON.parse(message.properties))))) return fail("Malformed Pi result");
      if (data.deterministic && (!integer(message.seq) || message.seq === 0 || sequences.has(message.seq) || !Number.isFinite(message.now))) return fail("Malformed Pi result sequence or clock");
      pending.delete(message.id);
      if (message.seq !== undefined) sequences.add(message.seq);
      if (guest) guest.send({ type: "request", id: "pi", method: "pi-result-v1", params: message });
      else queued.push(message);
    };
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
      } else if (message.type === "idle" || message.type === "done") {
        const barrier = message.type === "idle" ? message : message.during;
        if (barrier !== undefined && (!record(barrier) || !integer(barrier.seq) || barrier.seq !== idle + 1
          || barrier.issued !== issued || (barrier.seq > 0 && !sequences.has(barrier.seq)))) return fail("Malformed Pi barrier");
        if (data.deterministic && barrier === undefined) return fail("Missing Pi barrier");
        if (message.type === "idle") {
          if (message.seq !== idle + 1) return fail("Out-of-order Pi idle");
          idle = message.seq;
        } else if (typeof message.ok !== "boolean" || (message.ok
          ? !optionalString(message.value) || (message.value !== undefined && !json(message.value)) || typeof message.writes !== "string" || !json(message.writes)
          : typeof message.error !== "string" || !json(message.error))) return fail("Malformed Pi completion");
      } else if (message.type === "output") {
        const item = message.item;
        if (!record(item) || !(item.type === "text" ? typeof item.text === "string" && (item.console === undefined || item.console === true)
          : item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")) return fail("Malformed Pi output");
        output += Buffer.byteLength(item.type === "text" ? item.text : item.data);
        if (++items > 1024 || output > 128_000) return fail("Pi output exceeds limit");
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
        for (const message of queued.splice(0)) guest.send({ type: "request", id: "pi", method: "pi-result-v1", params: message });
      } catch (error) { released(); fail(error instanceof Error ? error.message : String(error)); }
    })();
    return { post, async stop() {
      if (!stopped) {
        stopped = true;
        clearTimeout(timer);
        admission.abort();
        if (guest) { guest.end(); if (!guest.dispatched) released(); } else released();
      }
      await closed;
    } };
  };
}

export class PiV8Sandbox extends CodemodeSandboxBase {
  constructor(options: CodemodeSandboxBaseOptions & PiV8Options = {}) {
    super(options, createPiV8Launcher(options));
  }
}
