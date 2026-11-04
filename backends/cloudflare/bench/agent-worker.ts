/** Opt-in cloud benchmark. The production entrypoint and classes stay unchanged. */
import { DurableObject } from "cloudflare:workers";
import worker from "../src/index.ts";
import { CamelAgent, json, type Env } from "../src/agent.ts";
import { AgentDirectory } from "../src/directory.ts";
import { authorized } from "../src/validation.ts";

interface BenchEnv extends Env {
  DIRECTORY: DurableObjectNamespace<AgentDirectory>;
  BENCH_AGENTS: DurableObjectNamespace<CamelAgent>;
  BENCH_DIRECTORY: DurableObjectNamespace<AgentDirectory>;
  BENCH_BUDGET: DurableObjectNamespace<ModelBudget>;
  BENCH_ENABLED?: string;
  BENCH_BUILD?: string;
  BENCH_MAX_MODEL_CALLS?: string;
}

/** Reservation precedes dispatch and survives deploy/replay. There is no reset API. */
class ModelBudget extends DurableObject<BenchEnv> {
  async reserve(model: string) {
    const configured = Number(this.env.BENCH_MAX_MODEL_CALLS ?? 24);
    const limit = Number.isInteger(configured) ? Math.max(1, Math.min(24, configured)) : 24;
    return this.ctx.storage.transaction(async tx => {
      const calls = await tx.get<{ model: string; at: number }[]>("calls") ?? [];
      if (calls.length >= limit) return { allowed: false, reserved: calls.length, limit };
      calls.push({ model: model.slice(0, 200), at: Date.now() });
      await tx.put("calls", calls);
      return { allowed: true, reserved: calls.length, limit };
    });
  }
  async snapshot() {
    const calls = await this.ctx.storage.get<{ model: string; at: number }[]>("calls") ?? [];
    return { reservedDispatches: calls.length, hardMaximum: 24, calls };
  }
}

function limitedAI(env: BenchEnv): Ai {
  return new Proxy(env.AI, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "run") return async (...args: unknown[]) => {
        const reservation = await env.BENCH_BUDGET.getByName("workers-ai-dispatches").reserve(String(args[0]));
        if (!reservation.allowed) throw new Error("Benchmark Workers AI dispatch budget exhausted");
        const input = args[1] as Record<string, unknown>;
        const requested = Number(input.max_tokens);
        const maxTokens = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 256) : 256;
        return Reflect.apply(value, target, [args[0], { ...input, max_tokens: maxTokens }, ...args.slice(2)]);
      };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

class InstrumentedAgent extends CamelAgent {
  private readonly benchInstance = crypto.randomUUID();
  private readonly benchConstructedAt = Date.now();
  private readonly benchSamples: { method: string; path: string; wallMs: number; status: number }[] = [];
  private benchRequests = 0;
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/_bench/diagnostics") {
      return json({
        instanceId: this.benchInstance, constructedAt: this.benchConstructedAt,
        build: (this.env as BenchEnv).BENCH_BUILD ?? "unspecified",
        mode: this.env.TEST_MODEL === "1" ? "deterministic" : "workers-ai",
        requestsInThisInstance: this.benchRequests, samples: this.benchSamples,
        storageBytes: this.ctx.storage.sql.databaseSize,
        heap: { available: false, reason: "No per-object heap API; use an authenticated inspector sample if available." },
        cpu: { available: false, reason: "Fetch wallMs is elapsed time, not CPU. Use Workers invocation CPU metrics." },
      });
    }
    const start = performance.now();
    const response = await super.fetch(request);
    this.benchRequests++;
    this.benchSamples.push({ method: request.method, path: path.split("/").slice(0, 2).join("/"), wallMs: performance.now() - start, status: response.status });
    if (this.benchSamples.length > 32) this.benchSamples.shift();
    return response;
  }
}

class RealAgent extends InstrumentedAgent {
  constructor(ctx: DurableObjectState, env: BenchEnv) {
    super(ctx, { ...env, TEST_MODEL: undefined, AI: limitedAI(env) });
  }
}
class DeterministicAgent extends InstrumentedAgent {
  constructor(ctx: DurableObjectState, env: BenchEnv) {
    super(ctx, { ...env, MODEL: "test/echo", TEST_MODEL: "1" });
  }
}
class RealDirectory extends AgentDirectory {}
class DeterministicDirectory extends AgentDirectory {
  constructor(ctx: DurableObjectState, env: BenchEnv) {
    super(ctx, { ...env, MODEL: "test/echo", AGENTS: env.BENCH_AGENTS });
  }
}

// ECMAScript string-named exports preserve the required resource prefix.
export {
  RealAgent as "camelrun-proto-agent",
  RealDirectory as "camelrun-proto-directory",
  DeterministicAgent as "camelrun-proto-deterministic-agent",
  DeterministicDirectory as "camelrun-proto-deterministic-directory",
  ModelBudget as "camelrun-proto-budget",
};

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    // Even unknown paths and health checks require the operator token.
    if (!await authorized(request, env.API_TOKEN)) return json({ error: "Unauthorized" }, 401);
    if (env.BENCH_ENABLED !== "1") return json({ error: "Benchmark disabled" }, 404);
    const url = new URL(request.url);
    if (url.pathname === "/bench/meta" && request.method === "GET") {
      return json({ build: env.BENCH_BUILD ?? "unspecified", model: env.MODEL,
        budget: await env.BENCH_BUDGET.getByName("workers-ai-dispatches").snapshot(),
        realPrefix: "", deterministicPrefix: "/bench/deterministic" });
    }
    const diagnostics = /^\/bench\/(real|deterministic)\/agents\/([A-Za-z0-9_-]{1,80})\/diagnostics$/.exec(url.pathname);
    if (diagnostics && request.method === "GET") {
      const namespace = diagnostics[1] === "real" ? env.AGENTS : env.BENCH_AGENTS;
      return namespace.getByName(diagnostics[2]).fetch("https://agent/_bench/diagnostics");
    }
    if (url.pathname.startsWith("/bench/deterministic/")) {
      url.pathname = url.pathname.slice("/bench/deterministic".length);
      return worker.fetch(new Request(url, request), {
        ...env, TEST_MODEL: "1", MODEL: "test/echo", AGENTS: env.BENCH_AGENTS, DIRECTORY: env.BENCH_DIRECTORY,
      });
    }
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<BenchEnv>;
