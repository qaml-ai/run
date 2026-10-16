import type { Outbound } from "./outbound.ts";
import { HttpError } from "./http.ts";
import { MICROS } from "./pricing.ts";
import { safeError } from "./metrics.ts";

/**
 * Text to speech, for voice sessions that speak (voice-sessions.ts): text in, 24 kHz mono 16-bit PCM out, as it is made,
 * so playback starts before the provider finishes. OpenAI's is the one provider, on the tenant's OpenAI key as a model
 * call resolves it (its key scope's, its own, else the platform's, which a prepaid tenant pays for per second of speech
 * made). The text goes to OpenAI and nowhere else: it is never logged, nor is the audio; logs carry lengths and timings.
 */

/** The model speech is made with: OpenAI's low-latency one, which streams and takes instructions on how to speak. */
export const SPEECH_MODEL = "gpt-4o-mini-tts";
/** Samples per second of the PCM a provider makes. */
export const SPEECH_RATE = 24_000;
export const SPEECH_LIMITS = Object.freeze({
  /** Characters in one speech (OpenAI takes at most 4,096). */
  textChars: 4_000,
  instructionsChars: 1_000,
  /** The PCM one speech may make: about 5 minutes. */
  maxBytes: 5 * 60 * SPEECH_RATE * 2,
  /** From the request to the first byte of audio, and between bytes. */
  timeoutMs: 30_000,
});
/** The voice a speech is made in when none is asked for. */
export const DEFAULT_VOICE = "alloy";

export type SpeechInput = { text: string; voice: string; instructions?: string };
export type SpeechCredentials = { apiKey: string; baseUrl?: string; headers?: Record<string, string> };

export interface SpeechProvider {
  /** The provider key it uses: PUT /v1/providers/<id>/key, as for that provider's models. */
  id: string;
  model: string;
  /** The speech's PCM (SPEECH_RATE, mono, signed 16-bit little-endian), chunk by chunk as the provider makes it. */
  stream(input: SpeechInput, credentials: SpeechCredentials, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** Why speech was not made: 502 when the provider failed, 400 when it refused the input. */
export class SpeechFailed extends HttpError {
  constructor(status: number, message: string) { super(status, message, status === 502 ? "SPEECH_FAILED" : undefined); }
}

/** OpenAI's speech API (`/v1/audio/speech`), streaming raw PCM. */
export function openaiSpeech(options: { outbound: Outbound; baseUrl?: string }): SpeechProvider {
  const { outbound, baseUrl = "https://api.openai.com/v1" } = options;
  return {
    id: "openai",
    model: SPEECH_MODEL,
    async *stream(input, credentials, signal) {
      const url = `${(credentials.baseUrl ?? baseUrl).replace(/\/+$/, "")}/audio/speech`;
      let response: Response;
      try {
        response = await outbound.fetch(url, {
          method: "POST", stream: true, maxBytes: SPEECH_LIMITS.maxBytes, timeoutMs: SPEECH_LIMITS.timeoutMs, signal,
          headers: { "Content-Type": "application/json", ...credentials.headers },
          secrets: credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {},
          body: JSON.stringify({ model: SPEECH_MODEL, input: input.text, voice: input.voice, response_format: "pcm", stream_format: "audio", ...(input.instructions ? { instructions: input.instructions } : {}) }),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SpeechFailed(502, `OpenAI could not be reached to make speech (${safeError(error)})`);
      }
      if (!response.ok) {
        const detail = await response.json().then((body: any) => typeof body?.error?.message === "string" ? body.error.message.slice(0, 300) : "", () => "");
        const status = response.status;
        if (status === 401 || status === 403) throw new SpeechFailed(502, `OpenAI rejected the API key (HTTP ${status})`);
        if (status === 400 || status === 422) throw new SpeechFailed(400, `OpenAI would not make this speech (HTTP ${status}${detail ? `: ${detail}` : ""})`);
        throw new SpeechFailed(502, `OpenAI failed to make speech (HTTP ${status})`);
      }
      if (!response.body) return;
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
    },
  };
}

export interface SynthesizerOptions {
  provider: SpeechProvider;
  /** The provider's key for a tenant (in a key scope), and whether it is the platform's; throws when the tenant may not use it. */
  key(tenant: string, keyScope: string | undefined, provider: string): Promise<(SpeechCredentials & { platform: boolean }) | undefined>;
  /** Micro-USD per minute of speech made. */
  price(): number;
}

export class Synthesizer {
  readonly options: SynthesizerOptions;
  constructor(options: SynthesizerOptions) { this.options = options; }

  get provider() { return this.options.provider.id; }
  get model() { return this.options.provider.model; }

  /** What `seconds` of speech cost (USD), billed per second as it is made. */
  cost(seconds: number) {
    return Math.ceil(seconds) * this.options.price() / 60 / MICROS;
  }

  /** About how long `text` takes to say: speech runs about 14 characters a second. */
  estimateSeconds(text: string) {
    return Math.max(1, Math.ceil(text.length / 14));
  }

  /** The tenant's credentials for speech, or a 400 SPEECH_UNAVAILABLE without a key. */
  async credentials(tenant: string, keyScope: string | undefined) {
    const key = await this.options.key(tenant, keyScope, this.provider);
    if (!key) throw new HttpError(400, `Speaking needs an OpenAI key: add one under Models & keys (PUT /v1/providers/${this.provider}/key)${keyScope ? `, or to key scope ${keyScope}` : ""}`, "SPEECH_UNAVAILABLE");
    return key;
  }

  /** The speech's PCM as it is made (SPEECH_RATE, mono, 16-bit), from `credentials` (see `credentials`). */
  stream(input: SpeechInput, credentials: SpeechCredentials, signal: AbortSignal) {
    return this.options.provider.stream(input, credentials, signal);
  }
}
