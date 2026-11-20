export { LegacyCamelBotsDecisions, LegacyDecisions } from "../src/legacy-decisions-entry.ts";

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
    type Decisions = { route(request: Request): Promise<Response | null> };
    const { LegacyCamelBotsDecisions, LegacyDecisions } = ctx.exports as unknown as {
      LegacyCamelBotsDecisions: Decisions;
      LegacyDecisions: Decisions;
    };
    if (request.headers.has("x-test-camel-bots")) {
      const host = request.headers.get("x-test-camel-bots");
      const url = new URL(request.url);
      const routed = new Request(`https://${host}${url.pathname}`, {
        method: request.method, headers: request.headers, body: request.body,
      });
      return await LegacyCamelBotsDecisions.route(routed) ?? new Response(null, { status: 418 });
    }
    return await LegacyDecisions.route(request) ?? new Response(null, { status: 418 });
  },
};
