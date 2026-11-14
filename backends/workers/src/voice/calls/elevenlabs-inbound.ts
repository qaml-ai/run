import { createHmac, timingSafeEqual } from "node:crypto";
import { boundedBytes } from "../../images.ts";
import { HttpError } from "../../errors.ts";
import { database, withSql } from "../../postgres.ts";
import { keyServices } from "../../security-services.ts";
import type { Env } from "../../agent-types.ts";
import { voiceJson } from "../../voice-calls-api.ts";
import { elevenlabsCalls, ELEVENLABS_INBOUND } from "./elevenlabs.ts";
import { body } from "../../validation.ts";

export type PostCall = {
  type: string;
  data: {
    agent_id: string; conversation_id: string; failure_reason?: unknown;
    metadata?: { call_duration_secs?: unknown; termination_reason?: unknown };
    transcript?: unknown;
  };
};

export async function elevenLabsProvider(env: Env, origin?: string) {
  const { accounts } = await keyServices(env);
  return elevenlabsCalls({
    db: database(env),
    baseUrl: env.TEST_MODE === "1" ? env.MEDIA_BASE_URL : undefined,
    publicUrl: env.AGENT_PUBLIC_URL ?? env.PUBLIC_URL ?? origin ?? "",
    seal: async value => JSON.stringify(accounts.seal("voice-elevenlabs", value)),
    unseal: async value => accounts.unseal("voice-elevenlabs", JSON.parse(value)),
  });
}

export function equalVoiceSecret(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function conversation(env: Env, providerCall: string, live = false) {
  return withSql(env, async sql => (await sql.query<{ id: string }>(`select id from workers_voice_calls
    where provider='elevenlabs' and provider_call=$1 and ($2=false or state='live')`, [providerCall, live])).rows[0]);
}

export async function handleElevenLabsInbound(request: Request, env: Env) {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.startsWith(ELEVENLABS_INBOUND + "/")) return;
  const path = url.pathname.slice(ELEVENLABS_INBOUND.length);
  if (path === "/post-call") {
    const raw = Buffer.from(await boundedBytes(request.body, 1024 * 1024));
    let event: PostCall;
    try { event = JSON.parse(raw.toString("utf8")); }
    catch { throw new HttpError(400, "Invalid JSON"); }
    const provider = await elevenLabsProvider(env);
    const data = event?.data;
    const agent = typeof data?.agent_id === "string" ? await provider.agentFor(data.agent_id) : undefined;
    if (!agent) throw new HttpError(404, "Unknown ElevenLabs agent");
    const secret = await provider.webhookSecret(agent.keyHash);
    const fields = (request.headers.get("ElevenLabs-Signature") ?? "").split(",").map(field => field.trim());
    const timestamp = fields.find(field => /^t=\d+$/.test(field))?.slice(2);
    const digest = fields.find(field => /^v0=[0-9a-f]{64}$/.test(field))?.slice(3);
    if (!secret || !timestamp || !digest || Math.abs(Date.now() - Number(timestamp) * 1000) > 30 * 60_000 ||
      !equalVoiceSecret(Buffer.from(digest, "hex"), createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest()))
      throw new HttpError(400, "Invalid ElevenLabs signature");
    if ((event.type === "post_call_transcription" || event.type === "call_initiation_failure") && typeof data.conversation_id === "string") {
      const row = await conversation(env, data.conversation_id);
      if (row) await env.VOICE_CALLS.getByName(row.id).postCall(event);
    }
    return voiceJson({});
  }
  const tool = /^\/tools\/(ask_agent|stay_silent)$/.exec(path)?.[1];
  if (tool) {
    const secret = request.headers.get("X-Voice-Tool-Secret");
    const input = await body(request, 64 * 1024) as { conversation_id?: unknown; request?: unknown } | null;
    if (secret && typeof input?.conversation_id === "string") {
      const row = await conversation(env, input.conversation_id, true);
      if (row) {
        const result = await env.VOICE_CALLS.getByName(row.id).elevenTool(tool, typeof input.request === "string" ? input.request : "", secret);
        if (result) return voiceJson(result);
      }
    }
  }
  return voiceJson({}, 404);
}
