export { LegacyCamelBotsImages } from "../src/legacy-bots-images-entry.ts";

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
    const { LegacyCamelBotsImages } = ctx.exports as unknown as {
      LegacyCamelBotsImages: { route(request: Request): Promise<Response | null> };
    };
    const named = new Request("https://run.camelai.com/v1/images", {
      method: request.method, headers: request.headers, body: request.body,
    });
    return await LegacyCamelBotsImages.route(named) ?? new Response(null, { status: 418 });
  },
};
