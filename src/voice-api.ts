import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { VoiceSessions } from "./voice-sessions.ts";
import { HttpError, readBytes, readJson } from "./http.ts";
import { AUDIO_LIMITS } from "./voice/jukebox.ts";
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
    method: "post", path: "/v1/voice/sessions/{id}/browser-token", request: { params: sessionId },
    responses: { 200: reply("Another token for a browser session's socket (the first one expired, or the page reloaded)", schema.VoiceBrowserToken) },
  }), async c => json(c, 200, await service().newBrowserToken(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({
    method: "delete", path: "/v1/voice/sessions/{id}/speak", request: { params: sessionId },
    responses: { 200: reply("What the bot was saying, and was going to, stopped", schema.VoiceSpeechStopped) },
  }), async c => json(c, 200, await service().stopSpeaking(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({
    method: "post", path: "/v1/voice/sessions/{id}/recording", request: { params: sessionId, body: body(schema.VoiceRecordingInput) },
    responses: { 201: reply("The recording, started: the call's audio is kept until it stops, then made into Ogg Opus files. and the notice your app must post in the channel", schema.VoiceRecordingStarted) },
  }), async c => json(c, 201, await service().startRecording(c.var.principal.tenant, c.req.param("id")!, await parse(schema.VoiceRecordingInput, c))));
  route(createRoute({
    method: "delete", path: "/v1/voice/sessions/{id}/recording", request: { params: sessionId },
    responses: { 200: reply("The recording, stopped: ready with its files, or stopping if they take longer than 20 seconds to make (voice.recording.ended says when they are)", schema.VoiceRecording) },
  }), async c => json(c, 200, await service().stopRecording(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({ method: "get", path: "/v1/voice/recordings/{id}", request: { params: sessionId }, responses: { 200: reply("The recording", schema.VoiceRecording) } }),
    async c => json(c, 200, await service().getRecording(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({
    method: "get", path: "/v1/voice/recordings/{id}/files/{name}", request: { params: z.object({ id: z.string(), name: z.string() }) },
    responses: { 200: { description: "The file: Ogg Opus", content: { "audio/ogg": { schema: z.string().openapi({ format: "binary" }) } } } },
  }), async c => {
    const file = await service().recordingFile(c.var.principal.tenant, c.req.param("id")!, c.req.param("name")!);
    return new Response(file.data as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": file.contentType, "Content-Length": String(file.data.byteLength), "Content-Disposition": `attachment; filename="${file.name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  });
  route(createRoute({ method: "delete", path: "/v1/voice/recordings/{id}", request: { params: sessionId }, responses: { 200: reply("The recording and its files, deleted", schema.VoiceRecordingDeleted) } }),
    async c => json(c, 200, await service().deleteRecording(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({
    method: "post", path: "/v1/voice/sessions/{id}/say", request: { params: sessionId, body: body(schema.VoiceSayInput) },
    responses: { 202: reply("Queued: the bot says it in its call's voice once its turn comes", schema.VoiceQueued) },
  }), async c => json(c, 202, await service().say(c.var.principal.tenant, c.req.param("id")!, await parse(schema.VoiceSayInput, c) as { text: string; interrupt?: boolean })));
  route(createRoute({
    method: "post", path: "/v1/voice/sessions/{id}/prompt", request: { params: sessionId, body: body(schema.VoicePromptInput) },
    responses: { 202: reply("Queued: the model speaks up once the floor is free", schema.VoiceQueued) },
  }), async c => json(c, 202, await service().prompt(c.var.principal.tenant, c.req.param("id")!, await parse(schema.VoicePromptInput, c) as { instructions: string; interrupt?: boolean })));
  route(createRoute({
    method: "post", path: "/v1/voice/sessions/{id}/audio",
    request: {
      params: sessionId,
      query: z.object({
        title: z.string().optional().openapi({ description: "With a file as the body: a name for it" }),
        next: z.enum(["true", "false"]).optional().openapi({ description: "With a file as the body: before the others waiting" }),
        volume: z.string().optional().openapi({ description: "With a file as the body: set the volume (0 to 1)" }),
      }),
      body: { content: { "application/json": { schema: schema.VoiceAudioInput }, "application/octet-stream": { schema: z.string().openapi({ format: "binary", description: "The file itself (MP3, Ogg Opus or WAV; 10 MB at most), as audio/* or application/octet-stream" }) } } },
    },
    responses: { 202: reply("Queued: it plays after what plays and waits (or at once)", schema.VoiceAudioQueued) },
  }), async c => {
    const type = c.req.header("content-type") ?? "";
    const tenant = c.var.principal.tenant, id = c.req.param("id")!;
    if (/^application\/json(;|$)/i.test(type)) return json(c, 202, await service().play(tenant, id, await parse(schema.VoiceAudioInput, c) as { url: string; title?: string; next?: boolean; volume?: number }));
    if (!/^(audio\/[\w.+-]+|application\/octet-stream)(;|$)/i.test(type)) throw new HttpError(415, "Send JSON with a url, or the file as audio/* or application/octet-stream");
    const bytes = new Uint8Array(await readBytes(c.req.raw.body, AUDIO_LIMITS.uploadBytes));
    const volume = c.req.query("volume");
    return json(c, 202, await service().play(tenant, id, {
      bytes, ...(c.req.query("title") !== undefined ? { title: c.req.query("title") } : {}), ...(c.req.query("next") === "true" ? { next: true } : {}),
      ...(volume !== undefined ? { volume: Number(volume) } : {}),
    }));
  });
  route(createRoute({ method: "get", path: "/v1/voice/sessions/{id}/audio", request: { params: sessionId }, responses: { 200: reply("What plays, and what waits", schema.VoiceAudioState) } }),
    async c => json(c, 200, await service().audio(c.var.principal.tenant, c.req.param("id")!)));
  route(createRoute({
    method: "patch", path: "/v1/voice/sessions/{id}/audio", request: { params: sessionId, body: body(schema.VoiceAudioControl) },
    responses: { 200: reply("What plays, and what waits, after it", schema.VoiceAudioState) },
  }), async c => json(c, 200, await service().controlAudio(c.var.principal.tenant, c.req.param("id")!, await parse(schema.VoiceAudioControl, c) as { action?: "pause" | "resume" | "skip" | "stop"; volume?: number })));
  route(createRoute({
    method: "delete", path: "/v1/voice/sessions/{id}", request: { params: sessionId },
    responses: { 200: reply("The session, ended; and the OP 4 your app sends to leave the channel", schema.VoiceSessionEnded) },
  }), async c => json(c, 200, await service().end(c.var.principal.tenant, c.req.param("id")!)));
}
