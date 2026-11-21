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
    async provision(input: ProvisionInput): Promise<{ agentId: string; toolSecret: string }> {
      const keyHash = hash(input.apiKey);
      const personaHash = hash(input.instructions);
      const cached = await indexStub.findElevenLabsAgent({ keyHash, model: input.model, personaHash });
      if (cached) {
        return {
          agentId: cached.agentId,
          toolSecret: await openSecret(cached.sealedToolSecret, env.VAULT_SECRET),
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
      };
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
  };
}
