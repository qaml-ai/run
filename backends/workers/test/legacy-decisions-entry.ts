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
      let cancelled = false;
      let acknowledgeCancel: () => void;
      const bodyCancelled = new Promise<void>(resolve => { acknowledgeCancel = resolve; });
      const openUpload = request.headers.has("x-test-open-upload");
      // Model a caller which hasn't finished sending its body when auth refuses.
      const body = openUpload ? new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
        cancel() { cancelled = true; acknowledgeCancel(); },
      }) : request.body;
      const routed = new Request(`https://${host}${url.pathname}`, {
        method: request.method, headers: request.headers, body,
      });
      const response = await LegacyCamelBotsDecisions.route(routed) ?? new Response(null, { status: 418 });
      if (!openUpload) return response;
      await Promise.race([bodyCancelled, scheduler.wait(100)]);
      const headers = new Headers(response.headers);
      headers.set("x-test-upload-cancelled", String(cancelled));
      return new Response(response.body, { status: response.status, headers });
    }
    return await LegacyDecisions.route(request) ?? new Response(null, { status: 418 });
  },
};
