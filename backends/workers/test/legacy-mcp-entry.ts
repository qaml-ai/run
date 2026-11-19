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

export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/healthz") return worker.fetch(request, env, ctx);
    const binding = (ctx.exports as unknown as { LegacyV1: { route(request: Request): Promise<Response | null> } }).LegacyV1;
    return await binding.route(request) ?? new Response("original-route", { status: 418 });
  },
};
