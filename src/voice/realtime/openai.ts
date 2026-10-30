import { openaiTranscriptionLanguage } from "../../language.ts";
import { closeDetail, messageJson, openSocket, wsBase, type Socket, type SocketFactory } from "../../voice-providers/socket.ts";
import { NO_USAGE, REALTIME_TRANSCRIPTION, type AzureRealtime, type RealtimeConfig, type RealtimeConnection, type RealtimeEvents, type RealtimeProvider, type RealtimeUsage } from "./provider.ts";

/**
 * OpenAI's Realtime API (GA) over a WebSocket, server to server: `wss://api.openai.com/v1/realtime?model=…`, the
 * tenant's OpenAI key (else the platform's) as a bearer token. Turn detection is off (`turn_detection: null`): the
 * brain commits each turn and asks for each response. WebRTC buys a browser jitter buffer and echo cancellation, which
 * a server holding Discord's decoded streams has no use for, so it is not used.
 *
 * Events used (developers.openai.com/api/docs/guides/realtime-conversations): input_audio_buffer.append / commit /
 * clear, conversation.item.create (input_text, function_call_output), conversation.item.truncate / delete,
 * response.create / cancel; and back response.created, response.output_item.added, response.output_audio.delta,
 * response.output_audio_transcript.delta, response.function_call_arguments.done, response.done (its usage),
 * input_audio_buffer.committed, conversation.item.input_audio_transcription.completed, error.
 *
 * On the platform's key, a session connects to the platform's Azure OpenAI deployment first (credentials.azure,
 * azure-openai.ts): Azure's GA realtime endpoint, `wss://<resource>/openai/v1/realtime?model=<deployment>`, with the key
 * as the `api-key` header (learn.microsoft.com/azure/foundry/openai/how-to/realtime-audio-websockets, "Connection and
 * authentication"). Its events are OpenAI's GA ones (the same session.update, audio formats, function calls and
 * response events; learn.microsoft.com/azure/foundry/openai/realtime-audio-reference), except that the input
 * transcription's `model` names a deployment, so the session names the transcription deployment there, and the
 * session's `model` its realtime deployment. A session that needs transcripts with no transcription deployment stays on
 * OpenAI. When Azure refuses the handshake (a 429, a 5xx, a deployment missing: Node's WebSocket reports each as an
 * error), answers session.update with an error, or is not live within azureConnectTimeoutMs, the connection goes on
 * on OpenAI with the platform's key, the session and everything sent so far sent again (`fallback`, logged as
 * voice_realtime_azure_fallback). Once live, a drop is the brain's to handle: it reconnects, which tries Azure first again.
 *
 * The session's language goes to the input transcription only as the provider takes it (`language`): one it does not
 * take is left out, so transcription detects it. One refused anyway (invalid_value naming it) is dropped and the
 * session sent again without it, on the same host: a language hint never fails a call.
 */

export const OPENAI_REALTIME = Object.freeze({
  models: ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const,
  defaultModel: "gpt-realtime-2.1",
  /** The voices the realtime models speak in; marin and cedar are OpenAI's recommended ones. */
  voices: ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"] as const,
  /** The least input a commit may hold (OpenAI refuses less than 100 ms). */
  minCommitMs: 100,
  connectTimeoutMs: 10_000,
  /** How long Azure has to be live before the session goes to OpenAI instead (which then has connectTimeoutMs). */
  azureConnectTimeoutMs: 5_000,
});

/** PCM bytes per ms: 24 kHz, 16-bit mono. */
const BYTES_PER_MS = 48;
/** Errors that say a race was lost, not that something is wrong: a cancel after the response ended, a truncate past it. */
const BENIGN = new Set(["response_cancel_not_active"]);

export function openaiRealtime(options: { baseUrl?: string; socket?: SocketFactory } = {}): RealtimeProvider {
  return openaiCompatibleRealtime({
    id: "openai", key: "openai",
    models: OPENAI_REALTIME.models, defaultModel: OPENAI_REALTIME.defaultModel, voices: OPENAI_REALTIME.voices,
  }, { ...options, baseUrl: options.baseUrl ?? "https://api.openai.com/v1", azure: true, language: openaiTranscriptionLanguage });
}

type RealtimeProtocol = {
  session?: (config: RealtimeConfig) => unknown;
  legacyAudioEvents?: boolean;
  /** Input transcripts are included in the voice service, without a separate transcription charge. */
  nativeTranscription?: boolean;
  /** Report audio duration and text input items instead of relying on response tokens for pricing. */
  metered?: boolean;
  redact?: (text: string) => string;
  /** Connect to the platform's Azure deployment first, where the credentials name one (OpenAI's models only). */
  azure?: boolean;
  /** The session's language as the provider's transcription takes it, or undefined where it takes none. */
  language: (tag: string | undefined) => string | undefined;
};

/**
 * A host the connection may open on: its address and headers, and the session it is configured with (and the same
 * session without its language, to send instead when the language is refused).
 */
type Target = { host: string; url: string; headers: Record<string, string>; session: string; bare?: string; timeoutMs: number };

/** The OpenAI wire protocol, with a provider's session fields and optional older audio event names. */
export function openaiCompatibleRealtime(
  provider: Omit<RealtimeProvider, "connect">,
  options: RealtimeProtocol & { baseUrl: string; socket?: SocketFactory },
): RealtimeProvider {
  const socket = options.socket ?? openSocket;
  return {
    ...provider,
    connect(config, credentials, events) {
      const language = config.transcribe ? options.language(config.language) : undefined;
      if (config.transcribe && config.language && !language) events.language?.(`'${config.language}' is not a language ${provider.id} transcription takes: it detects the language instead`);
      const configured = { ...config, language };
      const message = (config: RealtimeConfig, model: string, transcription?: string) => JSON.stringify({ type: "session.update", session: options.session ? options.session(config) : openaiSession({ ...config, model }, transcription) });
      const session = (model: string, transcription?: string) => ({
        session: message(configured, model, transcription),
        ...language ? { bare: message({ ...configured, language: undefined }, model, transcription) } : {},
      });
      const own: Target = {
        host: provider.id, url: `${wsBase(options.baseUrl)}/realtime?model=${encodeURIComponent(config.model)}`,
        headers: { Authorization: `Bearer ${credentials.apiKey}` }, ...session(config.model), timeoutMs: OPENAI_REALTIME.connectTimeoutMs,
      };
      const azure = options.azure ? azureTarget(config, credentials.azure, session) : undefined;
      return new OpenAIRealtime(socket, azure ? [azure, own] : [own], configured, events, options);
    },
  };
}

/** The platform's Azure deployment, where a session may go there (a transcribed one needs a transcription deployment). */
function azureTarget(config: RealtimeConfig, azure: AzureRealtime | undefined, session: (model: string, transcription?: string) => { session: string; bare?: string }): Target | undefined {
  if (!azure || (config.transcribe && !azure.transcriptionDeployment)) return undefined;
  return {
    host: "azure", url: `${wsBase(azure.endpoint)}/openai/v1/realtime?model=${encodeURIComponent(azure.deployment)}`,
    headers: { "api-key": azure.apiKey }, ...session(azure.deployment, azure.transcriptionDeployment), timeoutMs: OPENAI_REALTIME.azureConnectTimeoutMs,
  };
}

class OpenAIRealtime implements RealtimeConnection {
  private readonly dial: SocketFactory;
  /** Where to connect, in order: the first, then each next one if the one before fails before it is live. */
  private readonly targets: Target[];
  private socket!: Socket;
  private readonly events: RealtimeEvents;
  private readonly instructions: string;
  private readonly legacyAudioEvents: boolean;
  private readonly redact: (text: string) => string;
  private readonly metered: boolean;
  /** The language the session's transcription was given, until a host refuses it. */
  private language: string | undefined;
  private open = false;
  private ready = false;
  private ended = false;
  private readonly queue: string[] = [];
  /** Everything sent before the session is live, to send again to the next host if this one fails first. */
  private early: string[] | undefined = [];
  private bytes = 0;
  /** Commits sent and not yet named by OpenAI (`input_audio_buffer.committed`), oldest first, by tag. */
  private readonly committing: string[] = [];
  /** Committed items' tags, by item id, until their transcripts come. */
  private readonly tags = new Map<string, string>();
  /** The response being made, and the audio item of the last response that had one. */
  private active?: string;
  /** Each response's audio item, by response id (the last few). */
  private readonly audioItems = new Map<string, string>();
  /** Responses asked for and not yet begun; a cancel that comes first is sent as the response begins. */
  private asked = 0;
  private cancelOnCreate = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(dial: SocketFactory, targets: Target[], config: RealtimeConfig, events: RealtimeEvents, options: RealtimeProtocol) {
    this.dial = dial;
    this.targets = targets;
    this.events = options.nativeTranscription ? {
      ...events, heard: (tag, text) => { if (config.transcribe) events.heard(tag, text, 0); },
    } : events;
    this.metered = options.metered ?? false;
    this.language = config.language;
    this.instructions = config.instructions;
    this.redact = options.redact ?? (text => text);
    this.legacyAudioEvents = options.legacyAudioEvents ?? false;
    if (targets.length < 2) this.early = undefined;
    this.connectTo(targets[0]!);
  }

  get host() { return this.targets[0]!.host; }

  /** Open the socket to `target`: its session first, then what was sent before (on a fallback). */
  private connectTo(target: Target) {
    this.open = false;
    this.queue.splice(0, this.queue.length, target.session, ...this.early ?? []);
    const socket = this.socket = this.dial(target.url, target.headers);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (!this.ready) this.fail("The realtime connection did not open in time"); }, target.timeoutMs);
    this.timer.unref?.();
    // A socket given up on (a fallback) says nothing more.
    const current = () => this.socket === socket;
    socket.onopen = () => {
      if (!current()) return;
      this.open = true;
      for (const message of this.queue.splice(0)) this.transmit(message);
    };
    socket.onmessage = event => { if (current()) this.message(messageJson(event.data)); };
    socket.onerror = () => { if (current()) this.fail("The realtime connection failed"); };
    socket.onclose = event => { if (current()) this.fail(closeDetail(event)); };
  }

  get pendingMs() { return this.bytes / BYTES_PER_MS; }

  append(pcm: Uint8Array) {
    if (this.ended || !pcm.byteLength) return;
    this.bytes += pcm.byteLength;
    this.send({ type: "input_audio_buffer.append", audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
  }

  commit(tag: string) {
    if (this.ended || !this.bytes) return false;
    if (this.pendingMs < OPENAI_REALTIME.minCommitMs) { this.discard(); return false; }
    this.bytes = 0;
    this.committing.push(tag);
    this.send({ type: "input_audio_buffer.commit" });
    return true;
  }

  discard() {
    if (this.ended || !this.bytes) return;
    this.bytes = 0;
    this.send({ type: "input_audio_buffer.clear" });
  }

  note(text: string) {
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  }

  respond(options: { instructions?: string } = {}) {
    this.asked++;
    this.send({ type: "response.create", ...(options.instructions ? { response: { instructions: `${this.instructions}\n\n${options.instructions}` } } : {}) });
  }

  cancel() {
    if (this.active) this.send({ type: "response.cancel" });
    else if (this.asked) this.cancelOnCreate = true;
  }

  truncate(response: string, heardMs: number) {
    const item = this.audioItems.get(response);
    if (!item) return;
    if (heardMs <= 0) {
      this.send({ type: "conversation.item.delete", item_id: item });
      this.audioItems.delete(response);
    } else this.send({ type: "conversation.item.truncate", item_id: item, content_index: 0, audio_end_ms: Math.round(heardMs) });
  }

  toolResult(callId: string, output: string) {
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
  }

  close() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    try { this.socket.close(); } catch { /* closed already */ }
    this.events.closed("requested");
  }

  private audioItem(response: string, item: string) {
    this.audioItems.set(response, item);
    while (this.audioItems.size > 8) this.audioItems.delete(this.audioItems.keys().next().value!);
  }

  private send(message: unknown) {
    if (this.ended) return;
    const data = JSON.stringify(message);
    // Kept only while there is a host to fall back on.
    this.early?.push(data);
    if (this.open) this.transmit(data);
    else this.queue.push(data);
  }

  private transmit(data: string) {
    this.socket.send(data);
    if (!this.metered) return;
    const message = JSON.parse(data);
    if (message.type === "input_audio_buffer.append") this.events.meter?.(Buffer.byteLength(message.audio, "base64") / 48_000, 0);
    if (message.type === "conversation.item.create" && message.item.type === "message") this.events.meter?.(0, 1);
  }

  private fail(detail: string) {
    if (this.ended) return;
    // Not live yet, with a host after this one (Azure, then OpenAI): go on there, telling no one but the log.
    if (!this.ready && this.targets.length > 1) {
      this.targets.shift();
      const socket = this.socket;
      this.events.fallback?.(this.redact(detail).slice(0, 300));
      this.connectTo(this.targets[0]!);
      if (this.targets.length < 2) this.early = undefined;
      try { socket.close(); } catch { /* closed already */ }
      return;
    }
    this.ended = true;
    clearTimeout(this.timer);
    try { this.socket.close(); } catch { /* closed already */ }
    this.events.closed("error", detail);
  }

  /** An error that refuses the transcription's language: invalid_value on its field, or naming the language sent. */
  private refusesLanguage(code: string, param: string, message: string) {
    if (!this.language || !this.targets[0]!.bare) return false;
    return param.endsWith("language") || (code === "invalid_value" && message.includes(`'${this.language}'`));
  }

  private message(event: any) {
    if (!event || typeof event.type !== "string" || this.ended) return;
    // Azure documents both families of audio event names (its samples use the older ones too): either is taken there.
    const type = this.legacyAudioEvents || this.host === "azure" ? ({ "response.audio.delta": "response.output_audio.delta", "response.audio_transcript.delta": "response.output_audio_transcript.delta" } as Record<string, string>)[event.type] ?? event.type : event.type;
    switch (type) {
      case "session.updated":
        if (!this.ready) { this.ready = true; this.early = undefined; clearTimeout(this.timer); this.events.ready(); }
        return;
      case "response.created":
        this.asked = Math.max(0, this.asked - 1);
        this.active = event.response?.id;
        if (!this.active) return;
        this.events.responseStarted(this.active);
        if (this.cancelOnCreate) { this.cancelOnCreate = false; this.send({ type: "response.cancel" }); }
        return;
      case "response.output_item.added":
        if (event.item?.type === "message" && event.item.role === "assistant" && event.response_id) this.audioItem(event.response_id, event.item.id);
        return;
      case "response.output_audio.delta":
        if (typeof event.delta === "string" && event.delta) {
          if (event.item_id && event.response_id) this.audioItem(event.response_id, event.item_id);
          const pcm = Buffer.from(event.delta, "base64");
          if (this.metered) this.events.meter?.(pcm.byteLength / 48_000, 0);
          this.events.audio(event.response_id, pcm);
        }
        return;
      case "response.output_audio_transcript.delta":
        if (typeof event.delta === "string") this.events.said(event.response_id, event.delta);
        return;
      case "response.function_call_arguments.done": {
        let args: Record<string, unknown> = {};
        try { args = event.arguments ? JSON.parse(event.arguments) : {}; } catch { /* the model wrote no JSON: no arguments */ }
        this.events.toolCall({ response: event.response_id, id: event.call_id, name: event.name, args: args && typeof args === "object" ? args : {} });
        return;
      }
      case "response.done": {
        const response = event.response ?? {};
        if (this.active === response.id) this.active = undefined;
        const status = ["completed", "cancelled", "failed", "incomplete"].includes(response.status) ? response.status : "failed";
        const detail = response.status_details?.error;
        const error = detail?.message ? [detail.code ?? detail.type, detail.message].filter(Boolean).join(": ") : response.status_details?.reason;
        this.events.responseDone(response.id, { status, usage: usageOf(response.usage), ...(status === "failed" && error ? { error: this.redact(String(error)).slice(0, 200) } : {}) });
        return;
      }
      case "input_audio_buffer.committed": {
        const tag = this.committing.shift();
        if (tag !== undefined && event.item_id) this.tags.set(event.item_id, tag);
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const tag = this.tags.get(event.item_id);
        if (tag === undefined) return;
        this.tags.delete(event.item_id);
        const seconds = event.usage?.type === "duration" && Number.isFinite(event.usage.seconds) ? Number(event.usage.seconds) : 0;
        this.events.heard(tag, String(event.transcript ?? "").trim(), seconds);
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        const tag = this.tags.get(event.item_id);
        if (tag !== undefined) { this.tags.delete(event.item_id); this.events.heard(tag, "", 0); }
        return;
      }
      case "error": {
        const code = String(event.error?.code ?? event.error?.type ?? "error");
        if (BENIGN.has(code)) return;
        if (!this.ready && this.refusesLanguage(code, String(event.error?.param ?? ""), String(event.error?.message ?? ""))) {
          // The language refused (as Azure refused "so"): the session again without it, here and on any host after.
          this.language = undefined;
          for (const target of this.targets) if (target.bare) { target.session = target.bare; target.bare = undefined; }
          this.events.language?.(`refused by ${this.host}: ${this.redact(String(event.error?.message ?? code)).slice(0, 200)}`);
          this.transmit(this.targets[0]!.session);
          return;
        }
        // Refused before it is live (its session, a deployment it names): the next host instead.
        if (!this.ready && this.targets.length > 1) { this.fail(`${code}: ${String(event.error?.message ?? "")}`); return; }
        this.events.warning(this.redact(code), this.redact(String(event.error?.message ?? "")).slice(0, 300));
        return;
      }
    }
  }
}

/** A response's usage as OpenAI reports it (response.done's response.usage), as our counts. */
export function usageOf(usage: any): RealtimeUsage {
  if (!usage || typeof usage !== "object") return { ...NO_USAGE };
  const n = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const input = usage.input_token_details ?? {}, cached = input.cached_tokens_details ?? {}, output = usage.output_token_details ?? {};
  return {
    inputText: n(input.text_tokens), inputAudio: n(input.audio_tokens), cachedText: n(cached.text_tokens), cachedAudio: n(cached.audio_tokens),
    outputText: n(output.text_tokens), outputAudio: n(output.audio_tokens),
  };
}

/** The session's language as OpenAI's transcription takes it (language.ts), or undefined: it detects the language then. */
export const transcriptionLanguage = openaiTranscriptionLanguage;

/** The session OpenAI's GA protocol takes; on Azure, `model` is the realtime deployment and `transcription` the transcription one. */
function openaiSession(config: RealtimeConfig, transcription: string = REALTIME_TRANSCRIPTION.model) {
  const language = config.language;
  const prompt = [config.prompt].filter(Boolean).join("\n");
  return {
    type: "realtime", model: config.model, instructions: config.instructions, output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24_000 }, turn_detection: null,
        ...(config.transcribe ? { transcription: { model: transcription, ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) } } : {}),
      },
      output: { format: { type: "audio/pcm", rate: 24_000 }, voice: config.voice },
    },
    ...(config.tools.length ? { tools: config.tools.map(tool => ({ type: "function", ...tool })), tool_choice: "auto" } : {}),
  };
}
