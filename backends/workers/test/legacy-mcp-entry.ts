import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../src/agent-types.ts";
import worker from "../src/index.ts";

export * from "../src/index.ts";

export class FixtureLegacyOrigin extends WorkerEntrypoint {
  fetch(request: Request) {
    if (new URL(request.url).pathname !== "/v1/me") throw new Error("Unexpected legacy route");
    const bearer = request.headers.get("authorization");
    return Response.json({ tenant: "fixture", via: bearer?.startsWith("Bearer aro_") ? "oauth" : "token" });
  }
}

export class FixtureLegacyDestination extends WorkerEntrypoint {
  async route(tenant: string, agent: string, request: Request) {
    if (tenant !== `tnt_${"1".repeat(16)}` || agent !== `agt_${"2".repeat(16)}`) return new Response(null, { status: 404 });
    const url = new URL(request.url);
    const prefix = `/v2/agents/${agent}`;
    const idempotencyKey = "v1-compat:fixture-prompt";
    if (url.pathname === `${prefix}/history` && request.method === "GET") return Response.json({ messages: [] });
    if (request.method === "POST" && url.pathname === `${prefix}/runs`) {
      const body = await request.json() as { idempotencyKey: string; prompt: string; wait: boolean };
      if (body.prompt !== "Run on the private destination" || body.idempotencyKey !== idempotencyKey || body.wait !== false) {
        return new Response(null, { status: 422 });
      }
    } else if (request.method !== "GET" || decodeURIComponent(url.pathname) !== `${prefix}/runs/${idempotencyKey}` || url.searchParams.get("by") !== "idempotency-key") {
      return new Response(null, { status: 404 });
    }
    return Response.json({ id: "run_fixture", agentId: agent, idempotencyKey, startedAt: 1, endedAt: 2, status: "completed",
      text: "From v2", output: null, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, error: null });
  }
}

export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/healthz") return worker.fetch(request, env, ctx);
    // Supply a non-loopback edge IP for the rate-limit fixture.
    const fixtureIp = request.headers.get("fixture-client-ip");
    if (fixtureIp) {
      const headers = new Headers(request.headers);
      headers.set("cf-connecting-ip", fixtureIp);
      request = new Request(request, { headers });
    }
    const binding = (ctx.exports as unknown as { LegacyV1: { route(request: Request): Promise<Response | null> } }).LegacyV1;
    return await binding.route(request) ?? new Response("original-route", { status: 418 });
  },
};
