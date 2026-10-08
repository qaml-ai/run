import type { Outbound } from "./outbound.ts";
import type { UsageRecord } from "./client-sessions.ts";
import { audioHeader, AUDIO_FORMATS, type AudioFormat, type AudioHeader } from "./audio-header.ts";
import { HttpError } from "./http.ts";
import type { AgentIdentity } from "./identity.ts";
import { AUDIO_LIMITS, FILE_LIMITS } from "./limits.ts";
import { MICROS } from "./pricing.ts";
import { safeError } from "./metrics.ts";

/**
 * Speech to text: audio in, its transcript out, for `POST /v1/transcriptions` and for audio attached to
 * messages (whose model then reads the transcript, so any model hears it). A provider sits behind
 * `TranscriptionProvider`; OpenAI's is the one built in, on the tenant's OpenAI key as a model call
 * resolves it (its key scope's, its own, else the platform's, which a prepaid tenant pays for at the
 * model's price per minute of audio). Audio is never written to a log, nor is a transcript: logs carry
 * sizes, lengths, models and error classes.
 */
export type Segment = { start: number; end: number; text: string };
export type Transcript = { text: string; language?: string; seconds: number; model: string; segments?: Segment[] };
export type TranscriptionOptions = { language?: string; prompt?: string; timestamps?: boolean };
/** A provider's key (and where it sends, when a key scope gives an address), as a model call's would be. */
export type TranscriptionCredentials = { apiKey: string; baseUrl?: string; headers?: Record<string, string> };

export interface TranscriptionProvider {
  /** The provider key it uses: PUT /v1/providers/<id>/key, as for that provider's models. */
  id: string;
  /** The model a request with these options uses, as its price is listed (`Pricing.transcription`, `<id>/<model>`). */
  model(options: TranscriptionOptions): string;
  transcribe(audio: { bytes: Uint8Array; header: AudioHeader }, options: TranscriptionOptions, credentials: TranscriptionCredentials, signal: AbortSignal): Promise<Transcript>;
}

/** Why a provider did not transcribe: `status` as the runtime answers it (502 when the provider failed, 400 when it refused the audio). */
export class TranscriptionFailed extends HttpError {
  constructor(status: number, message: string) { super(status, message, status === 502 ? "TRANSCRIPTION_FAILED" : undefined); }
}

const EXTENSIONS: Record<AudioFormat, string> = { ogg: "ogg", webm: "webm", wav: "wav", flac: "flac", mp4: "m4a", mp3: "mp3" };

/**
 * OpenAI's transcription API. `gpt-transcribe` by default (its recommended model, billed per second of audio);
 * with timestamps, `whisper-1`, the one of its models that returns segments. OpenAI names the format by the
 * file's extension, so the upload is named for what its header says it is.
 */
export function openaiTranscription(options: { outbound: Outbound; baseUrl?: string; model?: string; timestampsModel?: string; timeoutMs?: number }): TranscriptionProvider {
  const { outbound, baseUrl = "https://api.openai.com/v1", model = "gpt-transcribe", timestampsModel = "whisper-1", timeoutMs = AUDIO_LIMITS.timeoutMs } = options;
  const pick = (asked: TranscriptionOptions) => asked.timestamps ? timestampsModel : model;
  return {
    id: "openai",
    model: pick,
    async transcribe({ bytes, header }, asked, credentials, signal) {
      const chosen = pick(asked);
      const form = new FormData();
      form.set("model", chosen);
      form.set("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: header.contentType }), `audio.${EXTENSIONS[header.format]}`);
      if (asked.language) form.set("language", asked.language);
      if (asked.prompt) form.set("prompt", asked.prompt);
      if (asked.timestamps) { form.set("response_format", "verbose_json"); form.append("timestamp_granularities[]", "segment"); }
      const url = `${(credentials.baseUrl ?? baseUrl).replace(/\/+$/, "")}/audio/transcriptions`;
      let response: Response;
      try {
        // Encoded here: the guarded fetch is undici's own, which takes this runtime's FormData as an opaque object.
        const encoded = new Response(form);
        const body = Buffer.from(await encoded.arrayBuffer());
        response = await outbound.fetch(url, { method: "POST", body, headers: { Accept: "application/json", ...credentials.headers, "Content-Type": encoded.headers.get("content-type")! }, secrets: credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {}, timeoutMs, maxBytes: 4 * 1024 * 1024, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new TranscriptionFailed(502, `OpenAI could not be reached to transcribe the audio (${safeError(error)})`);
      }
      if (!response.ok) {
        // OpenAI's error message names the parameter at fault (never the audio's content).
        const detail = await response.json().then((body: any) => typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : "", () => "");
        const status = response.status;
        if (status === 401 || status === 403) throw new TranscriptionFailed(502, `OpenAI rejected the API key (HTTP ${status})`);
        if (status === 400 || status === 413 || status === 415) throw new TranscriptionFailed(400, `OpenAI could not transcribe the audio (HTTP ${status}${detail ? `: ${detail}` : ""})`);
        throw new TranscriptionFailed(502, `OpenAI failed to transcribe the audio (HTTP ${status})`);
      }
      const body: any = await response.json().catch(() => undefined);
      if (typeof body?.text !== "string") throw new TranscriptionFailed(502, "OpenAI answered without a transcript");
      // What OpenAI bills: whole seconds of audio (`usage.duration`), else the length it heard, else the header's.
      const billed = body.usage?.type === "duration" && Number.isFinite(body.usage.seconds) ? Number(body.usage.seconds) : undefined;
      const seconds = billed ?? (Number.isFinite(body.duration) ? Math.ceil(body.duration) : Math.ceil(header.seconds ?? 0));
      const language = typeof body.language === "string" ? body.language : typeof body.languages?.[0]?.code === "string" ? body.languages[0].code : undefined;
      const segments = Array.isArray(body.segments)
        ? body.segments.filter((segment: any) => Number.isFinite(segment?.start) && Number.isFinite(segment?.end) && typeof segment?.text === "string")
          .map((segment: any): Segment => ({ start: segment.start, end: segment.end, text: segment.text.trim() }))
        : undefined;
      return { text: body.text.trim(), ...(language ? { language } : {}), seconds, model: chosen, ...(asked.timestamps ? { segments: segments ?? [] } : {}) };
    },
  };
}

/** Audio as given to be transcribed, checked: its format and length, within the limits. */
export function checkedAudio(bytes: Uint8Array, name = "The audio"): AudioHeader & { seconds: number } {
  if (bytes.length > AUDIO_LIMITS.fileBytes) throw new HttpError(413, `${name} is larger than ${AUDIO_LIMITS.fileBytes} bytes, the most transcription takes`, "AUDIO_TOO_LARGE");
  const header = audioHeader(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!header) throw new HttpError(415, `${name} is not audio transcription takes: send ${AUDIO_FORMATS.join(", ")} (Ogg Opus or Vorbis)`, "UNSUPPORTED_AUDIO");
  if (header.seconds === undefined) throw new HttpError(415, `${name} does not say how long it is (its ${header.format} header has no length), so it cannot be transcribed`, "UNSUPPORTED_AUDIO");
  if (header.seconds > AUDIO_LIMITS.seconds) throw new HttpError(413, `${name} is ${Math.ceil(header.seconds)} seconds long; transcription takes at most ${AUDIO_LIMITS.seconds}`, "AUDIO_TOO_LONG");
  return header as AudioHeader & { seconds: number };
}

/** A language as ISO 639-1 or a locale (en, pt-BR, zh-cn). */
export function languageInput(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(value)) throw new HttpError(400, "language is an ISO 639-1 code such as en, or a locale such as pt-BR");
  return value;
}

export interface TranscriberOptions {
  provider: TranscriptionProvider;
  /** The provider's key for a tenant (in a key scope), and whether it is the platform's; throws when the tenant may not use it (spent credit). */
  key(tenant: string, keyScope: string | undefined, provider: string): Promise<(TranscriptionCredentials & { platform: boolean }) | undefined>;
  /** Micro-USD per minute of audio with `model` (`<provider>/<model>`); the dearest listed rate for one not listed. */
  price(model: string): number;
}

/** A finished transcription and what it cost, for usage records. */
export type Transcribed = { transcript: Transcript; usage: UsageRecord };

export class Transcriber {
  readonly options: TranscriberOptions;
  constructor(options: TranscriberOptions) { this.options = options; }

  get provider() { return this.options.provider.id; }

  /** What `seconds` of audio cost (USD) with these options: billed per second, as the provider bills. */
  cost(seconds: number, options: TranscriptionOptions = {}) {
    return Math.ceil(seconds) * this.options.price(`${this.options.provider.id}/${this.options.provider.model(options)}`) / 60 / MICROS;
  }

  /**
   * Transcribe checked audio (`checkedAudio`) for a tenant: its usage record (cost in `usage.cost.total`, `platform`
   * when it ran on the platform's key) is the caller's to record, with the run's facts. `budget` (USD), when given, is
   * checked against the audio's cost before anything is sent.
   */
  async transcribe(context: { tenant: string; keyScope?: string; budget?: number }, audio: { bytes: Uint8Array; header: AudioHeader & { seconds: number } }, options: TranscriptionOptions, signal: AbortSignal): Promise<Transcribed> {
    const { provider } = this.options;
    const key = await this.options.key(context.tenant, context.keyScope, provider.id);
    if (!key) throw new HttpError(400, `Transcription needs an OpenAI key: add one under Models & keys (PUT /v1/providers/${provider.id}/key)${context.keyScope ? `, or to key scope ${context.keyScope}` : ""}`, "TRANSCRIPTION_UNAVAILABLE");
    const estimate = this.cost(audio.header.seconds, options);
    if (context.budget !== undefined && estimate > context.budget) throw new HttpError(402, `Transcribing this audio costs about $${estimate.toFixed(4)}, more than the $${Math.max(0, context.budget).toFixed(4)} left of this run's spend limit`, "SPEND_LIMIT");
    const { platform, ...credentials } = key;
    const started = Date.now();
    const transcript = await provider.transcribe(audio, options, credentials, signal);
    const usd = transcript.seconds * this.options.price(`${provider.id}/${transcript.model}`) / 60 / MICROS;
    console.log(JSON.stringify({ type: "transcribed", tenant: context.tenant, provider: provider.id, model: transcript.model, format: audio.header.format, bytes: audio.bytes.length, seconds: transcript.seconds, ms: Date.now() - started }));
    return { transcript, usage: { provider: provider.id, model: transcript.model, usage: { cost: { total: usd } }, platform, kind: "transcription", transcriptions: 1, audioSeconds: transcript.seconds, timestamp: Date.now() } };
  }
}

/** What `POST /v1/transcriptions` is asked: audio (its bytes, or a URL to fetch them from) and how to transcribe it. */
export type TranscriptionRequest = TranscriptionOptions & {
  audio: { bytes: Uint8Array } | { url: string };
  keyScope?: string;
  /** Who it is for and who asked, as an agent's identity and a run's actor say (`usage.recorded`'s subject, context and actor). */
  identity?: AgentIdentity; actor?: string;
};

export interface TranscriptionService {
  transcriber: Transcriber;
  /** Fetches audio given by URL: the public internet only. */
  outbound: Outbound;
  /** Refuses a tenant that may not transcribe now (runs per minute, a monthly cap, spent credit); throws. */
  admit(tenant: string): Promise<void>;
  /** Records a transcription's usage, as a model response's is (billing, usage.recorded). */
  record(tenant: string, usage: UsageRecord): void;
}

/** A transcription asked for alone (`POST /v1/transcriptions`): nothing is kept of the audio or its transcript. */
export async function transcribeRequest(service: TranscriptionService, tenant: string, request: TranscriptionRequest, signal: AbortSignal) {
  const options: TranscriptionOptions = { ...(request.language ? { language: request.language } : {}), ...(request.prompt ? { prompt: request.prompt } : {}), ...(request.timestamps ? { timestamps: true } : {}) };
  await service.admit(tenant);
  const bytes = "bytes" in request.audio ? request.audio.bytes : await fetchAudio(service.outbound, request.audio.url, signal);
  const header = checkedAudio(bytes);
  const { transcript, usage } = await service.transcriber.transcribe({ tenant, ...(request.keyScope ? { keyScope: request.keyScope } : {}) }, { bytes, header }, options, signal);
  service.record(tenant, { ...usage, ...(request.actor ? { actor: request.actor } : {}), ...(request.identity ? { identity: request.identity } : {}), ...(request.keyScope ? { keyScope: request.keyScope } : {}) });
  return {
    text: transcript.text, language: transcript.language ?? null, durationSeconds: transcript.seconds, model: `${service.transcriber.provider}/${transcript.model}`,
    costUsd: usage.usage.cost.total as number, ...(transcript.segments ? { segments: transcript.segments } : {}),
  };
}

/** Audio from a URL, through the outbound guard, at most AUDIO_LIMITS.fileBytes. */
async function fetchAudio(outbound: Outbound, url: string, signal: AbortSignal): Promise<Uint8Array> {
  let address: URL;
  try { address = new URL(url); } catch { throw new HttpError(400, "url must be an absolute https URL"); }
  const where = `${address.origin}${address.pathname}`;
  try {
    const response = await outbound.fetch(address, { signal, timeoutMs: FILE_LIMITS.urlMs, maxBytes: AUDIO_LIMITS.fileBytes, maxRedirects: FILE_LIMITS.urlRedirects });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(400, `Could not fetch ${where} (HTTP ${response.status})`); }
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof HttpError || signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/larger than/.test(message)) throw new HttpError(413, `${where} is larger than ${AUDIO_LIMITS.fileBytes} bytes, the most transcription takes`, "AUDIO_TOO_LARGE");
    throw new HttpError(400, `Could not fetch ${where} (${message.slice(0, 200)})`);
  }
}
