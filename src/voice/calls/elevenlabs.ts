import { createHash, randomBytes } from "node:crypto";
import { transaction, type Db, type Sql } from "../../db.ts";
import { elevenlabsLanguage } from "../../language.ts";
import { redactDetail } from "../../voice-providers/socket.ts";
import { ASK_AGENT, STAY_SILENT } from "./prompts.ts";

export type ElevenLabsCallsOptions = {
  db: Db;
  baseUrl?: string;
  fetch?: typeof fetch;
  publicUrl: string;
  seal(text: string): Promise<string>;
  unseal(sealed: string): Promise<string>;
};

type ProvisionInput = { apiKey: string; model: string; instructions: string; language?: string; voiceId: string };
type Provisioned = { agentId: string; toolSecret: string };
export interface ElevenLabsCalls {
  readonly models: readonly string[];
  readonly defaultModel: "gemini-3.1-flash-lite";
  readonly customVoices: true;
  readonly voices: readonly string[];
  readonly voiceFor: Readonly<Record<string, string>>;
  provision(input: ProvisionInput): Promise<Provisioned>;
  signedUrl(input: { apiKey: string; agentId: string }): Promise<{ signedUrl: string; conversationId: string }>;
  agentFor(agentId: string, sql?: Sql): Promise<{ keyHash: string; toolSecret: string } | undefined>;
  webhookSecret(keyHash: string): Promise<string | undefined>;
}

const JESSICA = "cgSgspJ2msm6clMCkdW9";
const VOICE_FOR: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(
    ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar", "nova", "onyx", "fable"].map(name => [name, JESSICA]),
  ),
));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const ELEVENLABS_INBOUND = "/v1/voice/providers/elevenlabs";

export function elevenlabsCalls(options: ElevenLabsCallsOptions): ElevenLabsCalls {
  const base = (options.baseUrl ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
  const inbound = options.publicUrl.replace(/\/+$/, "") + ELEVENLABS_INBOUND;
  const request = options.fetch ?? fetch;
  const agents = new Map<string, Promise<Provisioned>>();

  async function api(apiKey: string, stage: string, path: string, body?: unknown, method?: string) {
    try {
      const response = await request(base + path, {
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), ...(method ? { method } : {}),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      return response.status === 204 ? undefined : await response.json();
    } catch (error) {
      const secret = (body as { tool_config?: { api_schema: { request_headers: Record<string, string> } } } | undefined)
        ?.tool_config?.api_schema.request_headers["X-Voice-Tool-Secret"];
      throw new Error(`ElevenLabs ${stage}: ${redactDetail(error instanceof Error ? error.message : String(error), 250, secret ? [apiKey, secret] : [apiKey])}`);
    }
  }

  function webhook(apiKey: string, keyHash: string): Promise<string> {
    return transaction(options.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`elevenlabs-call-webhook:${keyHash}`]);
      const { rows } = await sql.query<{ webhook_id: string }>("select webhook_id from elevenlabs_call_webhooks where key_hash = $1", [keyHash]);
      if (rows[0]) return rows[0].webhook_id;
      const created = await api(apiKey, "register webhook", "/v1/workspace/webhooks", {
        settings: { name: "camelRun voice calls", webhook_url: `${inbound}/post-call`, auth_type: "hmac" },
      });
      if (!created?.webhook_secret) throw new Error("ElevenLabs returned no webhook secret");
      if (!created.webhook_id) throw new Error("ElevenLabs returned no webhook id");
      await sql.query("insert into elevenlabs_call_webhooks (key_hash, webhook_id, secret) values ($1, $2, $3)",
        [keyHash, created.webhook_id, await options.seal(created.webhook_secret)]);
      return created.webhook_id as string;
    }, { rerun: false });
  }

  async function findAgent(sql: Sql, identity: string[]) {
    return (await sql.query<{ agent_id: string; tool_secret: string }>(`update elevenlabs_call_agents set last_used_at = now()
      where key_hash = $1 and model = $2 and persona_hash = $3 returning agent_id, tool_secret`, identity)).rows[0];
  }

  async function provision(input: ProvisionInput, keyHash: string, personaHash: string) {
    const { apiKey, model, instructions, language, voiceId } = input;
    const identity = [keyHash, model, personaHash];
    const cached = await findAgent(options.db, identity);
    if (cached) return { agentId: cached.agent_id, toolSecret: await options.unseal(cached.tool_secret) };
    const webhookId = await webhook(apiKey, keyHash);
    return transaction(options.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`elevenlabs-call-agent:${JSON.stringify(identity)}`]);
      const existing = await findAgent(sql, identity);
      if (existing) return { agentId: existing.agent_id, toolSecret: await options.unseal(existing.tool_secret) };
      const toolSecret = randomBytes(24).toString("base64url");
      const toolIds = [];
      for (const tool of [ASK_AGENT, STAY_SILENT]) {
        const ask = tool === ASK_AGENT;
        const created = await api(apiKey, `create ${tool.name} tool`, "/v1/convai/tools", { tool_config: {
          type: "webhook", name: tool.name, description: tool.description,
          api_schema: {
            url: `${inbound}/tools/${tool.name}`, method: "POST", content_type: "application/json",
            request_headers: { "X-Voice-Tool-Secret": toolSecret },
            request_body_schema: {
              type: "object", required: ask ? ["request", "conversation_id"] : ["conversation_id"],
              properties: { ...(ask ? { request: (ASK_AGENT.parameters.properties as Record<string, unknown>).request } : {}), conversation_id: { type: "string", dynamic_variable: "system__conversation_id" } },
            },
          },
          response_timeout_secs: 60, pre_tool_speech: ask ? "force" : "off", execution_mode: "immediate",
        } });
        if (!created?.id) throw new Error(`ElevenLabs returned no ${tool.name} tool id`);
        toolIds.push(created.id);
      }
      const created = await api(apiKey, "create agent", "/v1/convai/agents/create", {
        name: `camelRun voice ${model} ${personaHash.slice(0, 8)}`,
        conversation_config: {
          agent: { first_message: "", language: elevenlabsLanguage(language) ?? "en", prompt: {
            prompt: instructions, llm: model, temperature: 0.3, tool_ids: toolIds,
            ...((model === "gemini-2.5-flash-lite" || model === "gemini-3.1-flash-lite") ? { thinking_budget: 0 } : {}),
          } },
          asr: { user_input_audio_format: "pcm_16000" },
          tts: { voice_id: VOICE_FOR[voiceId] ?? voiceId, model_id: "eleven_v4_turbo", agent_output_audio_format: "pcm_24000" },
          turn: { turn_eagerness: "normal", turn_timeout: 7, silence_end_call_timeout: -1 },
          conversation: { max_duration_seconds: 1800, client_events: ["conversation_initiation_metadata", "ping", "audio", "interruption", "user_transcript", "agent_response", "agent_response_complete", "client_error"] },
        },
        platform_settings: {
          auth: { enable_auth: true }, privacy: { record_voice: false },
          overrides: { conversation_config_override: { tts: { voice_id: true }, agent: { language: true } } },
          workspace_overrides: { webhooks: { post_call_webhook_id: webhookId, events: ["transcript", "call_initiation_failure"], send_audio: false } },
        },
      });
      if (!created?.agent_id) throw new Error("ElevenLabs returned no agent id");
      await sql.query("insert into elevenlabs_call_agents (key_hash, model, persona_hash, agent_id, tool_secret) values ($1, $2, $3, $4, $5)",
        [...identity, created.agent_id, await options.seal(toolSecret)]);
      return { agentId: created.agent_id as string, toolSecret };
    }, { rerun: false });
  }

  return {
    models: [], defaultModel: "gemini-3.1-flash-lite", voices: [JESSICA], voiceFor: VOICE_FOR, customVoices: true,
    provision(input) {
      const keyHash = hash(input.apiKey), personaHash = hash(input.instructions);
      const identity = JSON.stringify([keyHash, input.model, personaHash]);
      let pending = agents.get(identity);
      if (!pending) {
        pending = provision(input, keyHash, personaHash).finally(() => agents.delete(identity));
        agents.set(identity, pending);
      }
      return pending;
    },
    async signedUrl({ apiKey, agentId }) {
      const query = new URLSearchParams({ agent_id: agentId, include_conversation_id: "true" });
      const result = await api(apiKey, "signed URL", `/v1/convai/conversation/get-signed-url?${query}`);
      if (typeof result?.signed_url !== "string") throw new Error("ElevenLabs returned no signed URL");
      let conversationId = result.conversation_id;
      if (typeof conversationId !== "string" || !conversationId) {
        // Do not include a signed URL in an error.
        try { conversationId = new URL(result.signed_url).searchParams.get("conversation_id"); }
        catch { throw new Error("ElevenLabs returned an invalid signed URL"); }
      }
      if (!conversationId) throw new Error("ElevenLabs returned no conversation id");
      return { signedUrl: result.signed_url, conversationId };
    },
    async agentFor(agentId, sql = options.db) {
      const { rows } = await sql.query<{ key_hash: string; tool_secret: string }>(
        "select key_hash, tool_secret from elevenlabs_call_agents where agent_id = $1", [agentId]);
      const row = rows[0];
      if (row) return { keyHash: row.key_hash, toolSecret: await options.unseal(row.tool_secret) };
    },
    async webhookSecret(keyHash) {
      const { rows } = await options.db.query<{ secret: string }>("select secret from elevenlabs_call_webhooks where key_hash = $1", [keyHash]);
      if (rows[0]) return options.unseal(rows[0].secret);
    },
  };
}
