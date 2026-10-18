import type { Outbound } from "../outbound.ts";
import { safeError } from "../metrics.ts";
import { DEFAULT_VOICE, openaiSpeech, SPEECH_LIMITS, SPEECH_MODEL, SpeechFailed, type SpeechCredentials, type SpeechInput, type SpeechProvider } from "../speech.ts";

/**
 * Text to speech across providers, each streaming 24 kHz mono 16-bit PCM as it is made (what voice sessions play):
 * ElevenLabs Flash (`pcm_24000`), Cartesia Sonic-3 (raw `pcm_s16le`), Deepgram Aura-2 (`linear16`, no container) and
 * OpenAI (speech.ts). Each is `<provider>/<model>`, on the tenant's key for that provider; a voice is the provider's own
 * (an ElevenLabs voice id, a Cartesia voice id, an Aura voice model, an OpenAI voice name). A chain of them fails over
 * while nothing has been played: once the first audio is out, a failure ends the speech, since another voice cannot
 * carry on mid-sentence.
 */

export const TTS_PROVIDERS = ["elevenlabs", "cartesia", "deepgram", "openai"] as const;
export const DEFAULT_TTS_MODELS: Record<string, string> = { elevenlabs: "eleven_flash_v2_5", cartesia: "sonic-3", deepgram: "aura-2", openai: SPEECH_MODEL };
/**
 * The voice a provider speaks in when the session names none for it: ElevenLabs' premade "Rachel", Aura-2's "Thalia",
 * OpenAI's alloy. Cartesia has no voice every account has, so it speaks only with one given.
 */
export const DEFAULT_VOICES: Record<string, string | undefined> = { elevenlabs: "21m00Tcm4TlvDq8ikWAM", cartesia: undefined, deepgram: "aura-2-thalia-en", openai: DEFAULT_VOICE };

/** `<provider>` or `<provider>/<model>` as `<provider>/<model>`; throws for a provider it does not know. */
export function ttsReference(given: string): string {
  const [provider, ...rest] = given.trim().split("/");
  if (!(TTS_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown text-to-speech provider ${provider}: one of ${TTS_PROVIDERS.join(", ")}`);
  const model = rest.join("/");
  if (model && !/^[A-Za-z0-9._-]{1,80}$/.test(model)) throw new Error(`Unknown text-to-speech model ${given}`);
  return `${provider}/${model || DEFAULT_TTS_MODELS[provider]}`;
}

export type TtsEndpoints = { openai?: string; elevenlabs?: string; cartesia?: string; deepgram?: string };

/** The provider for a reference (`ttsReference`). */
export function speechProvider(reference: string, outbound: Outbound, endpoints: TtsEndpoints = {}): SpeechProvider {
  const [provider, model] = ttsReference(reference).split("/") as [string, string];
  switch (provider) {
    case "elevenlabs": return elevenlabsSpeech({ outbound, model, ...(endpoints.elevenlabs ? { baseUrl: endpoints.elevenlabs } : {}) });
    case "cartesia": return cartesiaSpeech({ outbound, model, ...(endpoints.cartesia ? { baseUrl: endpoints.cartesia } : {}) });
    case "deepgram": return deepgramSpeech({ outbound, model, ...(endpoints.deepgram ? { baseUrl: endpoints.deepgram } : {}) });
    default: return openaiSpeech({ outbound, ...(endpoints.openai ? { baseUrl: endpoints.openai } : {}) });
  }
}

type Request = { url: string; headers: Record<string, string>; secrets: Record<string, string>; body: string };

/** POST and stream the PCM back, with each provider's refusals as SpeechFailed (400: it refused the text; 502: it failed). */
async function* streamed(outbound: Outbound, name: string, request: Request, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let response: Response;
  try {
    response = await outbound.fetch(request.url, { method: "POST", stream: true, maxBytes: SPEECH_LIMITS.maxBytes, timeoutMs: SPEECH_LIMITS.timeoutMs, signal, headers: request.headers, secrets: request.secrets, body: request.body });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SpeechFailed(502, `${name} could not be reached to make speech (${safeError(error)})`);
  }
  if (!response.ok) {
    const detail = await response.text().then(text => text.slice(0, 300).replace(/\s+/g, " "), () => "");
    const status = response.status;
    if (status === 401 || status === 403) throw new SpeechFailed(502, `${name} rejected the API key (HTTP ${status})`);
    if (status === 400 || status === 422) throw new SpeechFailed(400, `${name} would not make this speech (HTTP ${status}${detail ? `: ${detail}` : ""})`);
    throw new SpeechFailed(502, `${name} failed to make speech (HTTP ${status})`);
  }
  if (!response.body) return;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
}

const usable = (credentials: SpeechCredentials) => !credentials.baseUrl && !!credentials.apiKey;

/**
 * A request without a key (401, nothing spent) leaves a connection in the outbound pool, which keeps it 30 s, so the
 * next speech skips connecting: at most every 10 s, as OpenAI's (speech.ts).
 */
function warmer(outbound: Outbound, url: string) {
  let warmedAt = 0;
  return async () => {
    if (Date.now() - warmedAt < 10_000) return;
    warmedAt = Date.now();
    const response = await outbound.fetch(url, { method: "GET", timeoutMs: 10_000, maxBytes: 64 * 1024 }).catch(() => undefined);
    await response?.arrayBuffer().catch(() => {});
  };
}

/**
 * ElevenLabs' streaming endpoint (`/v1/text-to-speech/{voice}/stream`), raw 24 kHz PCM. Flash v2.5 is its fastest
 * model (about 75 ms to the first audio, as ElevenLabs measures it). `instructions` are not taken.
 */
export function elevenlabsSpeech(options: { outbound: Outbound; baseUrl?: string; model?: string }): SpeechProvider {
  const { outbound, baseUrl = "https://api.elevenlabs.io", model = DEFAULT_TTS_MODELS.elevenlabs } = options;
  return {
    id: "elevenlabs", warm: warmer(outbound, `${baseUrl.replace(/\/+$/, "")}/v1/models`),
    model,
    async *stream(input, credentials, signal) {
      if (!usable(credentials)) throw new SpeechFailed(502, "ElevenLabs needs an ElevenLabs key");
      const voice = encodeURIComponent(input.voice || DEFAULT_VOICES.elevenlabs!);
      yield* streamed(outbound, "ElevenLabs", {
        url: `${baseUrl.replace(/\/+$/, "")}/v1/text-to-speech/${voice}/stream?output_format=pcm_24000`,
        headers: { "Content-Type": "application/json", Accept: "audio/pcm" },
        secrets: { "xi-api-key": credentials.apiKey },
        body: JSON.stringify({ text: input.text, model_id: model, ...(input.language ? { language_code: input.language.slice(0, 2) } : {}) }),
      }, signal);
    },
  };
}

/** Cartesia's `/tts/bytes`, raw pcm_s16le at 24 kHz. Sonic-3 takes a voice id; `language` is its ISO 639-1 code. */
export function cartesiaSpeech(options: { outbound: Outbound; baseUrl?: string; model?: string; version?: string }): SpeechProvider {
  const { outbound, baseUrl = "https://api.cartesia.ai", model = DEFAULT_TTS_MODELS.cartesia, version = "2025-04-16" } = options;
  return {
    id: "cartesia", warm: warmer(outbound, `${baseUrl.replace(/\/+$/, "")}/voices`),
    model,
    async *stream(input, credentials, signal) {
      if (!usable(credentials)) throw new SpeechFailed(502, "Cartesia needs a Cartesia key");
      if (!input.voice) throw new SpeechFailed(400, "Cartesia speaks in a voice it is given: set speech.voices.cartesia to a Cartesia voice id");
      yield* streamed(outbound, "Cartesia", {
        url: `${baseUrl.replace(/\/+$/, "")}/tts/bytes`,
        headers: { "Content-Type": "application/json", "Cartesia-Version": version },
        secrets: { "X-API-Key": credentials.apiKey },
        body: JSON.stringify({
          model_id: model, transcript: input.text, voice: { mode: "id", id: input.voice },
          output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24_000 },
          language: (input.language ?? "en").slice(0, 2),
        }),
      }, signal);
    },
  };
}

/** Deepgram Aura-2 (`/v1/speak`), linear16 at 24 kHz without a container. The voice is an Aura model (aura-2-thalia-en). */
export function deepgramSpeech(options: { outbound: Outbound; baseUrl?: string; model?: string }): SpeechProvider {
  const { outbound, baseUrl = "https://api.deepgram.com", model = DEFAULT_TTS_MODELS.deepgram } = options;
  return {
    id: "deepgram", warm: warmer(outbound, `${baseUrl.replace(/\/+$/, "")}/v1/projects`),
    model,
    async *stream(input, credentials, signal) {
      if (!usable(credentials)) throw new SpeechFailed(502, "Deepgram needs a Deepgram key");
      const voice = input.voice || DEFAULT_VOICES.deepgram!;
      const query = new URLSearchParams({ model: voice, encoding: "linear16", sample_rate: "24000", container: "none" });
      yield* streamed(outbound, "Deepgram", {
        url: `${baseUrl.replace(/\/+$/, "")}/v1/speak?${query}`,
        headers: { "Content-Type": "application/json" },
        secrets: { Authorization: `Token ${credentials.apiKey}` },
        body: JSON.stringify({ text: input.text }),
      }, signal);
    },
  };
}

/** A member of a speech chain: its provider, the voice it speaks in, and its key for the speech's tenant. */
export type SpeechMember = { provider: SpeechProvider; voice?: string; key(): Promise<(SpeechCredentials & { platform: boolean }) | undefined> };

/** Who made a speech: set before its first audio is yielded. */
export type Served = { provider: string; model: string; voice: string; platform: boolean };

export const SPEECH_CHAIN = Object.freeze({
  /** A provider that has not sent its first audio by then is passed over for the next (when there is one). */
  firstAudioMs: 3_000,
});

/**
 * A speech made by the first member that can: each in turn, skipping one without a key, and moving on when one fails
 * (or is slower than `firstAudioMs` to start) before any audio is out. `served` is called before the first chunk.
 * A refusal of the text itself (400) is not the provider's fault: the next one is tried too, since its rules differ.
 */
export async function* chainedSpeech(members: SpeechMember[], input: Omit<SpeechInput, "voice">, signal: AbortSignal,
  served: (who: Served) => void, options: { firstAudioMs?: number; log?: Record<string, unknown> } = {}): AsyncGenerator<Uint8Array> {
  let last: Error | undefined;
  for (const [index, member] of members.entries()) {
    if (signal.aborted) return;
    const more = index < members.length - 1;
    let key: Awaited<ReturnType<SpeechMember["key"]>>;
    try { key = await member.key(); } catch (error) { last = error as Error; continue; }
    if (!key) continue;
    const { platform, ...credentials } = key;
    const voice = member.voice ?? DEFAULT_VOICES[member.provider.id] ?? "";
    // Its own abort, so a provider passed over stops making speech.
    const own = new AbortController();
    const onAbort = () => own.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const iterator = member.provider.stream({ ...input, voice }, credentials, own.signal)[Symbol.asyncIterator]();
    let first: IteratorResult<Uint8Array>;
    try {
      const firstAudioMs = options.firstAudioMs ?? SPEECH_CHAIN.firstAudioMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = more ? new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SpeechFailed(502, `${member.provider.id} made no audio within ${firstAudioMs} ms`)), firstAudioMs); }) : undefined;
      try { first = await (late ? Promise.race([iterator.next(), late]) : iterator.next()); } finally { clearTimeout(timer); }
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      own.abort();
      void iterator.return?.().catch(() => {});
      if (signal.aborted) throw error;
      last = error as Error;
      console.error(JSON.stringify({ type: "voice_tts_failover", provider: member.provider.id, model: member.provider.model, to: members[index + 1]?.provider.id ?? null, ...options.log, error: safeError(error) }));
      continue;
    }
    try {
      served({ provider: member.provider.id, model: member.provider.model, voice, platform });
      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      own.abort();
      void iterator.return?.().catch(() => {});
    }
  }
  throw last ?? new SpeechFailed(400, "No speech provider has a key: add one under Models & keys (PUT /v1/providers/<provider>/key)");
}
