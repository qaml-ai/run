import { createHash, randomBytes } from "node:crypto";
import { elevenlabsLanguage } from "../lib/language.ts";
import { redactDetail } from "../lib/voice-socket.ts";
import { openSecret, sealSecret } from "../crypto.ts";
import { getTenantStub } from "../tenant-do.ts";
import type { Env } from "../types.ts";
import { ASK_AGENT, STAY_SILENT } from "./prompts.ts";

export const VOICE_ELEVENLABS_INDEX_DO_NAME = "camelrun:voice-elevenlabs-index";
export const ELEVENLABS_INBOUND_PATH = "/v2/voice/providers/elevenlabs";

export type ElevenLabsPostCall = {
  type: string;
  data: {
    agent_id: string;
    conversation_id: string;
    failure_reason?: unknown;
    metadata?: { call_duration_secs?: unknown; termination_reason?: unknown };
    transcript?: unknown;
  };
};

type ProvisionInput = {
  apiKey: string;
  model: string;
  instructions: string;
  language?: string;
  voiceId: string;
};

type ConversationInfo = {
  durationSeconds?: number;
  status?: string;
  terminationReason?: string;
};

const JESSICA = "cgSgspJ2msm6clMCkdW9";
const VOICE_FOR: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(
    Object.create(null),
    Object.fromEntries(
      ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar", "nova", "onyx", "fable"].map(
        (name) => [name, JESSICA],
      ),
    ),
  ),
);

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function terminationReasonToEnd(text: string): "max_duration" | "client" | "agent" | "provider" {
  if (/max call duration/i.test(text)) return "max_duration";
  if (/end_call/i.test(text)) return "agent";
  if (/client disconnected|ended by the user/i.test(text)) return "client";
  return "provider";
}

export function elevenlabsCalls(env: Env, origin: string) {
  const base = (env.VOICE_ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
  const publicBase = (env.VOICE_PUBLIC_URL ?? origin).replace(/\/+$/, "");
  const inbound = publicBase + ELEVENLABS_INBOUND_PATH;
  const indexStub = getTenantStub(env, VOICE_ELEVENLABS_INDEX_DO_NAME);

  async function api<T>(apiKey: string, stage: string, path: string, body?: unknown, method?: string): Promise<T | undefined> {
    try {
      const response = await fetch(base + path, {
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
        ...(method ? { method } : {}),
        signal: AbortSignal.timeout(20_000),
        redirect: "manual",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response.status === 204 ? undefined : ((await response.json()) as T);
    } catch (error) {
      const secret = (body as { tool_config?: { api_schema: { request_headers: Record<string, string> } } } | undefined)
        ?.tool_config?.api_schema.request_headers["X-Voice-Tool-Secret"];
      throw new Error(
        `ElevenLabs ${stage}: ${redactDetail(error instanceof Error ? error.message : String(error), 250, secret ? [apiKey, secret] : [apiKey])}`,
      );
    }
  }

  async function ensureWebhook(apiKey: string, keyHash: string): Promise<string> {
    const existing = await indexStub.getElevenLabsWebhook(keyHash);
    if (existing) return existing.webhookId;
    const created = await api<{ webhook_id: string; webhook_secret: string }>(
      apiKey,
      "register webhook",
      "/v1/workspace/webhooks",
      {
        settings: { name: "camelRun voice calls", webhook_url: `${inbound}/post-call`, auth_type: "hmac" },
      },
    );
    if (!created?.webhook_secret) throw new Error("ElevenLabs returned no webhook secret");
    if (!created.webhook_id) throw new Error("ElevenLabs returned no webhook id");
    const sealed = await sealSecret(created.webhook_secret, env.VAULT_SECRET);
    const saved = await indexStub.putElevenLabsWebhook({
      keyHash,
      webhookId: created.webhook_id,
      sealedSecret: sealed,
    });
    return saved.webhookId;
  }

  return {
    defaultModel: "gemini-3.1-flash-lite" as const,
    voices: [JESSICA] as readonly string[],
    voiceFor: VOICE_FOR,
    async provision(input: ProvisionInput): Promise<{ agentId: string; toolSecret: string; cached: boolean }> {
      const keyHash = hash(input.apiKey);
      const personaHash = hash(input.instructions);
      const cached = await indexStub.findElevenLabsAgent({ keyHash, model: input.model, personaHash });
      if (cached) {
        return {
          agentId: cached.agentId,
          toolSecret: await openSecret(cached.sealedToolSecret, env.VAULT_SECRET),
          cached: true,
        };
      }
      const webhookId = await ensureWebhook(input.apiKey, keyHash);
      const toolSecret = randomBytes(24).toString("base64url");
      const toolIds: string[] = [];
      for (const tool of [ASK_AGENT, STAY_SILENT]) {
        const ask = tool === ASK_AGENT;
        const created = await api<{ id: string }>(input.apiKey, `create ${tool.name} tool`, "/v1/convai/tools", {
          tool_config: {
            type: "webhook",
            name: tool.name,
            description: tool.description,
            api_schema: {
              url: `${inbound}/tools/${tool.name}`,
              method: "POST",
              content_type: "application/json",
              request_headers: { "X-Voice-Tool-Secret": toolSecret },
              request_body_schema: {
                type: "object",
                required: ask ? ["request", "conversation_id"] : ["conversation_id"],
                properties: {
                  ...(ask ? { request: (ASK_AGENT.parameters.properties as Record<string, unknown>).request } : {}),
                  conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
                },
              },
            },
            response_timeout_secs: 60,
            pre_tool_speech: ask ? "force" : "off",
            execution_mode: "immediate",
          },
        });
        if (!created?.id) throw new Error(`ElevenLabs returned no ${tool.name} tool id`);
        toolIds.push(created.id);
      }
      const created = await api<{ agent_id: string }>(input.apiKey, "create agent", "/v1/convai/agents/create", {
        name: `camelRun voice ${input.model} ${personaHash.slice(0, 8)}`,
        conversation_config: {
          agent: {
            first_message: "",
            language: elevenlabsLanguage(input.language) ?? "en",
            prompt: {
              prompt: input.instructions,
              llm: input.model,
              temperature: 0.3,
              tool_ids: toolIds,
              ...(input.model === "gemini-2.5-flash-lite" || input.model === "gemini-3.1-flash-lite"
                ? { thinking_budget: 0 }
                : {}),
            },
          },
          asr: { user_input_audio_format: "pcm_16000" },
          tts: {
            voice_id: VOICE_FOR[input.voiceId] ?? input.voiceId,
            model_id: "eleven_v4_turbo",
            agent_output_audio_format: "pcm_24000",
          },
          turn: { turn_eagerness: "normal", turn_timeout: 7, silence_end_call_timeout: -1 },
          conversation: {
            max_duration_seconds: 1800,
            client_events: [
              "conversation_initiation_metadata",
              "ping",
              "audio",
              "interruption",
              "user_transcript",
              "agent_response",
              "agent_response_complete",
              "client_error",
            ],
          },
        },
        platform_settings: {
          auth: { enable_auth: true },
          privacy: { record_voice: false },
          overrides: { conversation_config_override: { tts: { voice_id: true }, agent: { language: true } } },
          workspace_overrides: {
            webhooks: {
              post_call_webhook_id: webhookId,
              events: ["transcript", "call_initiation_failure"],
              send_audio: false,
            },
          },
        },
      });
      if (!created?.agent_id) throw new Error("ElevenLabs returned no agent id");
      const sealedToolSecret = await sealSecret(toolSecret, env.VAULT_SECRET);
      const saved = await indexStub.putElevenLabsAgent({
        keyHash,
        model: input.model,
        personaHash,
        agentId: created.agent_id,
        sealedToolSecret,
      });
      return {
        agentId: saved.agentId,
        toolSecret: await openSecret(saved.sealedToolSecret, env.VAULT_SECRET),
        cached: false,
      };
    },
    async evictAgent(agentId: string): Promise<boolean> {
      return indexStub.deleteElevenLabsAgent(agentId);
    },
    async signedUrl(input: { apiKey: string; agentId: string }): Promise<{ signedUrl: string; conversationId: string }> {
      const query = new URLSearchParams({ agent_id: input.agentId, include_conversation_id: "true" });
      const result = await api<{ signed_url: string; conversation_id?: string | null }>(
        input.apiKey,
        "signed URL",
        `/v1/convai/conversation/get-signed-url?${query}`,
      );
      if (typeof result?.signed_url !== "string") throw new Error("ElevenLabs returned no signed URL");
      let conversationId = result.conversation_id;
      if (typeof conversationId !== "string" || !conversationId) {
        try {
          conversationId = new URL(result.signed_url).searchParams.get("conversation_id");
        } catch {
          throw new Error("ElevenLabs returned an invalid signed URL");
        }
      }
      if (!conversationId) throw new Error("ElevenLabs returned no conversation id");
      return { signedUrl: result.signed_url, conversationId };
    },
    async conversation(apiKey: string, conversationId: string): Promise<ConversationInfo> {
      const result = await api<{
        status?: unknown;
        metadata?: { call_duration_secs?: unknown; termination_reason?: unknown };
      }>(apiKey, "get conversation", `/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
      const duration = result?.metadata?.call_duration_secs;
      return {
        durationSeconds: typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, duration) : undefined,
        status: typeof result?.status === "string" ? result.status : undefined,
        terminationReason:
          typeof result?.metadata?.termination_reason === "string" ? result.metadata.termination_reason : undefined,
      };
    },
    async agentFor(agentId: string): Promise<{ keyHash: string; toolSecret: string } | undefined> {
      const row = await indexStub.getElevenLabsAgentById(agentId);
      if (!row) return undefined;
      return { keyHash: row.keyHash, toolSecret: await openSecret(row.sealedToolSecret, env.VAULT_SECRET) };
    },
    async webhookSecret(keyHash: string): Promise<string | undefined> {
      const row = await indexStub.getElevenLabsWebhook(keyHash);
      if (!row) return undefined;
      return openSecret(row.sealedSecret, env.VAULT_SECRET);
    },
    async diagnose(
      apiKey?: string,
      options?: { conversationsPageSize?: number; cursor?: string },
    ): Promise<Record<string, unknown>> {
      const keyHash = apiKey ? hash(apiKey) : null;
      const rawPageSize = Number(options?.conversationsPageSize ?? 10);
      const conversationsPageSize = Number.isFinite(rawPageSize)
        ? Math.max(1, Math.min(100, Math.trunc(rawPageSize)))
        : 10;
      const cursor = options?.cursor?.trim() || undefined;

      type AgentDetailResponse = {
        agent_id?: string;
        name?: string;
        archived?: boolean;
        conversation_config?: {
          agent?: { prompt?: { llm?: string; thinking_budget?: number; tool_ids?: string[] } };
          tts?: { model_id?: string; voice_id?: string };
        };
        platform_settings?: {
          auth?: { enable_auth?: boolean };
          workspace_overrides?: { webhooks?: { post_call_webhook_id?: string | null } };
        };
      };

      const fetchDetail = async (agentId: string): Promise<
        | { ok: true; detail: AgentDetailResponse }
        | { ok: false; missing: boolean; error: string }
      > => {
        if (!apiKey) return { ok: false, missing: false, error: "No ElevenLabs API key configured" };
        try {
          const detail = await api<AgentDetailResponse>(
            apiKey,
            `get agent ${agentId}`,
            `/v1/convai/agents/${encodeURIComponent(agentId)}`,
          );
          return { ok: true, detail: detail ?? {} };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { ok: false, missing: /HTTP 404\b/.test(msg), error: msg };
        }
      };

      const [subscriptionResult, agentsListResult, conversationsResult, cacheResult] = await Promise.all([
        (async () => {
          if (!apiKey) return { ok: false as const, error: "ELEVENLABS_API_KEY is not configured" };
          try {
            const sub = await api<Record<string, unknown>>(apiKey, "get subscription", "/v1/user/subscription");
            const characterCount = typeof sub?.character_count === "number" ? sub.character_count : undefined;
            const characterLimit = typeof sub?.character_limit === "number" ? sub.character_limit : undefined;
            const canExtendCharacterLimit =
              typeof sub?.can_extend_character_limit === "boolean" ? sub.can_extend_character_limit : undefined;
            const nextResetUnix =
              typeof sub?.next_character_count_reset_unix === "number"
                ? sub.next_character_count_reset_unix
                : undefined;
            const charactersRemaining =
              characterCount !== undefined && characterLimit !== undefined
                ? Math.max(0, characterLimit - characterCount)
                : undefined;
            const percentUsed =
              characterCount !== undefined && characterLimit !== undefined && characterLimit > 0
                ? Math.round((characterCount / characterLimit) * 10000) / 100
                : undefined;
            const quotaExhausted =
              characterCount !== undefined &&
              characterLimit !== undefined &&
              characterCount >= characterLimit &&
              canExtendCharacterLimit === false;
            return {
              ok: true as const,
              tier: typeof sub?.tier === "string" ? sub.tier : undefined,
              status: typeof sub?.status === "string" ? sub.status : undefined,
              characterCount,
              characterLimit,
              charactersRemaining,
              percentUsed,
              quotaExhausted,
              nextCharacterCountResetUnix: nextResetUnix,
              nextCharacterCountResetAt:
                nextResetUnix !== undefined ? new Date(nextResetUnix * 1000).toISOString() : undefined,
              canExtendCharacterLimit,
              allowedToExtendCharacterLimit:
                typeof sub?.allowed_to_extend_character_limit === "boolean"
                  ? sub.allowed_to_extend_character_limit
                  : undefined,
              currency: typeof sub?.currency === "string" || sub?.currency === null ? sub.currency : undefined,
              billingPeriod:
                typeof sub?.billing_period === "string" || sub?.billing_period === null ? sub.billing_period : undefined,
              characterRefreshPeriod:
                typeof sub?.character_refresh_period === "string" || sub?.character_refresh_period === null
                  ? sub.character_refresh_period
                  : undefined,
              nextInvoice: sub?.next_invoice ?? undefined,
            };
          } catch (err) {
            return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
          }
        })(),
        (async () => {
          if (!apiKey) return { ok: false as const, error: "ELEVENLABS_API_KEY is not configured" };
          try {
            const list = await api<{
              agents?: Array<{
                agent_id?: string;
                name?: string;
                archived?: boolean;
                created_at_unix_secs?: number;
                last_call_time_unix_secs?: number;
              }>;
              has_more?: boolean;
            }>(apiKey, "list agents", "/v1/convai/agents?page_size=20");
            return { ok: true as const, agents: list?.agents ?? [], hasMore: Boolean(list?.has_more) };
          } catch (err) {
            return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
          }
        })(),
        (async () => {
          if (!apiKey) return { ok: false as const, error: "ELEVENLABS_API_KEY is not configured" };
          try {
            const query = new URLSearchParams({ page_size: String(conversationsPageSize) });
            if (cursor) query.set("cursor", cursor);
            const list = await api<{
              conversations?: Array<{
                conversation_id?: string;
                agent_id?: string;
                agent_name?: string;
                status?: string;
                call_successful?: string;
                start_time_unix_secs?: number;
                call_duration_secs?: number;
                message_count?: number;
              }>;
              has_more?: boolean;
              next_cursor?: string | null;
            }>(apiKey, "list conversations", `/v1/convai/conversations?${query}`);
            const convs = list?.conversations ?? [];
            const detailMap = new Map<string, Record<string, unknown>>();
            await Promise.all(
              convs.slice(0, 3).map(async (conv) => {
                if (!conv.conversation_id) return;
                try {
                  const detail = await api<Record<string, unknown>>(
                    apiKey,
                    `get conversation ${conv.conversation_id}`,
                    `/v1/convai/conversations/${encodeURIComponent(conv.conversation_id)}`,
                  );
                  if (detail) detailMap.set(conv.conversation_id, detail);
                } catch {
                  // Best-effort detail lookup
                }
              }),
            );
            return {
              ok: true as const,
              count: convs.length,
              hasMore: Boolean(list?.has_more),
              nextCursor: typeof list?.next_cursor === "string" ? list.next_cursor : null,
              items: convs.map((c) => {
                const detail = c.conversation_id ? detailMap.get(c.conversation_id) : undefined;
                const meta = (detail?.metadata ?? undefined) as Record<string, unknown> | undefined;
                return {
                  conversationId: c.conversation_id ?? "",
                  agentId: c.agent_id,
                  agentName: c.agent_name,
                  status: (typeof detail?.status === "string" ? detail.status : c.status) ?? undefined,
                  callSuccessful: c.call_successful,
                  startTimeUnixSecs: c.start_time_unix_secs,
                  callDurationSecs: c.call_duration_secs,
                  messageCount: c.message_count,
                  terminationReason:
                    typeof meta?.termination_reason === "string" ? meta.termination_reason : undefined,
                  failureReason:
                    typeof detail?.failure_reason === "string"
                      ? detail.failure_reason
                      : typeof meta?.error === "string"
                        ? meta.error
                        : undefined,
                  error: meta?.error ?? undefined,
                };
              }),
            };
          } catch (err) {
            return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
          }
        })(),
        (async () => {
          try {
            const cached = await indexStub.listElevenLabsCache();
            return { ok: true as const, ...cached };
          } catch (err) {
            return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
          }
        })(),
      ]);

      // Fetch details for up to 10 agents (prioritizing cached agents, then remote listed agents)
      const detailIds: string[] = [];
      const addDetailId = (id?: string) => {
        if (id && !detailIds.includes(id) && detailIds.length < 10) detailIds.push(id);
      };
      if (cacheResult.ok) {
        for (const a of cacheResult.agents) addDetailId(a.agentId);
      }
      if (agentsListResult.ok) {
        for (const a of agentsListResult.agents) addDetailId(a.agent_id);
      }
      const detailsByAgentId = new Map<string, Awaited<ReturnType<typeof fetchDetail>>>();
      if (apiKey && detailIds.length > 0) {
        await Promise.all(
          detailIds.map(async (id) => {
            detailsByAgentId.set(id, await fetchDetail(id));
          }),
        );
      }

      const agentsOut = agentsListResult.ok
        ? {
            ok: true as const,
            count: agentsListResult.agents.length,
            hasMore: agentsListResult.hasMore,
            items: agentsListResult.agents.map((a) => {
              const res = a.agent_id ? detailsByAgentId.get(a.agent_id) : undefined;
              const detail = res?.ok ? res.detail : undefined;
              return {
                agentId: a.agent_id ?? "",
                name: a.name ?? detail?.name,
                archived: detail?.archived ?? a.archived,
                createdAtUnixSecs: a.created_at_unix_secs,
                lastCallTimeUnixSecs: a.last_call_time_unix_secs,
                llm: detail?.conversation_config?.agent?.prompt?.llm,
                thinkingBudget: detail?.conversation_config?.agent?.prompt?.thinking_budget,
                ttsModelId: detail?.conversation_config?.tts?.model_id,
                ttsVoiceId: detail?.conversation_config?.tts?.voice_id,
                toolCount: detail?.conversation_config?.agent?.prompt?.tool_ids?.length,
                enableAuth: detail?.platform_settings?.auth?.enable_auth,
                postCallWebhookId: detail?.platform_settings?.workspace_overrides?.webhooks?.post_call_webhook_id,
                ...(res && !res.ok ? { detailError: res.error } : {}),
              };
            }),
          }
        : agentsListResult;

      const cacheOut = cacheResult.ok
        ? {
            ok: true as const,
            platformKeyHashPrefix: keyHash ? keyHash.slice(0, 12) : null,
            agents: cacheResult.agents.map((a) => {
              const res = detailsByAgentId.get(a.agentId);
              const detail = res?.ok ? res.detail : undefined;
              return {
                agentId: a.agentId,
                model: a.model,
                personaHash: a.personaHash,
                keyMatchesPlatform: keyHash ? a.keyHash === keyHash : false,
                createdAt: a.createdAt,
                lastUsedAt: a.lastUsedAt,
                ...(res
                  ? res.ok
                    ? {
                        remoteStatus: "ok" as const,
                        remoteArchived: detail?.archived ?? false,
                        remoteLlm: detail?.conversation_config?.agent?.prompt?.llm,
                        remoteTtsModelId: detail?.conversation_config?.tts?.model_id,
                      }
                    : {
                        remoteStatus: res.missing ? ("missing" as const) : ("error" as const),
                        remoteError: res.error,
                      }
                  : {}),
              };
            }),
            webhooks: cacheResult.webhooks.map((w) => ({
              webhookId: w.webhookId,
              keyMatchesPlatform: keyHash ? w.keyHash === keyHash : false,
              createdAt: w.createdAt,
            })),
          }
        : cacheResult;

      return {
        configured: Boolean(apiKey),
        baseUrl: base,
        publicUrl: publicBase,
        subscription: subscriptionResult,
        agents: agentsOut,
        conversations: conversationsResult,
        cache: cacheOut,
      };
    },
    async resetCache(filter?: {
      agentId?: string;
      model?: string;
      includeWebhooks?: boolean;
    }): Promise<{ deletedAgents: number; deletedWebhooks: number }> {
      return indexStub.clearElevenLabsCache(filter);
    },
  };
}
