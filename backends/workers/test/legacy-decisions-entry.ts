export { LegacyDecisions } from "../src/legacy-decisions-entry.ts";

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
    const { LegacyDecisions } = ctx.exports as unknown as { LegacyDecisions: { route(request: Request): Promise<Response | null> } };
    return await LegacyDecisions.route(request) ?? new Response(null, { status: 418 });
  },
};
