import type { LiveTranscriptionProvider } from "../transcription-live.ts";
import { messageJson, openSocket, wsBase, type SocketFactory } from "./socket.ts";
import { TimedLive } from "./stt-timed.ts";

/**
 * AssemblyAI's Universal Streaming (v3, wss://streaming.assemblyai.com/v3/ws), on the tenant's AssemblyAI key
 * (PUT /v1/providers/assemblyai/key). Audio goes as binary frames; AssemblyAI answers in turns, each with timed words,
 * and ends a turn itself or when asked (`ForceEndpoint`, which a commit sends). With formatting on, an ended turn comes
 * again punctuated and cased: that one is taken. The session's terms are its `keyterms_prompt`.
 */

export const ASSEMBLYAI_MODEL = "universal-streaming-english";
const DEFAULT_BASE = "https://streaming.assemblyai.com";

/**
 * How long a commit waits for a turn to open when none is (the audio may not have been heard yet), and how near the
 * commit's cut a turn must end to be the commit's last.
 */
export const ASSEMBLYAI_LIMITS = Object.freeze({ noTurnGraceMs: 400, nearCutMs: 1_500 });

export function assemblyaiLiveTranscription(options: { baseUrl?: string; model?: string; format?: boolean; socket?: SocketFactory; commitTimeoutMs?: number } = {}): LiveTranscriptionProvider {
  const { baseUrl = DEFAULT_BASE, model = ASSEMBLYAI_MODEL, format = true } = options;
  const socket = options.socket ?? openSocket;
  return {
    id: "assemblyai",
    model,
    connect(credentials, asked) {
      if (credentials.baseUrl || credentials.via || !credentials.apiKey) return undefined;
      // The English model hears English only; the multilingual one a handful more.
      if (asked.language && !/^en\b/i.test(asked.language) && model.endsWith("-english")) return undefined;
      const query = new URLSearchParams({ sample_rate: "24000", encoding: "pcm_s16le", format_turns: String(format), speech_model: model, inactivity_timeout: "120" });
      if (asked.keyterms?.length) query.set("keyterms_prompt", JSON.stringify(asked.keyterms.slice(0, 100)));
      return new AssemblyAILive(socket(`${wsBase(baseUrl)}/v3/ws?${query}`, { Authorization: credentials.apiKey }), {
        provider: "assemblyai", model, ...(asked.onEvent ? { onEvent: asked.onEvent } : {}),
        last: JSON.stringify({ type: "Terminate" }),
        ...(options.commitTimeoutMs ? { commitTimeoutMs: options.commitTimeoutMs } : {}),
      }, format);
    },
  };
}

class AssemblyAILive extends TimedLive {
  private readonly format: boolean;
  /** A turn heard but not yet ended (or ended, its formatted version still to come). */
  private turnOpen = false;
  private grace?: ReturnType<typeof setTimeout>;

  constructor(socket: ConstructorParameters<typeof TimedLive>[0], settings: ConstructorParameters<typeof TimedLive>[1], format: boolean) {
    super(socket, settings);
    this.format = format;
  }

  protected finalize() {
    this.send(JSON.stringify({ type: "ForceEndpoint" }));
    clearTimeout(this.grace);
    // No turn open: unless one starts soon, there was nothing to hear.
    this.grace = setTimeout(() => { if (!this.turnOpen && this.waiting) this.answerOldest(); }, ASSEMBLYAI_LIMITS.noTurnGraceMs);
    this.grace.unref?.();
  }

  protected message(data: unknown) {
    const event = messageJson(data);
    if (!event) return;
    if (event.type === "Termination") { this.fail(new Error("The AssemblyAI live transcription ended")); return; }
    if (event.error) { this.fail(new Error(`AssemblyAI live transcription failed (${String(event.error).slice(0, 60)})`)); return; }
    if (event.type !== "Turn") return;
    const words: any[] = Array.isArray(event.words) ? event.words : [];
    const text = String(event.transcript ?? "").trim();
    if (!event.end_of_turn) {
      this.turnOpen = true;
      // Words not final yet: the turn's text so far.
      this.partial(text || words.map(word => String(word.text ?? "")).join(" "));
      return;
    }
    // An ended turn, formatted when formatting is on: its text as one stretch, from its first word to its last.
    if (this.format && !event.turn_is_formatted) return;
    this.turnOpen = false;
    const startMs = Number(words[0]?.start ?? 0), endMs = Number(words.at(-1)?.end ?? startMs);
    if (text) this.final([{ text, startMs, endMs }]);
    const oldest = this.oldestWaiting;
    if (!oldest) return;
    clearTimeout(this.grace);
    // The turn ends near the commit's cut: the commit's speech is all heard. One that ended well before may be followed
    // by more of the commit's speech, in a turn about to open: a moment to see.
    if (endMs >= oldest.toMs - ASSEMBLYAI_LIMITS.nearCutMs) this.answerOldest();
    else {
      this.grace = setTimeout(() => { if (!this.turnOpen && this.waiting) this.answerOldest(); }, ASSEMBLYAI_LIMITS.noTurnGraceMs);
      this.grace.unref?.();
    }
  }

  protected fail(error: Error) { clearTimeout(this.grace); super.fail(error); }
}
