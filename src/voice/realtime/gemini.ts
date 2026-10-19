import { messageJson, openSocket, wsBase, type Socket, type SocketFactory } from "../../voice-providers/socket.ts";
import { NO_USAGE, type RealtimeConfig, type RealtimeConnection, type RealtimeEvents, type RealtimeProvider, type RealtimeUsage } from "./provider.ts";

/**
 * Gemini Live (BidiGenerateContent over a WebSocket, v1beta), server to server, on the tenant's Google AI key (the
 * `google` provider key) as `x-goog-api-key`. Automatic activity detection is off: the brain's turns are activities
 * (activityStart, the audio, activityEnd), and the model answers at each activityEnd.
 *
 * Gemini's shape differs from OpenAI's, and the verbs map onto it (measured against the API, 2026-10-18):
 *
 * - `commit` keeps the activity open: Gemini answers at every activityEnd, so a change of speaker within a turn is a
 *   `note` (clientContent, turnComplete false) inside the same activity, which the model reads in order with the audio.
 *   `respond` ends the activity. Each activity's input transcript comes once, just after its end (before the answer's
 *   first audio), and goes to the activity's first committed tag.
 * - There is no clear and no cancel: `discard` leaves the audio in the activity, and `cancel` starts a new activity,
 *   which interrupts the answer being made (`interrupted`). There is no truncate: `truncate` notes how much was heard.
 * - A tool call pauses the turn; the answer goes on after toolResponse by itself, so the response that called the tool
 *   ends there, and the next `respond` names the rest of the turn rather than asking again. stay_silent is not
 *   answered: answering it makes Gemini go on and call it again.
 * - Usage comes with each turn's end (`turnComplete`): the context so far in, audio and thoughts out.
 *
 * Context window compression (sliding window) is on, so a session is not cut at Gemini's 15 minutes of audio.
 */

export const GEMINI_LIVE = Object.freeze({
  models: ["gemini-3.8-live"] as const,
  defaultModel: "gemini-3.8-live",
  /** The Live models' prebuilt voices (Gemini's text-to-speech voices). */
  voices: ["Kore", "Aoede", "Leda", "Zephyr", "Puck", "Charon", "Fenrir", "Orus", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
    "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
    "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"] as const,
  connectTimeoutMs: 10_000,
});
/** A session's voice (OpenAI's names, as sessions give them) as the nearest Gemini voice. */
const VOICE_FOR: Readonly<Record<string, string>> = Object.freeze({
  alloy: "Aoede", coral: "Kore", nova: "Leda", sage: "Erinome", shimmer: "Callirrhoe", marin: "Aoede",
  ash: "Puck", verse: "Fenrir", onyx: "Charon", fable: "Orus", ballad: "Iapetus", echo: "Achird", cedar: "Charon",
});

const BYTES_PER_MS = 48;

export function geminiLive(options: { baseUrl?: string; socket?: SocketFactory } = {}): RealtimeProvider {
  const { baseUrl = "https://generativelanguage.googleapis.com" } = options;
  const socket = options.socket ?? openSocket;
  return {
    id: "gemini", key: "google",
    models: GEMINI_LIVE.models, defaultModel: GEMINI_LIVE.defaultModel, voices: GEMINI_LIVE.voices, voiceFor: VOICE_FOR,
    wordsAfterAnswer: true,
    connect(config, credentials, events) {
      const url = `${wsBase(baseUrl)}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
      return new GeminiLive(socket(url, { "x-goog-api-key": credentials.apiKey }), config, events);
    },
  };
}

class GeminiLive implements RealtimeConnection {
  private readonly socket: Socket;
  private readonly events: RealtimeEvents;
  private open = false;
  private ready = false;
  private ended = false;
  private readonly queue: string[] = [];
  /** An activity is open (activityStart sent), and the audio and tags committed in it. */
  private activity = false;
  private bytes = 0;
  private tags: { tag: string; bytes: number }[] = [];
  /** Activities ended, oldest first, waiting for their transcript. */
  private readonly transcribing: { tags: { tag: string; bytes: number }[] }[] = [];
  /** The response being made (a synthetic id), whether a tool's answer goes on without asking, and the turn's usage. */
  private current?: string;
  private toolPending = false;
  private responses = 0;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(socket: Socket, config: RealtimeConfig, events: RealtimeEvents) {
    this.socket = socket;
    this.events = events;
    this.queue.push(JSON.stringify({
      setup: {
        model: `models/${config.model}`,
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } } },
        systemInstruction: { parts: [{ text: config.instructions }] },
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        ...(config.transcribe ? { inputAudioTranscription: {} } : {}), outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        ...(config.tools.length ? { tools: [{ functionDeclarations: config.tools }] } : {}),
      },
    }));
    this.timer = setTimeout(() => { if (!this.ready) this.fail("The realtime connection did not open in time"); }, GEMINI_LIVE.connectTimeoutMs);
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
    // A new activity interrupts an answer being made, as a person starting to talk does.
    // (A tool's result answered nothing then, as stay_silent's does: the next turn is asked for afresh.)
    if (!this.activity) { this.send({ realtimeInput: { activityStart: {} } }); this.activity = true; this.toolPending = false; }
    this.bytes += pcm.byteLength;
    this.send({ realtimeInput: { audio: { data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"), mimeType: "audio/pcm;rate=24000" } } });
  }

  commit(tag: string) {
    if (this.ended || !this.bytes) return false;
    this.tags.push({ tag, bytes: this.bytes });
    this.bytes = 0;
    return true;
  }

  /** Gemini cannot take audio back: it stays in the activity (and the model hears it with the rest). */
  discard() { this.bytes = 0; }

  note(text: string) {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: false } });
  }

  respond(options: { instructions?: string } = {}) {
    const id = `gemini_${++this.responses}`;
    this.current = id;
    this.events.responseStarted(id);
    // The answer to a tool's result goes on by itself.
    if (this.toolPending) { this.toolPending = false; return; }
    if (options.instructions) this.note(`[${options.instructions}]`);
    if (this.activity) this.endActivity();
    else this.send({ clientContent: { turns: [{ role: "user", parts: [{ text: "[Your turn.]" }] }], turnComplete: true } });
  }

  cancel() {
    if (!this.current || this.activity) return;
    this.send({ realtimeInput: { activityStart: {} } });
    this.activity = true;
  }

  truncate(_response: string, heardMs: number) {
    this.note(heardMs > 0 ? `[You were cut off: they heard only the first ${Math.max(1, Math.round(heardMs / 1_000))} s of that answer.]` : "[That answer was not heard: they did not hear any of it.]");
  }

  toolResult(callId: string, output: string) {
    // stay_silent is left unanswered: answered, Gemini goes on with the turn and calls it again; unanswered, the turn
    // ends at once and the next activity is answered as usual (measured).
    if (this.toolNames.get(callId) === "stay_silent") { this.toolNames.delete(callId); return; }
    let response: unknown;
    try { response = JSON.parse(output); } catch { response = { output }; }
    this.toolPending = true;
    this.send({ toolResponse: { functionResponses: [{ id: callId, name: this.toolNames.get(callId) ?? "", response }] } });
    this.toolNames.delete(callId);
  }
  private readonly toolNames = new Map<string, string>();

  close() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.timer);
    try { this.socket.close(); } catch { /* closed already */ }
    this.events.closed("requested");
  }

  private endActivity() {
    // A turn with no audio committed is still ended (a tool's answer, an empty activity): the model answers the context.
    if (this.bytes) this.commit(`late_${this.responses}`);
    this.send({ realtimeInput: { activityEnd: {} } });
    this.activity = false;
    this.transcribing.push({ tags: this.tags });
    this.tags = [];
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
    if (!event || typeof event !== "object" || this.ended) return;
    if (event.setupComplete) {
      if (!this.ready) { this.ready = true; clearTimeout(this.timer); this.events.ready(); }
      return;
    }
    if (event.goAway) { this.events.warning("go_away", `time left ${String(event.goAway.timeLeft ?? "")}`.slice(0, 100)); return; }
    if (event.toolCall?.functionCalls?.length) {
      const response = this.current;
      for (const call of event.toolCall.functionCalls) {
        if (typeof call?.id !== "string") continue;
        this.toolNames.set(call.id, String(call.name ?? ""));
        this.events.toolCall({ response: response ?? "", id: call.id, name: String(call.name ?? ""), args: call.args && typeof call.args === "object" ? call.args : {} });
      }
      // The turn pauses for the tool's result: the response that asked for it ends here (the turn's usage comes later).
      if (response) { this.current = undefined; this.events.responseDone(response, { status: "completed", usage: { ...NO_USAGE } }); }
      return;
    }
    const content = event.serverContent;
    if (content) {
      if (typeof content.inputTranscription?.text === "string") this.heard(content.inputTranscription.text);
      const response = this.current;
      if (response && typeof content.outputTranscription?.text === "string") this.events.said(response, content.outputTranscription.text);
      for (const part of content.modelTurn?.parts ?? []) {
        if (response && typeof part?.inlineData?.data === "string" && String(part.inlineData.mimeType ?? "").startsWith("audio/")) this.events.audio(response, Buffer.from(part.inlineData.data, "base64"));
      }
      if (content.interrupted && response) {
        this.current = undefined;
        this.events.responseDone(response, { status: "cancelled", usage: usageOf(event.usageMetadata) });
        return;
      }
      if (content.turnComplete) {
        const usage = usageOf(event.usageMetadata);
        if (response) { this.current = undefined; this.events.responseDone(response, { status: "completed", usage }); }
        // The turn's usage after its response ended early (a tool call, or stay_silent's turn): billed all the same.
        else if (Object.values(usage).some(count => count > 0)) this.events.responseDone("", { status: "completed", usage });
      }
    }
  }

  /** An ended activity's transcript: its first tag gets the words, the others (later speakers in it) none. */
  private heard(text: string) {
    const activity = this.transcribing.shift();
    if (!activity) return;
    activity.tags.forEach(({ tag, bytes }, index) => this.events.heard(tag, index === 0 ? text.trim() : "", bytes / BYTES_PER_MS / 1_000));
  }
}

/** A Live turn's usage (usageMetadata): its prompt (the context) by modality, and its answer, thoughts as text. */
export function usageOf(usage: any): RealtimeUsage {
  if (!usage || typeof usage !== "object") return { ...NO_USAGE };
  const n = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  const by = (details: unknown, modality: string) => Array.isArray(details) ? details.filter(entry => entry?.modality === modality).reduce((sum, entry) => sum + n(entry.tokenCount ?? entry.token_count), 0) : 0;
  const inputAudio = by(usage.promptTokensDetails, "AUDIO"), outputAudio = by(usage.responseTokensDetails, "AUDIO");
  return {
    inputAudio, inputText: Math.max(0, n(usage.promptTokenCount) - inputAudio), cachedText: 0, cachedAudio: 0,
    outputAudio, outputText: Math.max(0, n(usage.responseTokenCount) - outputAudio) + n(usage.thoughtsTokenCount),
  };
}
