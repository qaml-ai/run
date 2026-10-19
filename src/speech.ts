import type { Outbound } from "./outbound.ts";
import { HttpError } from "./http.ts";
import { MICROS } from "./pricing.ts";
import { safeError } from "./metrics.ts";
import { chainedSpeech, type Served, type SpeechMember } from "./voice-providers/tts-chain.ts";

/**
 * Text to speech, for POST /v1/speech (speech-api.ts): text in, 24 kHz mono 16-bit PCM out, as it is made, so playback
 * starts before the provider finishes. OpenAI's is the built-in provider, on the tenant's OpenAI key as a model call
 * resolves it (its key scope's, its own, else the platform's, which a prepaid tenant pays for per second of speech made);
 * a request may name others (voice-providers/tts.ts). The text goes to the provider and nowhere else: it is never logged,
 * nor is the audio; logs carry lengths and timings.
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
  /** Providers a request's chain names at most. */
  providers: 5,
});
/** The voice a speech is made in when none is asked for. */
export const DEFAULT_VOICE = "alloy";

/** `language` (ISO 639-1 or a locale) helps providers that speak many to pick its pronunciation. */
export type SpeechInput = {
  text: string; voice: string; instructions?: string; language?: string;
  /** Through a chain (Synthesizer.speak): this speech's voice for each provider, over the request's (SpeechChoice.voices). */
  voices?: Record<string, string>;
};
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
  /**
   * Other providers a request may speak through, in a chain (voice-providers/tts.ts): each by reference
   * (`elevenlabs/eleven_flash_v2_5`), each provider's default voice, and what a speech by a reference cost (USD), when
   * it has a price. A request that names none speaks through `provider` alone.
   */
  chain?: {
    provider(reference: string): SpeechProvider;
    defaultVoice(provider: string): string | undefined;
    price(reference: string, made: { characters: number; seconds: number }): number | undefined;
  };
}

/** How a request speaks: the chain it names (else the built-in provider), and its voice for each provider. */
export type SpeechChoice = { providers?: string[]; voices?: Record<string, string> };

export class Synthesizer {
  readonly options: SynthesizerOptions;
  constructor(options: SynthesizerOptions) { this.options = options; }

  get provider() { return this.options.provider.id; }
  get model() { return this.options.provider.model; }
  /** The built-in provider's reference, `openai/gpt-4o-mini-tts`. */
  get reference() { return `${this.provider}/${this.model}`; }

  /** What `seconds` of speech cost (USD), billed per second as it is made. */
  cost(seconds: number) {
    return Math.ceil(seconds) * this.options.price() / 60 / MICROS;
  }

  /** The chain a request speaks through: the one it names, else the built-in provider alone. */
  order(asked?: string[]): string[] {
    return asked?.length ? asked : [this.reference];
  }

  /**
   * What a speech by `reference` cost (USD): `characters` or `seconds`, as its provider bills. One without a price is
   * charged as the built-in provider would charge it, per second.
   */
  costOf(reference: string, made: { characters: number; seconds: number }) {
    if (reference === this.reference || !this.options.chain) return this.cost(made.seconds);
    return this.options.chain.price(reference, made) ?? this.cost(made.seconds);
  }

  /** At most what saying `text` costs through a chain (its dearest provider), to hold before it is made. */
  estimate(text: string, order?: string[]) {
    const made = { characters: text.length, seconds: this.estimateSeconds(text) };
    return Math.max(...this.order(order).map(reference => this.costOf(reference, made)));
  }

  /**
   * A speech made through the request's chain (`choice`), on the tenant's key for each provider: the first that can
   * makes it (tts-chain.ts), and `served` says which, with its voice and whose key, before the first audio. The
   * request's `voice` is OpenAI's; another provider speaks in its voice for it (`choice.voices`), else its default.
   */
  speak(context: { tenant: string; keyScope?: string }, choice: SpeechChoice, input: SpeechInput, signal: AbortSignal, served: (who: Served) => void) {
    const members: SpeechMember[] = this.order(choice.providers).map(reference => {
      const provider = reference === this.reference || !this.options.chain ? this.options.provider : this.options.chain.provider(reference);
      const voice = input.voices?.[provider.id] ?? choice.voices?.[provider.id] ?? (provider.id === this.provider ? input.voice : this.options.chain?.defaultVoice(provider.id) ?? "");
      return { provider, voice, key: () => this.options.key(context.tenant, context.keyScope, provider.id) };
    });
    const { voice: _voice, voices: _voices, ...rest } = input;
    return chainedSpeech(members, rest, signal, served, { log: { tenant: context.tenant } });
  }

  /** Whether the tenant has a key for any of a chain's providers. */
  async canSpeak(tenant: string, keyScope: string | undefined, order?: string[]) {
    for (const reference of this.order(order)) {
      const provider = reference === this.reference || !this.options.chain ? this.options.provider : this.options.chain.provider(reference);
      if (await this.options.key(tenant, keyScope, provider.id).catch(() => undefined)) return true;
    }
    return false;
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
