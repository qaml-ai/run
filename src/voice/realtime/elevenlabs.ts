import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { closeDetail, redactDetail, messageJson, openSocket, type Socket, type SocketFactory } from "../../voice-providers/socket.ts";
import { Resampler24To16 } from "../turns/features.ts";
import { ASK_AGENT, STAY_SILENT } from "./brain.ts";
import { NO_USAGE, type RealtimeConfig, type RealtimeConnection, type RealtimeEvents, type RealtimeProvider } from "./provider.ts";

/**
 * ElevenLabs Agents, a thin voice front-end: the built-in LLM delegates work to our CLIENT tools on the same socket.
 * Protocol and provisioning (2026-10-19):
 * https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket
 * https://elevenlabs.io/docs/api-reference/agents/create
 * https://elevenlabs.io/docs/api-reference/agents/list
 * https://elevenlabs.io/docs/api-reference/conversations/get-signed-url
 * https://elevenlabs.io/docs/eleven-agents/customization/personalization/overrides
 *
 * Private agents use a fresh signed URL per connection, obtained with xi-api-key over HTTPS. The key is never put in
 * the WebSocket URL. ElevenLabs owns VAD, turns and interruptions; commit/discard cannot take back streamed audio.
 * Speaker labels are contextual_update notes around the mixed stream, not diarization: overlapping speakers cannot
 * be attributed reliably. Input is resampled to PCM 16 kHz; output is configured as PCM 24 kHz for the player.
 * Agents sends no token usage here: NO_USAGE means unknown, not free service.
 */
export const ELEVENLABS_AGENTS = Object.freeze({
  models: ["gemini-2.5-flash-lite"] as const,
  defaultModel: "gemini-2.5-flash-lite",
  voice: "cgSgspJ2msm6clMCkdW9", // Jessica, a conversational default; sessions may supply any voice_id their key can use.
  name: "camelRun realtime voice v1",
  connectTimeoutMs: 20_000,
});
const VOICE_FOR = Object.freeze(Object.fromEntries(
  ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar", "nova", "onyx", "fable"].map(name => [name, ELEVENLABS_AGENTS.voice]),
));

export function elevenlabsAgents(options: { baseUrl?: string; socket?: SocketFactory; fetch?: typeof fetch; now?: () => number } = {}): RealtimeProvider {
  const base = (options.baseUrl ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
  const request = options.fetch ?? fetch;
  const socket = options.socket ?? openSocket;
  // Per node lifetime, one single-flight resolution per credential (platform or tenant). No TTL or raw keys retained.
  const agents = new Map<string, Promise<string>>();
  const voices = new Map<string, Promise<string>>();
  async function api(apiKey: string, stage: string, path: string, body?: unknown) {
    try {
      const response = await request(`${base}${path}`, {
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(ELEVENLABS_AGENTS.connectTimeoutMs),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => undefined);
        const detail = error?.detail;
        const message = Array.isArray(detail)
          ? detail.map(item => `${Array.isArray(item.loc) ? item.loc.join(".") : "validation"}: ${item.msg ?? "invalid value"}`).join("; ")
          : typeof detail === "string" ? detail : [detail?.status, detail?.message].filter(value => typeof value === "string").join(": ");
        throw new ElevenLabsFailure(stage, message || "request failed", response.status >= 500, response.status);
      }
      return await response.json();
    } catch (error) {
      const failure = error instanceof ElevenLabsFailure ? error : new ElevenLabsFailure(stage, error instanceof Error ? error.message : "network error", error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)));
      failure.message = redactDetail(failure.message, 300, [apiKey]);
      throw failure;
    }
  }
  async function accountVoice(apiKey: string, voice: string): Promise<string | undefined> {
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: "100", ...(token ? { next_page_token: token } : {}) });
      const page = await api(apiKey, "list voices", `/v2/voices?${query}`);
      const found = page.voices?.find((item: any) => item.voice_id === voice || item.sharing?.original_voice_id === voice);
      if (typeof found?.voice_id === "string") return found.voice_id;
      token = page.has_more ? page.next_page_token : undefined;
      if (page.has_more && !token) throw new ElevenLabsFailure("list voices", "no next page token", false);
    } while (token);
  }
  async function resolveVoice(apiKey: string, voice: string): Promise<string> {
    const owned = await accountVoice(apiKey, voice);
    if (owned) return owned;
    let page = 0;
    do {
      const query = new URLSearchParams({ search: voice, page_size: "100", page: String(page++) });
      const shared = await api(apiKey, "find shared voice", `/v1/shared-voices?${query}`);
      const found = shared.voices?.find((item: any) => item.voice_id === voice);
      if (typeof found?.public_owner_id === "string") {
        try {
          const added = await api(apiKey, "add shared voice", `/v1/voices/add/${encodeURIComponent(found.public_owner_id)}/${encodeURIComponent(voice)}`, { new_name: found.name || voice });
          if (typeof added.voice_id !== "string") throw new ElevenLabsFailure("add shared voice", "no voice id returned", false);
          return added.voice_id;
        } catch (error) {
          // Another node may have added this voice after our account lookup.
          if (error instanceof ElevenLabsFailure && error.status === 409) {
            const added = await accountVoice(apiKey, voice);
            if (added) return added;
          }
          throw error;
        }
      }
      if (!shared.has_more) break;
    } while (true);
    throw new ElevenLabsFailure("find shared voice", "voice is unavailable to this account and was not found in the shared library", false);
  }
  function ensureVoice(apiKey: string, voice: string) {
    const identity = `${createHash("sha256").update(apiKey).digest("hex")}:${voice}`;
    let pending = voices.get(identity);
    if (!pending) {
      pending = resolveVoice(apiKey, voice);
      voices.set(identity, pending);
      void pending.catch(() => voices.delete(identity));
    }
    return pending;
  }
  async function resolveAgent(apiKey: string, sessionVoice: string): Promise<string> {
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ search: ELEVENLABS_AGENTS.name, page_size: "100", ...(cursor ? { cursor } : {}) });
      const page = await api(apiKey, "list agents", `/v1/convai/agents?${query}`);
      const found = page.agents?.find((agent: any) => agent.name === ELEVENLABS_AGENTS.name);
      if (typeof found?.agent_id === "string") return found.agent_id;
      cursor = page.has_more ? page.next_cursor : undefined;
      if (page.has_more && !cursor) throw new ElevenLabsFailure("list agents", "no next cursor", false);
    } while (cursor);
    const voice = await ensureVoice(apiKey, sessionVoice);
    const created = await api(apiKey, "create agent", "/v1/convai/agents/create", {
      name: ELEVENLABS_AGENTS.name,
      conversation_config: {
        agent: { first_message: "", language: "en", prompt: {
          prompt: "You are the bot's voice. Delegate anything beyond small talk to ask_agent.",
          llm: ELEVENLABS_AGENTS.defaultModel, temperature: 0.3,
          tools: [ASK_AGENT, STAY_SILENT].map(tool => ({ ...tool, type: "client", expects_response: true,
            response_timeout_secs: 60, interruption_mode: "allow", pre_tool_speech: tool.name === ASK_AGENT.name ? "force" : "off" })),
        } },
        asr: { user_input_audio_format: "pcm_16000" },
        tts: { voice_id: voice, model_id: "eleven_flash_v2_5", agent_output_audio_format: "pcm_24000" },
        turn: { turn_eagerness: "normal", turn_timeout: 7, silence_end_call_timeout: -1 },
        conversation: { client_events: ["conversation_initiation_metadata", "ping", "audio", "interruption", "user_transcript", "agent_response", "client_tool_call", "agent_response_complete", "client_error"] },
      },
      platform_settings: {
        auth: { enable_auth: true }, privacy: { record_voice: false },
        overrides: { conversation_config_override: { agent: { prompt: { prompt: true }, first_message: true, language: true }, tts: { voice_id: true } } },
      },
    });
    if (typeof created.agent_id !== "string") throw new ElevenLabsFailure("create agent", "no agent id returned", false);
    return created.agent_id;
  }
  return {
    id: "elevenlabs", key: "elevenlabs", models: ELEVENLABS_AGENTS.models, defaultModel: ELEVENLABS_AGENTS.defaultModel,
    voices: [ELEVENLABS_AGENTS.voice], voiceFor: VOICE_FOR, customVoices: true, ownsTurns: true,
    connect(config, { apiKey }, events) {
      const identity = createHash("sha256").update(apiKey).digest("hex");
      let agent = agents.get(identity);
      if (!agent) {
        agent = resolveAgent(apiKey, config.voice);
        agents.set(identity, agent);
        void agent.catch(() => agents.delete(identity));
      }
      return new ElevenLabs(events, options.now ?? (() => performance.now()), async () => {
        const agentId = await agent;
        config = { ...config, voice: await ensureVoice(apiKey, config.voice) };
        const signed = await api(apiKey, "signed URL", `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
        if (typeof signed.signed_url !== "string") throw new ElevenLabsFailure("signed URL", "no signed URL returned", false);
        try { return { socket: socket(signed.signed_url, {}), config }; }
        catch { throw new ElevenLabsFailure("websocket open", "could not create socket", false); }
      }, detail => redactDetail(detail, 300, [apiKey]));
    },
  };
}

class ElevenLabsFailure extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(stage: string, detail: string, retryable: boolean, status?: number) {
    super(`ElevenLabs Agents ${stage}${status ? ` (HTTP ${status})` : ""}: ${detail}`);
    this.retryable = retryable;
    this.status = status;
  }
}

class ElevenLabs implements RealtimeConnection {
  private socket?: Socket;
  private readonly events: RealtimeEvents;
  private ended = false;
  private ready = false;
  private queue: string[] = [];
  private bytes = 0;
  private current?: string;
  private responses = 0;
  private lastAppend = 0;
  private meteredAt?: number;
  private readonly now: () => number;
  private readonly resampler = new Resampler24To16();
  private timer?: ReturnType<typeof setTimeout>;
  private silence?: ReturnType<typeof setInterval>;
  private readonly calls = new Map<string, string>();
  private suppressed = false;
  private stage = "provisioning";
  private readonly redact: (detail: string) => string;

  constructor(events: RealtimeEvents, now: () => number, connect: () => Promise<{ socket: Socket; config: RealtimeConfig }>, redact: (detail: string) => string) {
    this.events = events;
    this.redact = redact;
    this.now = now;
    void connect().then(({ socket, config }) => {
      if (this.ended) { socket.close(); return; }
      this.socket = socket;
      this.stage = "websocket open";
      this.timer = setTimeout(() => this.fail(`ElevenLabs Agents ${this.stage}: timed out`), ELEVENLABS_AGENTS.connectTimeoutMs);
      this.timer.unref?.();
      socket.onopen = () => {
        this.meteredAt = this.now();
        this.stage = "init";
        try { socket.send(JSON.stringify({ type: "conversation_initiation_client_data", conversation_config_override: {
          agent: { prompt: { prompt: config.instructions }, first_message: "", language: config.language ?? "en" }, tts: { voice_id: config.voice },
        } })); } catch { this.fail("ElevenLabs Agents init: could not send client data", false); }
      };
      socket.onmessage = event => this.message(messageJson(event.data));
      socket.onerror = () => this.fail(`ElevenLabs Agents ${this.stage}: connection failed`);
      socket.onclose = event => this.fail(`ElevenLabs Agents ${this.stage}: ${closeDetail({ code: event?.code, reason: this.redact(event?.reason ?? "") })}`, !event?.code || ![1000, 1008].includes(event.code));
    }).catch(error => this.fail(error instanceof ElevenLabsFailure ? error.message : "ElevenLabs Agents provisioning: unexpected failure", error instanceof ElevenLabsFailure ? error.retryable : false));
  }

  get pendingMs() { return this.bytes / 48; }
  append(pcm: Uint8Array) {
    if (this.ended || !pcm.byteLength) return;
    this.bytes += pcm.byteLength;
    this.lastAppend = Date.now();
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const samples = new Int16Array(pcm.byteLength >> 1);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
    const out = this.resampler.push(samples);
    const audio = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) audio.writeInt16LE(out[i], i * 2);
    this.send({ user_audio_chunk: audio.toString("base64") });
  }
  /** Local bookkeeping only: ElevenLabs commits on its own VAD. */
  commit(_tag: string) { return false; }
  discard() { /* Streamed audio cannot be withdrawn. */ }
  note(text: string) { this.send({ type: "contextual_update", text }); }
  respond(options: { instructions?: string } = {}) {
    // Tool results continue the turn automatically. A late reply needs a new user_message to start a turn.
    if (options.instructions) this.send({ type: "user_message", text: `[${options.instructions}]` });
  }
  cancel() { this.suppressed = true; this.finish("cancelled"); }
  truncate(_response: string, heardMs: number) { this.note(`[You were cut off after ${Math.round(heardMs / 1_000)} seconds of playback.]`); }
  toolResult(callId: string, output: string) {
    const name = this.calls.get(callId);
    if (!this.calls.delete(callId)) return;
    let isError = false;
    try { isError = !!JSON.parse(output).error; } catch { /* plain text result */ }
    this.suppressed = name === "stay_silent";
    this.send({ type: "client_tool_result", tool_call_id: callId, result: output, is_error: isError });
  }
  close() { this.end("requested"); }

  private send(event: unknown) {
    if (this.ended) return;
    const message = JSON.stringify(event);
    if (this.ready) this.socket!.send(message);
    else if (this.queue.length < 500) this.queue.push(message);
    else this.fail("ElevenLabs Agents input queue overflow");
  }
  private fail(detail: string, retryable = true) { this.end("error", this.redact(detail), retryable); }
  private end(reason: "requested" | "error", detail?: string, retryable = true) {
    if (this.ended) return;
    this.meter();
    this.ended = true;
    clearTimeout(this.timer);
    clearInterval(this.silence);
    this.queue = [];
    try { this.socket?.close(); } catch { /* closed already */ }
    this.events.closed(reason, detail, { retryable });
  }
  private meter() {
    if (this.meteredAt === undefined) return;
    const now = this.now();
    const seconds = Math.max(0, now - this.meteredAt) / 1_000;
    this.meteredAt = now;
    if (seconds) this.events.meter?.(seconds, 0);
  }
  private start() {
    if (!this.current) { this.current = `elevenlabs_${++this.responses}`; this.events.responseStarted(this.current); }
    return this.current;
  }
  private finish(status: "completed" | "cancelled") {
    const id = this.current;
    this.current = undefined;
    if (id) this.events.responseDone(id, { status, usage: { ...NO_USAGE } });
  }
  private message(event: any) {
    if (!event || this.ended) return;
    switch (event.type) {
      case "conversation_initiation_metadata": {
        const metadata = event.conversation_initiation_metadata_event;
        if (metadata?.user_input_audio_format !== "pcm_16000" || metadata?.agent_output_audio_format !== "pcm_24000") {
          this.fail("ElevenLabs Agents init: negotiated an unsupported audio format", false); return;
        }
        if (this.ready) return;
        this.ready = true;
        this.stage = "session";
        clearTimeout(this.timer);
        for (const message of this.queue.splice(0)) this.socket!.send(message);
        // Discord streams stop at silence. Keep the provider's VAD clock running between speakers' packets.
        this.silence = setInterval(() => {
          this.meter();
          if (Date.now() - this.lastAppend >= 40) this.send({ user_audio_chunk: Buffer.alloc(640).toString("base64") });
        }, 20);
        this.silence.unref?.();
        this.events.ready();
        break;
      }
      case "ping": this.socket?.send(JSON.stringify({ type: "pong", event_id: event.ping_event?.event_id })); break;
      case "user_transcript": {
        const seconds = this.bytes / 48 / 1_000;
        this.bytes = 0;
        this.suppressed = false;
        if (typeof event.user_transcription_event?.user_transcript === "string") this.events.heard("", event.user_transcription_event.user_transcript, seconds);
        break;
      }
      case "agent_response":
        if (this.suppressed) break;
        if (typeof event.agent_response_event?.agent_response === "string") this.events.said(this.start(), event.agent_response_event.agent_response);
        break;
      case "audio":
        if (this.suppressed) break;
        if (typeof event.audio_event?.audio_base_64 === "string") this.events.audio(this.start(), Buffer.from(event.audio_event.audio_base_64, "base64"));
        break;
      case "agent_response_complete": this.finish("completed"); break;
      case "interruption": this.suppressed = true; this.events.interrupted?.(); this.finish("cancelled"); break;
      case "client_tool_call": {
        const call = event.client_tool_call;
        if (typeof call?.tool_call_id !== "string" || this.calls.has(call.tool_call_id)) return;
        this.calls.set(call.tool_call_id, String(call.tool_name ?? ""));
        const response = this.start();
        this.events.toolCall({ response, id: call.tool_call_id, name: String(call.tool_name ?? ""), args: call.parameters ?? {} });
        this.finish("completed");
        break;
      }
      case "client_error": this.fail(`ElevenLabs Agents ${this.stage}: ${closeDetail({ code: event.error_event?.code, reason: this.redact(String(event.error_event?.message ?? event.error_event?.error_name ?? "")) })}`, event.error_event?.code >= 500); break;
    }
  }
}
