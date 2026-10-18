import type { LiveOptions, LiveTranscriptionProvider } from "../transcription-live.ts";
import type { TranscriptionCredentials } from "../transcription.ts";
import { messageJson, openSocket, wsBase, type Socket, type SocketFactory } from "./socket.ts";
import { TimedLive, type TimedOptions } from "./stt-timed.ts";

/**
 * Deepgram's streaming speech to text, on the tenant's Deepgram key (PUT /v1/providers/deepgram/key):
 *
 * - Nova-3 (`/v1/listen`): words as they are heard (interim results) and final ones as Deepgram settles them; its own
 *   endpointing is off (we say where utterances end), and a commit sends `Finalize`, which settles what it has at once.
 * - Flux (`/v2/listen`, `flux-general-en`): a model built for conversation that says where turns end itself, early
 *   (`EagerEndOfTurn`, retracted by `TurnResumed`) and for sure (`EndOfTurn`). Its turn events go to `onEvent`, so turn
 *   taking can follow them; a commit answers with the turns heard by then, waiting a moment for one still open.
 *
 * Audio is 24 kHz mono linear16, as voice sessions give it.
 */

export const DEEPGRAM_MODELS = { nova: "nova-3", flux: "flux-general-en" } as const;
const DEFAULT_BASE = "https://api.deepgram.com";

/** Flux's end-of-turn settings: thresholds of its end-of-turn confidence (0.5 to 0.9), and the most silence a turn may hold. */
export type FluxTuning = { eotThreshold?: number; eagerEotThreshold?: number; eotTimeoutMs?: number };

type DeepgramProviderOptions = { baseUrl?: string; model?: string; socket?: SocketFactory; flux?: FluxTuning; commitTimeoutMs?: number };

function key(credentials: TranscriptionCredentials) {
  // A key scope's own gateway address is for model calls: Deepgram's is dialled only with a Deepgram key.
  return !credentials.baseUrl && !credentials.via && credentials.apiKey ? credentials.apiKey : undefined;
}

/** Deepgram Nova (nova-3 and its kind) streaming on `/v1/listen`. */
export function deepgramLiveTranscription(options: DeepgramProviderOptions = {}): LiveTranscriptionProvider {
  const { baseUrl = DEFAULT_BASE, model = DEEPGRAM_MODELS.nova } = options;
  const socket = options.socket ?? openSocket;
  if (model.startsWith("flux")) return deepgramFlux({ ...options, model });
  return {
    id: "deepgram",
    model,
    connect(credentials, asked) {
      const apiKey = key(credentials);
      if (!apiKey) return undefined;
      const query = new URLSearchParams({
        model, encoding: "linear16", sample_rate: "24000", channels: "1",
        interim_results: "true", punctuate: "true", smart_format: "true", vad_events: "true", endpointing: "false",
        // Nova-3 hears many languages in one stream ("multi") when none is named.
        language: asked.language ?? "multi",
      });
      for (const term of asked.keyterms ?? []) query.append("keyterm", term);
      return new DeepgramNova(socket(`${wsBase(baseUrl)}/v1/listen?${query}`, { Authorization: `Token ${apiKey}` }), {
        // Multilingual streams are priced apart (prices.ts).
        provider: "deepgram", model: asked.language ? model : `${model}-multilingual`, ...(asked.onEvent ? { onEvent: asked.onEvent } : {}),
        keepAlive: { ms: 4_000, message: JSON.stringify({ type: "KeepAlive" }) },
        last: JSON.stringify({ type: "CloseStream" }),
        ...(options.commitTimeoutMs ? { commitTimeoutMs: options.commitTimeoutMs } : {}),
      });
    },
  };
}

class DeepgramNova extends TimedLive {
  /** Where the stream was at each Finalize not yet answered: its answer settles all sent before it. */
  private readonly marks: number[] = [];

  protected finalize() {
    this.marks.push(this.sentMs);
    this.send(JSON.stringify({ type: "Finalize" }));
  }

  protected message(data: unknown) {
    const event = messageJson(data);
    if (event?.type === "SpeechStarted") { this.event({ type: "speech_started" }); return; }
    if (event?.type === "Error" || event?.err_code) { this.fail(new Error(`Deepgram live transcription failed (${String(event.err_code ?? event.code ?? "error").slice(0, 60)})`)); return; }
    if (event?.type !== "Results") return;
    const alternative = event.channel?.alternatives?.[0];
    const end = (Number(event.start) || 0) + (Number(event.duration) || 0);
    if (!event.is_final) { this.partial(String(alternative?.transcript ?? "")); return; }
    const words = Array.isArray(alternative?.words) ? alternative.words : [];
    const language = typeof event.channel?.detected_language === "string" ? event.channel.detected_language
      : typeof alternative?.languages?.[0] === "string" ? alternative.languages[0] : undefined;
    this.final(words.map((word: any) => ({ text: String(word.punctuated_word ?? word.word ?? ""), startMs: Number(word.start) * 1000, endMs: Number(word.end) * 1000 })), language);
    // A final result settles the stream up to its end; one that answers a Finalize settles all sent before it.
    this.finalThrough(event.from_finalize ? Math.max(end * 1000, this.marks.shift() ?? 0) : end * 1000);
  }
}

/** Deepgram Flux, conversational speech to text with its own end-of-turn detection, on `/v2/listen`. */
export function deepgramFlux(options: DeepgramProviderOptions = {}): LiveTranscriptionProvider {
  const { baseUrl = DEFAULT_BASE, model = DEEPGRAM_MODELS.flux, flux = {} } = options;
  const socket = options.socket ?? openSocket;
  return {
    id: "deepgram",
    model,
    turnDetection: true,
    connect(credentials, asked) {
      const apiKey = key(credentials);
      // Flux hears English only.
      if (!apiKey || (asked.language && !/^en\b/i.test(asked.language) && model.endsWith("-en"))) return undefined;
      const query = new URLSearchParams({ model, encoding: "linear16", sample_rate: "24000" });
      if (flux.eotThreshold !== undefined) query.set("eot_threshold", String(flux.eotThreshold));
      if (flux.eagerEotThreshold !== undefined) query.set("eager_eot_threshold", String(flux.eagerEotThreshold));
      if (flux.eotTimeoutMs !== undefined) query.set("eot_timeout_ms", String(flux.eotTimeoutMs));
      for (const term of asked.keyterms ?? []) query.append("keyterm", term);
      return new DeepgramFluxLive(socket(`${wsBase(baseUrl)}/v2/listen?${query}`, { Authorization: `Token ${apiKey}` }), {
        provider: "deepgram", model, ...(asked.onEvent ? { onEvent: asked.onEvent } : {}),
        last: JSON.stringify({ type: "CloseStream" }),
        ...(options.commitTimeoutMs ? { commitTimeoutMs: options.commitTimeoutMs } : {}),
      });
    },
  };
}

/** How long a commit waits for a Flux turn still open to end before taking its words so far. */
export const FLUX_LIMITS = Object.freeze({ openTurnWaitMs: 700, noTurnGraceMs: 250 });

class DeepgramFluxLive extends TimedLive {
  /** The turn being heard: its index, where it starts, its words so far, and how much of it a commit took already. */
  private turn?: { index: number; startMs: number; endMs: number; text: string; taken: string };
  private wait?: ReturnType<typeof setTimeout>;
  /** How far into the stream Flux has reported (its last TurnInfo's audio window end). */
  private heardMs = 0;

  constructor(socket: Socket, settings: TimedOptions) { super(socket, settings); }

  protected finalize() {
    clearTimeout(this.wait);
    // A turn still open: Flux has not ended it (the speaker paused, or our cut came first). A moment for its end, then
    // its words so far. None open, and Flux has reported on this commit's audio: all of it is heard, answered now.
    // Nothing reported on it yet: it may not have been heard yet, so a moment for a turn to start.
    const oldest = this.oldestWaiting;
    if (!this.turn && oldest && this.heardMs > oldest.fromMs) { this.answerOldest(); return; }
    this.wait = setTimeout(() => this.timeUp(), this.turn ? FLUX_LIMITS.openTurnWaitMs : FLUX_LIMITS.noTurnGraceMs);
    this.wait.unref?.();
  }

  private timeUp() {
    if (!this.waiting) return;
    const turn = this.turn;
    if (turn) {
      // Its words so far are this commit's; what Flux adds to the turn later is the next one's.
      const rest = this.rest(turn, turn.text);
      if (rest) this.final([{ text: rest, startMs: turn.startMs, endMs: turn.endMs }]);
      turn.taken = turn.text;
      // The rest of it, when it comes, is heard after this commit's audio.
      turn.startMs = Math.max(turn.startMs, this.oldestWaiting?.toMs ?? turn.startMs);
    }
    this.answerOldest();
  }

  /** What of a turn's words a commit has not taken. */
  private rest(turn: { taken: string }, text: string) {
    return turn.taken && text.startsWith(turn.taken) ? text.slice(turn.taken.length).trim() : turn.taken ? "" : text.trim();
  }

  protected message(data: unknown) {
    const event = messageJson(data);
    if (event?.type === "Error") { this.fail(new Error(`Deepgram Flux failed (${String(event.code ?? "error").slice(0, 60)})`)); return; }
    if (event?.type !== "TurnInfo") return;
    const index = Number(event.turn_index);
    const startMs = Number(event.audio_window_start ?? 0) * 1000, endMs = Number(event.audio_window_end ?? 0) * 1000;
    const text = String(event.transcript ?? "").trim();
    const confidence = Number.isFinite(event.end_of_turn_confidence) ? Number(event.end_of_turn_confidence) : undefined;
    this.heardMs = Math.max(this.heardMs, endMs);
    if (!this.turn || this.turn.index !== index) this.turn = { index, startMs: Math.max(startMs, this.cutAt), endMs, text: "", taken: "" };
    const turn = this.turn;
    turn.endMs = Math.max(turn.endMs, endMs);
    if (text) turn.text = text;
    switch (event.event) {
      case "StartOfTurn": this.event({ type: "speech_started" }); if (text) this.partial(text); break;
      case "Update": this.partial(text); break;
      case "EagerEndOfTurn": this.event({ type: "eager_end_of_turn", text, ...(confidence !== undefined ? { confidence } : {}) }); break;
      case "TurnResumed": this.event({ type: "turn_resumed" }); break;
      case "EndOfTurn": {
        const rest = this.rest(turn, text);
        if (rest) this.final([{ text: rest, startMs: turn.startMs, endMs: turn.endMs }]);
        this.turn = undefined;
        // All heard up to the turn's end is final: a commit of that audio is answered at once.
        this.finalThrough(endMs);
        this.event({ type: "end_of_turn", text, ...(confidence !== undefined ? { confidence } : {}) });
        if (this.waiting) { clearTimeout(this.wait); this.answerOldest(); }
        break;
      }
    }
  }

  protected fail(error: Error) { clearTimeout(this.wait); super.fail(error); }
}
