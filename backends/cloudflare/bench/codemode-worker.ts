import { DurableObject } from "cloudflare:workers";
import * as process from "node:process";
import { RemoteCodemodeSandbox, type CodemodeResult } from "@earendil-works/pi-codemode/portable";
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import { authorized, BadRequest, body, object } from "../src/validation.ts";

interface Env {
  API_TOKEN: string;
  CALLERS: DurableObjectNamespace<CodemodeCaller>;
  CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
}

const cases = {
  start: 'await tools.mark({ step: "start" }); return 1;',
  nested: 'await tools.mark({ step: "start" }); let value = 0; for (let i = 0; i < 20; i++) value = await tools.echo({ value: value + 1 }); return value;',
  nested50: 'await tools.mark({ step: "start" }); let value = 0; for (let i = 0; i < 50; i++) value = await tools.echo({ value: value + 1 }); return value;',
  loop: 'await tools.mark({ step: "start" }); while (true) {}',
  memory: 'await tools.mark({ step: "start" }); const a = []; while (true) a.push("x".repeat(1024 * 1024));',
  pending: 'await tools.mark({ step: "start" }); await new Promise(() => {});',
  throw: 'await tools.mark({ step: "start" }); throw new Error("benchmark script failure");',
  tool: 'await tools.mark({ step: "start" }); await tools.fail({});',
} as const;
type Case = keyof typeof cases;

const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" },
});

// The process API can be absent, stubbed, or shared by multiple DOs. Preserve raw
// observations, including zeroes, without presenting them as per-DO billing data.
function metric(fn: () => unknown): unknown {
  try { return { available: true, value: fn() }; }
  catch (error) { return { available: false, reason: error instanceof Error ? error.message : "unsupported" }; }
}

function metrics() {
  return {
    cpuUsage: metric(() => process.cpuUsage()),
    resourceUsage: metric(() => process.resourceUsage()),
    memoryUsage: metric(() => process.memoryUsage()),
    scope: "Compatibility API observations; not attributable per DO. Zero or constant values may be stubs. Use Cloudflare telemetry for billed CPU.",
  };
}

function publicResult(result: CodemodeResult) {
  return {
    ok: result.ok,
    ...(result.ok ? { value: result.value } : { error: {
      kind: result.error.kind, name: result.error.name, message: result.error.message.slice(0, 1000),
    } }),
    calls: result.calls,
  };
}

class CodemodeCaller extends DurableObject<Env> {
  private readonly instanceId = crypto.randomUUID();
  private readonly constructedAt = Date.now();
  private active = 0;
  private started = 0;
  private completed = 0;
  private marked = 0;

  private status() {
    return { instanceId: this.instanceId, constructedAt: this.constructedAt,
      now: Date.now(), active: this.active, started: this.started,
      marked: this.marked, completed: this.completed, metrics: metrics() };
  }

  async fetch(request: Request): Promise<Response> {
    if (!await authorized(request, this.env.API_TOKEN)) return json({ error: "Unauthorized" }, 401);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/status")) return json(this.status());
    if (request.method !== "POST" || !url.pathname.endsWith("/run")) return json({ error: "Not found" }, 404);
    let input: Record<string, unknown>;
    try { input = object(await body(request, 1024), ["case"]); }
    catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      throw error;
    }
    if (typeof input.case !== "string" || !Object.hasOwn(cases, input.case)) return json({ error: "Unknown benchmark case" }, 400);
    if (this.active >= 64) return json({ error: "Caller concurrency limit" }, 429);
    const name = input.case as Case;
    const before = this.status();
    this.active++;
    this.started++;
    const startedAt = Date.now();
    let firstToolAtMs: number | null = null;
    const callbacks: { name: string; atMs: number }[] = [];
    const callback = (name: string) => {
      const atMs = Date.now() - startedAt;
      firstToolAtMs ??= atMs;
      callbacks.push({ name, atMs });
    };
    // Stock limits: the remote owns the 32 MiB heap and 100,000 interrupt-poll
    // ceilings. The caller has a shorter wall deadline as a separate safeguard.
    const sandbox = new RemoteCodemodeSandbox({
      remote: () => this.env.CODEMODE_SANDBOX.getByName(this.ctx.id.toString()),
      timeoutMs: 15_000,
      tools: [
        { name: "mark", execute: () => { callback("mark"); this.marked++; return { ok: true }; } },
        { name: "echo", execute: value => { callback("echo"); return (value as { value: number }).value; } },
        { name: "fail", execute: () => { callback("fail"); throw new Error("benchmark tool failure"); } },
      ],
    });
    try {
      const result = await sandbox.execute(cases[name]);
      const wallMs = Date.now() - startedAt;
      return json({ case: name, startedAt, wallMs, firstToolAtMs, callbacks,
        result: publicResult(result), before, after: this.status() });
    } finally {
      await sandbox.close();
      this.active--;
      this.completed++;
    }
  }
}

// Cloudflare accepts string-named exports; local Wrangler needs the temporary
// identifier adaptation in codemode-local.mjs for its generated dev wrapper.
export { CodemodeCaller as "camelrun-proto-codemode-caller" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!await authorized(request, env.API_TOKEN)) return json({ error: "Unauthorized" }, 401);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ ok: true, benchmark: "codemode", version: 1 });
    const match = /^\/bench\/([A-Za-z0-9_-]{1,100})\/(status|run)$/.exec(url.pathname);
    if (!match) return json({ error: "Not found" }, 404);
    try { return await env.CALLERS.getByName(match[1]).fetch(request); }
    catch (error) {
      return json({ error: error instanceof BadRequest ? error.message : "Benchmark request failed" }, error instanceof BadRequest ? 400 : 500);
    }
  },
} satisfies ExportedHandler<Env>;
