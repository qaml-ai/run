import { messageJson, openSocket, wsBase, type Socket, type SocketFactory } from "../../voice-providers/socket.ts";
import { NO_USAGE, REALTIME_TRANSCRIPTION, type RealtimeConfig, type RealtimeConnection, type RealtimeEvents, type RealtimeProvider, type RealtimeUsage } from "./provider.ts";

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
 */

export const OPENAI_REALTIME = Object.freeze({
  models: ["gpt-realtime-2.1", "gpt-realtime-2.1-mini"] as const,
  defaultModel: "gpt-realtime-2.1",
  /** The voices the realtime models speak in; marin and cedar are OpenAI's recommended ones. */
  voices: ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"] as const,
  /** The least input a commit may hold (OpenAI refuses less than 100 ms). */
  minCommitMs: 100,
  connectTimeoutMs: 10_000,
});

/** PCM bytes per ms: 24 kHz, 16-bit mono. */
const BYTES_PER_MS = 48;
/** Errors that say a race was lost, not that something is wrong: a cancel after the response ended, a truncate past it. */
const BENIGN = new Set(["response_cancel_not_active"]);

export function openaiRealtime(options: { baseUrl?: string; socket?: SocketFactory } = {}): RealtimeProvider {
  const { baseUrl = "https://api.openai.com/v1" } = options;
  const socket = options.socket ?? openSocket;
  return {
    id: "openai", key: "openai",
    models: OPENAI_REALTIME.models, defaultModel: OPENAI_REALTIME.defaultModel, voices: OPENAI_REALTIME.voices,
    connect(config, credentials, events) {
      const url = `${wsBase(baseUrl)}/realtime?model=${encodeURIComponent(config.model)}`;
      return new OpenAIRealtime(socket(url, { Authorization: `Bearer ${credentials.apiKey}` }), config, events);
    },
  };
}

class OpenAIRealtime implements RealtimeConnection {
  private readonly socket: Socket;
  private readonly events: RealtimeEvents;
  private readonly instructions: string;
  private open = false;
  private ready = false;
  private ended = false;
  private readonly queue: string[] = [];
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
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(socket: Socket, config: RealtimeConfig, events: RealtimeEvents) {
    this.socket = socket;
    this.events = events;
    this.instructions = config.instructions;
    const prompt = [config.prompt].filter(Boolean).join("\n");
    this.queue.push(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime", model: config.model, instructions: config.instructions, output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 }, turn_detection: null,
            ...(config.transcribe ? { transcription: { model: REALTIME_TRANSCRIPTION.model, ...(config.language ? { language: config.language } : {}), ...(prompt ? { prompt } : {}) } } : {}),
          },
          output: { format: { type: "audio/pcm", rate: 24_000 }, voice: config.voice },
        },
        ...(config.tools.length ? { tools: config.tools.map(tool => ({ type: "function", ...tool })), tool_choice: "auto" } : {}),
      },
    }));
    this.timer = setTimeout(() => { if (!this.ready) this.fail("The realtime connection did not open in time"); }, OPENAI_REALTIME.connectTimeoutMs);
    this.timer.unref?.();
    socket.onopen = () => {
      this.open = true;
      for (const message of this.queue.splice(0)) socket.send(message);
    };
    socket.onmessage = event => this.message(messageJson(event.data));
    socket.onerror = () => this.fail("The realtime connection failed");
    socket.onclose = event => this.fail(`The realtime connection closed${event?.code ? ` (${event.code})` : ""}`);
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
    if (this.open) this.socket.send(data);
    else this.queue.push(data);
  }

  private fail(detail: string) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    try { this.socket.close(); } catch { /* closed already */ }
    this.events.closed("error", detail);
  }

  private message(event: any) {
    if (!event || typeof event.type !== "string" || this.ended) return;
    switch (event.type) {
      case "session.updated":
        if (!this.ready) { this.ready = true; clearTimeout(this.timer); this.events.ready(); }
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
          this.events.audio(event.response_id, Buffer.from(event.delta, "base64"));
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
        const error = response.status_details?.error?.message ?? response.status_details?.reason;
        this.events.responseDone(response.id, { status, usage: usageOf(response.usage), ...(status === "failed" && error ? { error: String(error).slice(0, 200) } : {}) });
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
        this.events.warning(code, String(event.error?.message ?? "").slice(0, 300));
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
