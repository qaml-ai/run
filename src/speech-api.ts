import type { UsageRecord } from "./client-sessions.ts";
import type { AgentIdentity } from "./identity.ts";
import { HttpError } from "./http.ts";
import { safeError } from "./metrics.ts";
import { SPEECH_LIMITS, SPEECH_RATE, type SpeechChoice, type Synthesizer } from "./speech.ts";
import type { Served } from "./voice-providers/tts-chain.ts";
import { TTS_PROVIDERS, ttsReference } from "./voice-providers/tts.ts";

/**
 * Speech asked for alone (`POST /v1/speech`): text in, speech out, streamed as it is made (speech.ts: the tenant's key,
 * else the platform's against prepaid credit; usage kind `speech`, per second made; an end user's credit held first when
 * the request names a subject). Neither the text nor the audio is kept or logged.
 */

export type SpeechFormat = "pcm" | "wav";
export const SPEECH_FORMATS: Record<SpeechFormat, string> = {
  pcm: `audio/pcm;rate=${SPEECH_RATE};channels=1;encoding=s16le`,
  wav: "audio/wav",
};

export interface SpeechService {
  synthesizer: Synthesizer;
  /** Refuses a tenant that may not start paid work now (spent credit, a monthly cap, runs per minute); throws. */
  admit(tenant: string): Promise<void>;
  record(tenant: string, usage: UsageRecord): void;
}

export type SpeechRequest = {
  text: string; voice: string; instructions?: string; language?: string; format: SpeechFormat; keyScope?: string;
  /** The providers to try in order, and their voices (voice-providers/); else OpenAI's. */
  choice?: SpeechChoice;
  identity?: AgentIdentity; actor?: string;
  hold?: (usd: number) => Promise<{ settle(usd: number): Promise<void>; release(): Promise<void> } | undefined>;
};

/**
 * A WAV header for 16-bit mono PCM of unknown length, as a stream's must be: its sizes are the largest a header can
 * say, which players read as "until the stream ends".
 */
function wavHeader(rate: number) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(0xffffffff, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0xffffffff, 40);
  return header;
}

/**
 * Make speech: admitted, its credentials found and the end user's credit held before a byte is made (each refusal is
 * the request's error), then its audio as a stream. The first chunk is waited for, so a provider that refuses the text
 * is an error answer, not an empty stream. What was made is billed once the stream ends, however it ends (the caller
 * hung up: `signal`).
 */
export async function speechRequest(service: SpeechService, tenant: string, request: SpeechRequest, signal: AbortSignal) {
  const { synthesizer } = service;
  await service.admit(tenant);
  // Through a chain of providers when the request names one, or names voices of providers other than OpenAI (those, in
  // the order given, then OpenAI); else OpenAI.
  const providers = request.choice?.providers ?? voicedProviders(request.choice?.voices);
  if (providers?.length && !synthesizer.options.chain) throw new HttpError(404, "Speech providers other than OpenAI are not enabled on this runtime");
  const chain = synthesizer.options.chain && providers?.length ? synthesizer.options.chain : undefined;
  let credentials: Awaited<ReturnType<Synthesizer["credentials"]>> | undefined, served: Served | undefined;
  if (chain) {
    if (!await synthesizer.canSpeak(tenant, request.keyScope, providers)) throw new HttpError(400, `Speaking needs a key for one of ${synthesizer.order(providers).join(", ")}: add one under Models & keys (PUT /v1/providers/<provider>/key)`, "SPEECH_UNAVAILABLE");
  } else credentials = await synthesizer.credentials(tenant, request.keyScope);
  const held = await request.hold?.(chain ? synthesizer.estimate(request.text, providers) : synthesizer.cost(synthesizer.estimateSeconds(request.text)));
  const abort = new AbortController();
  const stop = () => abort.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const input = { text: request.text, voice: request.voice, ...(request.instructions ? { instructions: request.instructions } : {}), ...(request.language ? { language: request.language } : {}) };
  const source = chain
    ? synthesizer.speak({ tenant, ...(request.keyScope ? { keyScope: request.keyScope } : {}) }, { ...request.choice, ...(providers ? { providers } : {}) }, input, abort.signal, who => { served = who; })
    : synthesizer.stream(input, credentials!, abort.signal);
  const iterator = source[Symbol.asyncIterator]();
  let samples = 0, settled = false;
  // What was made, billed once: when the stream ends, fails or is cancelled.
  const settle = async () => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", stop);
    const seconds = Math.round(samples / SPEECH_RATE * 100) / 100;
    const costUsd = !samples ? 0 : served ? synthesizer.costOf(`${served.provider}/${served.model}`, { characters: request.text.length, seconds }) : synthesizer.cost(seconds);
    await (samples ? held?.settle(costUsd) : held?.release())?.catch(error => console.error(JSON.stringify({ type: "speech_credit_failed", tenant, error: safeError(error) })));
    if (samples) service.record(tenant, {
      provider: served?.provider ?? synthesizer.provider, model: served?.model ?? synthesizer.model, usage: { cost: { total: costUsd } }, platform: served?.platform ?? credentials?.platform ?? false, kind: "speech",
      speeches: 1, audioSeconds: seconds, timestamp: Date.now(),
      ...(request.identity ? { identity: request.identity } : {}), ...(request.actor ? { actor: request.actor } : {}), ...(request.keyScope ? { keyScope: request.keyScope } : {}),
    } as UsageRecord);
    console.log(JSON.stringify({ type: "speech_made", tenant, chars: request.text.length, seconds, format: request.format, aborted: abort.signal.aborted }));
  };
  let first: IteratorResult<Uint8Array>;
  try { first = await iterator.next(); }
  catch (error) { await settle(); throw error; }
  const count = (chunk: Uint8Array) => { samples += chunk.byteLength >> 1; return chunk; };
  // A sample split across chunks (an odd length) is carried to the next, so what goes out stays 16-bit aligned.
  let carry: Uint8Array | undefined;
  const aligned = (chunk: Uint8Array) => {
    const joined = carry ? Buffer.concat([carry, chunk]) : chunk;
    const even = joined.byteLength & ~1;
    carry = even < joined.byteLength ? joined.subarray(even) : undefined;
    return joined.subarray(0, even);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (request.format === "wav") controller.enqueue(wavHeader(SPEECH_RATE));
      if (!first.done) controller.enqueue(count(aligned(first.value)));
    },
    async pull(controller) {
      if (first.done) { await settle(); controller.close(); return; }
      try {
        const next = await iterator.next();
        if (next.done) { await settle(); controller.close(); return; }
        controller.enqueue(count(aligned(next.value)));
      } catch (error) {
        await settle();
        controller.error(error);
      }
    },
    async cancel() {
      abort.abort();
      await iterator.return?.().catch(() => undefined);
      await settle();
    },
  });
  return { body, contentType: SPEECH_FORMATS[request.format], model: served ? `${served.provider}/${served.model}` : synthesizer.reference };
}

/** The request's fields, as checked (the schema's types, the limits a schema cannot say). */
export function speechInput(input: { text: string; voice?: string; instructions?: string; format?: string }, defaultVoice: string) {
  if (!input.text.trim()) throw new HttpError(400, "text must say something");
  if (input.text.length > SPEECH_LIMITS.textChars) throw new HttpError(400, `text must be at most ${SPEECH_LIMITS.textChars} characters`);
  if (input.instructions !== undefined && input.instructions.length > SPEECH_LIMITS.instructionsChars) throw new HttpError(400, `instructions must be at most ${SPEECH_LIMITS.instructionsChars} characters`);
  const voice = input.voice ?? defaultVoice;
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(voice)) throw new HttpError(400, "voice must be a voice's name, such as alloy, coral or verse");
  const format = (input.format ?? "pcm") as SpeechFormat;
  if (!(format in SPEECH_FORMATS)) throw new HttpError(400, `format must be one of: ${Object.keys(SPEECH_FORMATS).join(", ")}`);
  return { text: input.text, voice, format, ...(input.instructions ? { instructions: input.instructions } : {}) };
}

/** The request's `speech` (providers in order, their voices), as given. */
export function speechChoiceInput(value: unknown): SpeechChoice | undefined {
  if (value === undefined) return undefined;
  const given = object(value, "speech");
  const extra = Object.keys(given).find(key => key !== "providers" && key !== "voices");
  if (extra) throw new HttpError(400, `speech.${extra} is not a field: providers, voices`);
  const providers = given.providers === undefined ? undefined : providersInput(given.providers);
  const voices = voicesInput(given.voices);
  return { ...(providers ? { providers } : {}), ...(voices ? { voices } : {}) };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${name} must be an object`);
  return value as Record<string, unknown>;
}

/** Providers to try in order, each `<provider>` or `<provider>/<model>`. */
function providersInput(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > SPEECH_LIMITS.providers) throw new HttpError(400, `speech.providers must list 1 to ${SPEECH_LIMITS.providers} providers, in the order to try them`);
  const references = value.map(given => {
    if (typeof given !== "string") throw new HttpError(400, "speech.providers must list providers by name, such as elevenlabs or elevenlabs/eleven_flash_v2_5");
    try { return ttsReference(given); } catch (error) { throw new HttpError(400, `speech.providers: ${(error as Error).message}`); }
  });
  return [...new Set(references)];
}

/** Voices by text-to-speech provider (`{elevenlabs: "<voice id>", openai: "coral"}`). */
function voicesInput(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const voices = object(value, "speech.voices");
  for (const [provider, voice] of Object.entries(voices)) {
    if (!(TTS_PROVIDERS as readonly string[]).includes(provider)) throw new HttpError(400, `speech.voices.${provider}: voices are by provider, one of ${TTS_PROVIDERS.join(", ")}`);
    if (typeof voice !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(voice)) throw new HttpError(400, `speech.voices.${provider} must be that provider's voice id or name`);
  }
  return Object.keys(voices).length ? voices as Record<string, string> : undefined;
}

/** The providers a request's `speech.voices` names, in its order and then OpenAI's, when any is not OpenAI; else none. */
function voicedProviders(voices: Record<string, string> | undefined): string[] | undefined {
  const named = Object.keys(voices ?? {});
  if (!named.some(provider => provider !== "openai")) return undefined;
  return [...new Set([...named, "openai"])].map(provider => ttsReference(provider));
}
