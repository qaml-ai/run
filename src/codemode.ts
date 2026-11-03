import { errorText } from "./protocol.ts";
import { sandboxDir } from "./sandbox.ts";
import { parse } from "./inspect.ts";
import { PiV8Sandbox, type CodeSandboxes } from "./codemode-pi-launcher.ts";

/**
 * How many scripts tenants with a concurrency limit may run together on this node (`CodeGate`):
 * AGENT_CODE_WORKERS_MAX, or 16. An execution waiting on tools holds its v8-exec process, about 20 MB
 * resident; 16 at once is about 320 MB, or a sixth of a 2 GB task.
 */
export function codeCapacity(env: NodeJS.ProcessEnv) {
  return Number(env.AGENT_CODE_WORKERS_MAX) || DEFAULT_CODE_CAPACITY;
}
export const DEFAULT_CODE_CAPACITY = 16;

/** A tenant's code limits (client-sessions' `codeLimits`): CPU per script, the longest timeoutMs, and executions at once on a node. */
export type CodeLimits = { cpuMs: number; maxTimeoutMs: number; concurrent: number };

/**
 * Admits scripts on a node: at most `capacity` at once (`codeCapacity`), and
 * at most `limit` of them for any one tenant. Executions waiting are admitted a tenant at a time,
 * in turn, so a tenant that keeps every slot it may have busy cannot hold back another's. A tenant
 * without a limit (an admin tenant's, Infinity) is admitted at once and not counted: only the
 * v8-exec process limit (AGENT_V8_MAX) bounds it, so the runtime's own heavy users never queue
 * behind the capacity.
 */
export class CodeGate {
  readonly capacity: number;
  running = 0;
  private readonly counts = new Map<string, number>();
  /** Executions waiting, by tenant; the tenant first in the map is served next. */
  private readonly queues = new Map<string, { limit: number; admit: () => void }[]>();
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid codemode capacity");
    this.capacity = capacity;
  }

  /** Executions `tenant` has running. */
  count(tenant: string) { return this.counts.get(tenant) ?? 0; }

  /** Wait for a turn to run one of `tenant`'s executions, until `signal` aborts. Resolves with the function that gives it back. */
  acquire(tenant: string, limit: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (limit === Infinity) return Promise.resolve(() => {});
    if (!this.queues.has(tenant) && this.free(tenant, limit)) return Promise.resolve(this.take(tenant));
    const waiter = Promise.withResolvers<() => void>();
    const entry = { limit, admit: () => { signal.removeEventListener("abort", abort); waiter.resolve(this.take(tenant)); } };
    const abort = () => {
      const queue = this.queues.get(tenant) ?? [];
      queue.splice(queue.indexOf(entry), 1);
      if (!queue.length) this.queues.delete(tenant);
      waiter.reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    const queue = this.queues.get(tenant);
    if (queue) queue.push(entry); else this.queues.set(tenant, [entry]);
    return waiter.promise;
  }

  private free(tenant: string, limit: number) { return this.running < this.capacity && this.count(tenant) < limit; }

  private take(tenant: string) {
    this.running++;
    this.counts.set(tenant, this.count(tenant) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      const left = this.count(tenant) - 1;
      if (left) this.counts.set(tenant, left); else this.counts.delete(tenant);
      this.next();
    };
  }

  /** Admit waiting executions while there is room: the first tenant in turn that may run one more, which then goes last. */
  private next() {
    for (let admitted = true; admitted && this.running < this.capacity;) {
      admitted = false;
      for (const [tenant, queue] of this.queues) {
        if (!this.free(tenant, queue[0].limit)) continue;
        const entry = queue.shift()!;
        this.queues.delete(tenant);
        if (queue.length) this.queues.set(tenant, queue);
        entry.admit();
        admitted = true;
        break;
      }
    }
  }
}

/**
 * Where untrusted code and files run, for the startup log: code must answer `return 1`, and a parse
 * job must read an image's header, or the runtime does not start. Under agent-launcher they are
 * confined ("isolated"); without it, this process's own children ("in-process"), which
 * AGENT_SANDBOX_REQUIRED=1 (the image sets it) refuses.
 */
export async function checkSandbox(options: { sandboxes?: CodeSandboxes; required?: boolean } = {}): Promise<Record<string, unknown>> {
  const isolated = sandboxDir() !== undefined;
  const reason = "no agent-launcher: it confines code and file parsing when the image runs as root on Linux";
  if (!isolated && options.required) throw new Error(`AGENT_SANDBOX_REQUIRED=1, but ${reason}`);
  const started = performance.now();
  const ran = await (options.sandboxes ?? (limits => new PiV8Sandbox(limits)))({ timeoutMs: 60_000 }).execute("return 1").catch(error => ({ ok: false as const, error: { message: errorText(error) } }));
  if (!ran.ok || ran.value !== 1) throw new Error(`Code does not run: ${ran.ok ? `it returned ${JSON.stringify(ran.value)}` : ran.error.message}`);
  // A 1×1 PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const parsed = await parse(png, false).catch(error => errorText(error));
  if ((parsed as { media?: { width?: unknown } })?.media?.width !== 1) throw new Error(`Files cannot be parsed: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  return { mode: isolated ? "isolated" : "in-process", ...(isolated ? {} : { reason }), ms: Math.round(performance.now() - started) };
}
