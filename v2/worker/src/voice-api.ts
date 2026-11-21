import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { assertAgentAccess, assertTenantScope, authenticateRequest } from "./auth.ts";
import { getTenantStub } from "./tenant-do.ts";
import { ApiError, type Env } from "./types.ts";
import { equalVoiceSecret, getVoiceCallStub } from "./voice-call-do.ts";
import {
  elevenlabsCalls,
  VOICE_ELEVENLABS_INDEX_DO_NAME,
  type ElevenLabsPostCall,
} from "./voice/elevenlabs.ts";
import {
  VoiceCallEndInput,
  VoiceCallInput,
  VoiceCallUpdate,
  VoiceTranscriptInput,
} from "./voice/schema.ts";

const NO_STORE = { "Cache-Control": "no-store" };

function parseSchema<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ApiError(400, "invalid_request", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "Invalid request"}`);
}

async function readJsonBody(req: Request, maxBytes = 64 * 1024, allowEmpty = true): Promise<unknown> {
  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new ApiError(413, "payload_too_large", "Request too large");
  const text = new TextDecoder().decode(buf).trim();
  if (!text) {
    if (allowEmpty) return {};
    throw new ApiError(400, "invalid_request", "Expected JSON body");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON");
  }
}

export async function handleCreateVoiceCall(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = await authenticateRequest(c.env, c.req.raw);
  const raw = await readJsonBody(c.req.raw, 512 * 1024, false);
  const options = parseSchema(VoiceCallInput, raw);

  const tenantStub = getTenantStub(c.env, auth.tenantId);
  let agentRow = await tenantStub.resolveAgent(options.agent);
  if (!agentRow && options.agent.startsWith("client_")) {
    const bridged = await tenantStub.getLegacyBridgeMeta<{ v2AgentId?: string }>("agent", options.agent);
    if (bridged?.v2AgentId) {
      agentRow = await tenantStub.resolveAgent(bridged.v2AgentId);
    }
  }
  if (!agentRow) {
    throw new ApiError(404, "agent_not_found", `Unknown agent: ${options.agent}`);
  }
  assertAgentAccess(auth, agentRow.id, "run");

  const id = "vc_" + crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  const origin = new URL(c.req.url).origin;
  const created = await getVoiceCallStub(c.env, id).createCall({
    id,
    tenant: auth.tenantId,
    v2AgentId: agentRow.id,
    options,
    origin,
  });

  const headers: Record<string, string> = { ...NO_STORE };
  if (created.onceSecret && c.req.header("idempotency-key")) {
    headers["Idempotency-Secret"] = "once";
  }
  return c.json({ ...created.call, connect: created.connect }, 201, headers);
}

export async function handleListVoiceCalls(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const stateParam = c.req.query("state");
  if (stateParam !== undefined && stateParam !== "live" && stateParam !== "ended") {
    throw new ApiError(400, "invalid_request", "state must be live or ended");
  }
  const limit = Math.trunc(Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50)));
  const ids = await getTenantStub(c.env, auth.tenantId).listVoiceCallIds({
    state: stateParam ?? null,
    limit,
  });
  const calls = await Promise.all(ids.map((id) => getVoiceCallStub(c.env, id).getCall(auth.tenantId)));
  return c.json({ calls, next: null }, 200, NO_STORE);
}

export async function handleGetVoiceCall(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = await authenticateRequest(c.env, c.req.raw);
  const id = c.req.param("id") ?? "";
  if (!id.startsWith("vc_")) throw new ApiError(404, "voice_call_not_found", "Voice call not found");
  const call = await getVoiceCallStub(c.env, id).getCall(auth.tenantId);
  return c.json(call, 200, NO_STORE);
}

export async function handleUpdateVoiceCall(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = await authenticateRequest(c.env, c.req.raw);
  const id = c.req.param("id") ?? "";
  if (!id.startsWith("vc_")) throw new ApiError(404, "voice_call_not_found", "Voice call not found");
  const patch = parseSchema(VoiceCallUpdate, await readJsonBody(c.req.raw));
  const call = await getVoiceCallStub(c.env, id).updateCall(auth.tenantId, patch);
  return c.json(call, 200, NO_STORE);
}

export async function handleEndVoiceCall(c: Context<{ Bindings: Env }>, withBody: boolean): Promise<Response> {
  const auth = await authenticateRequest(c.env, c.req.raw);
  const id = c.req.param("id") ?? "";
  if (!id.startsWith("vc_")) throw new ApiError(404, "voice_call_not_found", "Voice call not found");
  const input = withBody ? parseSchema(VoiceCallEndInput, await readJsonBody(c.req.raw)) : {};
  const call = await getVoiceCallStub(c.env, id).endCall(auth.tenantId, input.reason ?? "requested");
  return c.json(call, 200, NO_STORE);
}

export async function handleVoiceCallTranscript(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = await authenticateRequest(c.env, c.req.raw);
  const id = c.req.param("id") ?? "";
  if (!id.startsWith("vc_")) throw new ApiError(404, "voice_call_not_found", "Voice call not found");
  const input = parseSchema(VoiceTranscriptInput, await readJsonBody(c.req.raw, 64 * 1024, false));
  const out = await getVoiceCallStub(c.env, id).recordTranscript(auth.tenantId, input);
  return c.json(out, 202, NO_STORE);
}

export async function handleElevenLabsPostCall(c: Context<{ Bindings: Env }>): Promise<Response> {
  const buf = await c.req.raw.arrayBuffer();
  if (buf.byteLength > 1024 * 1024) throw new ApiError(413, "payload_too_large", "Request too large");
  const raw = Buffer.from(buf);
  let event: ElevenLabsPostCall;
  try {
    event = JSON.parse(raw.toString("utf8")) as ElevenLabsPostCall;
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON");
  }
  const provider = elevenlabsCalls(c.env, new URL(c.req.url).origin);
  const data = event?.data;
  const agent = typeof data?.agent_id === "string" ? await provider.agentFor(data.agent_id) : undefined;
  if (!agent) throw new ApiError(404, "unknown_elevenlabs_agent", "Unknown ElevenLabs agent");
  const secret = await provider.webhookSecret(agent.keyHash);
  const fields = (c.req.header("ElevenLabs-Signature") ?? "").split(",").map((field) => field.trim());
  const timestamp = fields.find((field) => /^t=\d+$/.test(field))?.slice(2);
  const digest = fields.find((field) => /^v0=[0-9a-f]{64}$/.test(field))?.slice(3);
  if (
    !secret ||
    !timestamp ||
    !digest ||
    Math.abs(Date.now() - Number(timestamp) * 1000) > 30 * 60_000 ||
    !equalVoiceSecret(
      Buffer.from(digest, "hex"),
      createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest(),
    )
  ) {
    throw new ApiError(400, "invalid_signature", "Invalid ElevenLabs signature");
  }
  if (
    (event.type === "post_call_transcription" || event.type === "call_initiation_failure") &&
    typeof data.conversation_id === "string"
  ) {
    const conv = await getTenantStub(c.env, VOICE_ELEVENLABS_INDEX_DO_NAME).findElevenLabsConversation(
      data.conversation_id,
      false,
    );
    if (conv) {
      await getVoiceCallStub(c.env, conv.callId).postCall(event);
    }
  }
  return c.json({}, 200, NO_STORE);
}

export async function handleElevenLabsTool(c: Context<{ Bindings: Env }>): Promise<Response> {
  const tool = c.req.param("tool");
  if (tool !== "ask_agent" && tool !== "stay_silent") {
    return c.json({}, 404, NO_STORE);
  }
  const secret = c.req.header("X-Voice-Tool-Secret");
  const input = (await readJsonBody(c.req.raw, 64 * 1024, true)) as {
    conversation_id?: unknown;
    request?: unknown;
  } | null;
  if (secret && typeof input?.conversation_id === "string") {
    const conv = await getTenantStub(c.env, VOICE_ELEVENLABS_INDEX_DO_NAME).findElevenLabsConversation(
      input.conversation_id,
      true,
    );
    if (conv) {
      const result = await getVoiceCallStub(c.env, conv.callId).elevenTool(
        tool,
        typeof input.request === "string" ? input.request : "",
        secret,
      );
      if (result) return c.json(result, 200, NO_STORE);
    }
  }
  return c.json({}, 404, NO_STORE);
}
