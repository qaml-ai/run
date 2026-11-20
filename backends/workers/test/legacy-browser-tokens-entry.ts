import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../src/agent-types.ts";
import worker, { LegacyV1 } from "../src/index.ts";

export * from "../src/index.ts";

export class UnexpectedBrowserTokenRuntime extends WorkerEntrypoint {
  route() { throw new Error("Browser-token issuance must not call the native runtime"); }
}

export class WithoutPlacementAuthority extends LegacyV1 {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, { ...env, V2_LEGACY_RUNS: undefined, AGENT_V2_COMPAT_API_KEYS: undefined });
  }
}

export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/healthz") return worker.fetch(request, env, ctx);
    // Model the original absolute URL retained by the real ingress RPC. Only
    // this local fixture accepts this header; production uses request.url.
    const host = request.headers.get("x-forwarded-host");
    if (host) {
      const url = new URL(request.url);
      url.protocol = "https:";
      url.port = "";
      url.host = host;
      request = new Request(url, request);
    }
    const ip = request.headers.get("fixture-client-ip");
    if (ip) {
      const headers = new Headers(request.headers);
      headers.set("cf-connecting-ip", ip);
      request = new Request(request, { headers });
    }
    const exports = ctx.exports as unknown as Record<string, { route(request: Request): Promise<Response | null> }>;
    const binding = exports[(env as Env & { FIXTURE_PLACEMENT_AUTHORITY?: string }).FIXTURE_PLACEMENT_AUTHORITY === "none"
      ? "WithoutPlacementAuthority" : "LegacyV1"];
    return await binding.route(request.clone()) ?? Response.json({ legacy: true, body: await request.text() }, { status: 418 });
  },
};
