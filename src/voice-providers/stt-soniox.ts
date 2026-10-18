import type { LiveTranscriptionProvider } from "../transcription-live.ts";
import { messageJson, openSocket, type SocketFactory } from "./socket.ts";
import { TimedLive } from "./stt-timed.ts";

/**
 * Soniox's real-time speech to text (wss://stt-rt.soniox.com/transcribe-websocket), on the tenant's Soniox key
 * (PUT /v1/providers/soniox/key). The key and settings go in the first message; audio follows as binary frames; tokens
 * come back with times, final or not; a commit sends `finalize`, answered by a `<fin>` token once all heard is final.
 * One model hears 60 languages, switching mid-stream; the session's language is a hint, its prompt and terms context.
 */

export const SONIOX_MODEL = "stt-rt-v3";
const DEFAULT_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

export function sonioxLiveTranscription(options: { url?: string; model?: string; socket?: SocketFactory; commitTimeoutMs?: number } = {}): LiveTranscriptionProvider {
  const { url = DEFAULT_URL, model = SONIOX_MODEL } = options;
  const socket = options.socket ?? openSocket;
  return {
    id: "soniox",
    model,
    connect(credentials, asked) {
      if (credentials.baseUrl || credentials.via || !credentials.apiKey) return undefined;
      const context = asked.prompt || asked.keyterms?.length ? { ...(asked.prompt ? { text: asked.prompt } : {}), ...(asked.keyterms?.length ? { terms: asked.keyterms } : {}) } : undefined;
      const config = {
        api_key: credentials.apiKey, model,
        audio_format: "pcm_s16le", sample_rate: 24_000, num_channels: 1,
        ...(asked.language ? { language_hints: [asked.language.slice(0, 2).toLowerCase()] } : {}),
        enable_language_identification: true,
        ...(context ? { context } : {}),
      };
      return new SonioxLive(socket(url, {}), {
        provider: "soniox", model, joiner: "", first: JSON.stringify(config),
        ...(asked.onEvent ? { onEvent: asked.onEvent } : {}),
        keepAlive: { ms: 8_000, message: JSON.stringify({ type: "keepalive" }) },
        // An empty frame ends the stream.
        last: "",
        ...(options.commitTimeoutMs ? { commitTimeoutMs: options.commitTimeoutMs } : {}),
      });
    },
  };
}

class SonioxLive extends TimedLive {
  private readonly marks: number[] = [];

  protected finalize() {
    this.marks.push(this.sentMs);
    this.send(JSON.stringify({ type: "finalize" }));
  }

  protected message(data: unknown) {
    const event = messageJson(data);
    if (!event) return;
    if (event.error_code !== undefined) { this.fail(new Error(`Soniox live transcription failed (${String(event.error_code).slice(0, 60)})`)); return; }
    const tokens: any[] = Array.isArray(event.tokens) ? event.tokens : [];
    const finals: { text: string; startMs: number; endMs: number }[] = [];
    let language: string | undefined, fin = false, pending = "";
    for (const token of tokens) {
      const text = String(token.text ?? "");
      if (text === "<fin>") { fin = true; continue; }
      if (text === "<end>") continue;
      if (token.is_final) {
        finals.push({ text, startMs: Number(token.start_ms) || 0, endMs: Number(token.end_ms) || 0 });
        if (typeof token.language === "string") language = token.language;
      } else pending += text;
    }
    if (finals.length) this.final(finals, language);
    if (pending.trim() || finals.length) this.partial(pending);
    if (fin) this.finalThrough(this.marks.shift() ?? this.sentMs);
    else if (Number.isFinite(event.final_audio_proc_ms)) this.finalThrough(Number(event.final_audio_proc_ms));
    if (event.finished) this.fail(new Error("The Soniox live transcription finished"));
  }
}
