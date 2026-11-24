import { DEFAULT_MODEL_ID } from "./pi/models.ts";
import { getAgentStub } from "./agent-do.ts";
import {
  computeRawHmacHex,
  mintAgentToken,
  openSecret,
  parseChannelTenantId,
  randomId,
  sealSecret,
} from "./crypto.ts";
import { getTenantStub, type ChannelView } from "./tenant-do.ts";
import {
  ApiError,
  type AgentUpsertInput,
  type Env,
  type QueueMessagePayload,
} from "./types.ts";

export type { ChannelView };

export async function createChannelRecord(
  env: Env,
  tenantId: string,
  input: {
    kind?: "slack" | "email" | "http";
    name?: string;
    definition?: string;
    agentConfig?: AgentUpsertInput;
    outboundUrl?: string;
    secret?: string;
  },
): Promise<ChannelView> {
  return getTenantStub(env, tenantId).createChannel(input);
}

export async function listChannelRecords(env: Env, tenantId: string): Promise<ChannelView[]> {
  return getTenantStub(env, tenantId).listChannels();
}

export async function deleteChannelRecord(
  env: Env,
  tenantId: string,
  channelId: string,
): Promise<boolean> {
  return getTenantStub(env, tenantId).deleteChannel(channelId);
}

export async function handleChannelInbound(
  env: Env,
  channelId: string,
  rawBody: string,
  headers: Headers,
  authenticatedTenantId?: string,
): Promise<Record<string, unknown>> {
  const parsedTenantId = parseChannelTenantId(channelId) ?? authenticatedTenantId ?? "";
  if (!parsedTenantId) {
    throw new ApiError(404, "channel_not_found", `Channel '${channelId}' not found`);
  }
  if (authenticatedTenantId && parsedTenantId !== authenticatedTenantId) {
    throw new ApiError(403, "forbidden", "Channel belongs to a different tenant");
  }

  const tenantStub = getTenantStub(env, parsedTenantId);
  const row = await tenantStub.getChannelInternal(channelId);
  if (!row) {
    throw new ApiError(404, "channel_not_found", `Channel '${channelId}' not found`);
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new ApiError(400, "invalid_json", "Expected JSON inbound payload");
  }

  // Slack Events API URL verification handshake
  if (body.type === "url_verification" && typeof body.challenge === "string") {
    return { challenge: body.challenge };
  }

  // Optional webhook signature verification when channel has a secret AND no Bearer auth was used
  if (!authenticatedTenantId && row.sealedSecret) {
    const secret = await openSecret(row.sealedSecret, env.VAULT_SECRET);
    const sigHeader =
      headers.get("x-camelrun-signature") ?? headers.get("x-slack-signature") ?? "";
    if (!sigHeader) {
      throw new ApiError(401, "missing_signature", "Missing channel signature header");
    }
    const expectedHex = await computeRawHmacHex(rawBody, secret);
    if (!sigHeader.includes(expectedHex)) {
      throw new ApiError(401, "invalid_signature", "Channel signature mismatch");
    }
  }

  let threadId = "default";
  let promptText = "";
  let dynamicReplyUrl = row.outboundUrl;

  if (row.kind === "slack" || body.event) {
    const ev = (body.event && typeof body.event === "object"
      ? body.event
      : body) as Record<string, unknown>;
    threadId = String(ev.thread_ts ?? ev.ts ?? body.threadId ?? "default");
    promptText = String(ev.text ?? body.text ?? body.prompt ?? "");
    if (typeof body.response_url === "string") {
      dynamicReplyUrl = body.response_url;
    }
  } else if (row.kind === "email") {
    threadId = String(body.inReplyTo ?? body.threadId ?? body.messageId ?? body.from ?? "default");
    const subject = typeof body.subject === "string" ? `Subject: ${body.subject}\n\n` : "";
    promptText = `${subject}${String(body.text ?? body.body ?? body.prompt ?? "")}`.trim();
  } else {
    threadId = String(body.threadId ?? body.conversationId ?? "default");
    promptText = String(body.text ?? body.prompt ?? body.message ?? "");
    if (typeof body.replyUrl === "string") {
      dynamicReplyUrl = body.replyUrl;
    }
  }

  if (!promptText.trim()) {
    throw new ApiError(400, "invalid_request", "Inbound channel message has empty text");
  }

  const safeThread = threadId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default";
  const safeChan = row.id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const agentKey = `ch_${safeChan}_${safeThread}`;

  const defEntry = row.definition ? await tenantStub.getDefinition(row.definition) : null;
  const defCfg = defEntry?.config ?? null;
  let channelCfg: AgentUpsertInput = {};
  try {
    channelCfg = JSON.parse(row.agentConfigJson) as AgentUpsertInput;
  } catch {
    channelCfg = {};
  }

  const mergedModel =
    channelCfg.model ?? defCfg?.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
  const mergedInstructions =
    channelCfg.instructions ?? defCfg?.instructions ?? `Channel agent for ${row.name}.`;

  const existing = await tenantStub.resolveAgent(agentKey);
  const agentId = existing?.id ?? randomId("agt", 8);

  if (!existing) {
    const { token, tokenHash } = await mintAgentToken(row.tenantId, agentId);
    const sealedToken = await sealSecret(token, env.VAULT_SECRET);
    await tenantStub.upsertAgentIndex({
      id: agentId,
      key: agentKey,
      tokenHash,
      sealedToken,
      model: mergedModel,
      repoId: channelCfg.repoId ?? defCfg?.repoId ?? null,
      branch: channelCfg.branch ?? defCfg?.branch ?? "refs/heads/main",
      definitionSlug: row.definition,
    });
  }

  const agentStub = getAgentStub(env, agentId);
  await agentStub.initAgent({
    id: agentId,
    tenantId: row.tenantId,
    key: agentKey,
    model: mergedModel,
    instructions: mergedInstructions,
    definition: row.definition,
    tools: channelCfg.tools ?? defCfg?.tools ?? [],
    mcpServers: channelCfg.mcpServers ?? defCfg?.mcpServers ?? [],
    builtins: channelCfg.builtins ?? defCfg?.builtins ?? [],
    skills: channelCfg.skills ?? defCfg?.skills ?? [],
  });

  const runRecord = await agentStub.startRun({
    prompt: promptText,
    wait: true,
  });

  if (dynamicReplyUrl && env.EVENTS_QUEUE && runRecord.text) {
    const queueMsg: QueueMessagePayload = {
      kind: "channel_reply",
      tenantId: row.tenantId,
      channelId: row.id,
      channelKind: row.kind,
      outboundUrl: dynamicReplyUrl,
      sealedSecret: row.sealedSecret,
      threadId,
      agentId,
      runId: runRecord.id,
      replyText: runRecord.text,
    };
    await env.EVENTS_QUEUE.send(queueMsg).catch(() => {});
  }

  return {
    ok: true,
    channelId: row.id,
    threadId,
    agentId,
    agentKey,
    runId: runRecord.id,
    status: runRecord.status,
    reply: runRecord.text,
  };
}
