import { HttpError } from "./errors.ts";
import { withSql } from "./postgres.ts";
import type { Env } from "./agent-types.ts";
import type { AuthContext } from "./control.ts";
import { VoiceCallInput, VoiceCallUpdate, VoiceCallEndInput, VoiceTranscriptInput } from "./voice/calls/schema.ts";
import { body } from "./validation.ts";

export const voiceJson = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });

async function input(request: Request, max = 64 * 1024, empty = true) {
  try { return await body(request, max, empty); }
  catch (error) {
    if (error instanceof Error && error.message === "Request body too large") throw new HttpError(413, "Request too large");
    throw error;
  }
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new HttpError(400, `${issue.path.join(".") || "body"}: ${issue.message}`);
}

export const voiceNotFound = () => new HttpError(404, "Voice call not found", "VOICE_CALL_NOT_FOUND");

export async function handleVoiceCalls(request: Request, env: Env, auth: AuthContext) {
  const url = new URL(request.url);
  const tenant = auth.tenantId;
  const method = request.method;
  if (url.pathname === "/v1/voice/sessions") {
    if (method === "POST") {
      const raw = await input(request, 512 * 1024);
      if (raw && typeof raw === "object" && "discord" in raw) throw new HttpError(404, "Voice sessions are not available on this runtime");
      const options = parse(VoiceCallInput, raw);
      const id = "vc_" + crypto.randomUUID().replaceAll("-", "").slice(0, 24);
      const response = await env.VOICE_CALLS.getByName(id).fetch(new Request("https://voice/create", {
        method: "POST", body: JSON.stringify({ id, tenant, options }),
      }));
      return response;
    }
    if (method === "GET") {
      const state = url.searchParams.get("state");
      if (state !== null && state !== "live" && state !== "ended") throw new HttpError(400, "state must be live or ended");
      if (url.searchParams.has("after")) throw new HttpError(400, "after must be a session id from this list");
      const limit = Math.trunc(Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50)));
      const { rows } = await withSql(env, sql => sql.query<{ id: string }>(`select id from workers_voice_calls where tenant=$1
        and ($2::text is null or (state='ended')=($2='ended')) order by created_at desc, id desc limit $3`, [tenant, state, limit]));
      const calls = await Promise.all(rows.map(async ({ id }) => {
        const response = await env.VOICE_CALLS.getByName(id).fetch(new Request("https://voice/get", { headers: { "X-Voice-Tenant": tenant } }));
        if (!response.ok) throw new HttpError(503, "Voice call index unavailable");
        return response.json();
      }));
      return voiceJson({ sessions: [], next: null, calls });
    }
    return;
  }
  const match = /^\/v1\/voice\/sessions\/([^/]+)(?:\/(end|transcript))?$/.exec(url.pathname);
  if (!match) return;
  const [, id, action] = match;
  if (!id.startsWith("vc_")) {
    if (action) throw voiceNotFound();
    throw new HttpError(404, "Voice sessions are not available on this runtime");
  }
  let path: string;
  let value: unknown;
  if (!action && method === "GET") path = "get";
  else if (!action && method === "PATCH") {
    path = "update";
    value = parse(VoiceCallUpdate, await input(request));
  } else if ((!action && method === "DELETE") || (action === "end" && method === "POST")) {
    path = "end";
    value = action ? parse(VoiceCallEndInput, await input(request)) : {};
  } else if (action === "transcript" && method === "POST") {
    path = "transcript";
    value = parse(VoiceTranscriptInput, await input(request, 64 * 1024, false));
  } else return;
  return env.VOICE_CALLS.getByName(id).fetch(new Request(`https://voice/${path}`, {
    method: value === undefined ? "GET" : "POST", headers: { "X-Voice-Tenant": tenant },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }));
}
