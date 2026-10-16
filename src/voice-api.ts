import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { VoiceSessions } from "./voice-sessions.ts";
import { HttpError, readJson } from "./http.ts";
import * as schema from "./api-schemas.ts";

type Route = (config: RouteConfig, handler: (c: Context<any>) => Promise<Response> | Response) => void;
const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
const reply = (description: string, value: z.ZodType) => ({ description, content: { "application/json": { schema: value } } });
const body = (value: z.ZodType) => ({ content: { "application/json": { schema: value } } });
const sessionId = z.object({ id: z.string() });

/** The body, checked against its schema; the service checks what a schema cannot (ids, ranges, the endpoint's host). */
async function parse(type: z.ZodType, c: Context): Promise<Record<string, unknown>> {
  const result = type.safeParse(await readJson(c.req.raw.body, 64 * 1024, {}));
  if (!result.success) throw new HttpError(400, `${result.error.issues[0].path.join(".") || "body"}: ${result.error.issues[0].message}`);
  return result.data as Record<string, unknown>;
}

/** /v1/voice/sessions: calls camelRun holds for a tenant's bot (src/voice-sessions.ts). */
export function voiceRoutes(route: Route, voice: () => VoiceSessions | undefined) {
  const service = () => {
    const value = voice();
    if (!value) throw new HttpError(404, "Voice sessions are not enabled on this runtime");
    return value;
  };
  route(createRoute({
    method: "post", path: "/v1/voice/sessions", request: { body: body(schema.VoiceSessionInput) },
    responses: { 201: reply("The session, connecting; and the notice your app must post in the channel", schema.VoiceSessionCreated) },
  }), async c => json(c, 201, await service().create(c.var.principal.tenant, await parse(schema.VoiceSessionInput, c))));
  route(createRoute({
    method: "get", path: "/v1/voice/sessions",
    request: { query: z.object({
      state: z.enum(["live", "ended"]).optional().openapi({ description: "Only live (not ended) or ended sessions; all by default" }),
      limit: z.string().optional().openapi({ description: "1 to 100, default 50" }),
      after: z.string().optional().openapi({ description: "The previous page's next" }),
    }) },
    responses: { 200: reply("The tenant's voice sessions, newest first (ended ones for 30 days)", schema.VoiceSessionList) },
  }), async c => {
    const limit = c.req.query("limit");
    return json(c, 200, await service().list(c.var.principal.tenant, {
      ...(c.req.query("state") !== undefined ? { state: c.req.query("state") } : {}),
      ...(limit !== undefined ? { limit: Number(limit) || 50 } : {}),
      ...(c.req.query("after") !== undefined ? { after: c.req.query("after") } : {}),
    }));
  });
  route(createRoute({ method: "get", path: "/v1/voice/sessions/{id}", request: { params: sessionId }, responses: { 200: reply("The session", schema.VoiceSession) } }),
    async c => json(c, 200, await service().get(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({
    method: "patch", path: "/v1/voice/sessions/{id}", request: { params: sessionId, body: body(schema.VoiceSessionUpdate) },
    responses: { 200: reply("The session; it reconnects with new credentials", schema.VoiceSession) },
  }), async c => json(c, 200, await service().update(c.var.principal.tenant, c.req.param("id")!, await parse(schema.VoiceSessionUpdate, c))));
  route(createRoute({
    method: "post", path: "/v1/voice/sessions/{id}/speak", request: { params: sessionId, body: body(schema.VoiceSpeechInput) },
    responses: { 202: reply("Queued: it plays in turn (voice.speech.started and voice.speech.ended follow)", schema.VoiceSpeech) },
  }), async c => json(c, 202, await service().speak(c.var.principal.tenant, c.req.param("id")!, await parse(schema.VoiceSpeechInput, c))));
  route(createRoute({
    method: "delete", path: "/v1/voice/sessions/{id}/speak", request: { params: sessionId },
    responses: { 200: reply("What the bot was saying, and was going to, stopped", schema.VoiceSpeechStopped) },
  }), async c => json(c, 200, await service().stopSpeaking(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({
    method: "delete", path: "/v1/voice/sessions/{id}", request: { params: sessionId },
    responses: { 200: reply("The session, ended; and the OP 4 your app sends to leave the channel", schema.VoiceSessionEnded) },
  }), async c => json(c, 200, await service().end(c.var.principal.tenant, c.req.param("id")!)));
}
