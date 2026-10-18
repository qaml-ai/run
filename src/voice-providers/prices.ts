import { micros } from "../pricing.ts";

/**
 * What speech to text and text to speech cost on the platform's keys, by `<provider>/<model>`: the providers' list
 * prices, passed through without a markup, as model tokens are. A tenant's own key is billed by its provider, not here
 * (its usage records still carry the cost, for its reports).
 *
 * Speech to text is billed per second of audio sent (as the providers bill streams). Text to speech is billed as its
 * provider bills it: per character for ElevenLabs, Cartesia and Deepgram Aura, per second of speech made for OpenAI.
 *
 * AGENT_SPEECH_PRICES (JSON) overrides or adds entries: {"stt": {"deepgram/nova-3": 0.0077}, "tts":
 * {"cartesia/sonic-3": {"perThousandChars": 0.03}}}, USD. AGENT_PRICE_TRANSCRIPTION_USD, AGENT_PRICE_LIVE_TRANSCRIPTION_USD
 * and AGENT_PRICE_SPEECH_USD still set OpenAI's (pricing.ts).
 */

/** Micro-USD per minute of audio transcribed. */
export type SttPrice = { perMinute: number };
/** Micro-USD per thousand characters spoken, or per minute of speech made. */
export type TtsPrice = { perThousandChars: number } | { perMinute: number };

/** List prices as of 2026-10 (pay as you go). Check them against each provider's pricing page before relying on them. */
export const STT_PRICES: Readonly<Record<string, SttPrice>> = Object.freeze({
  // Deepgram: streaming Nova-3, English (monolingual) and multilingual; Flux, conversational English.
  "deepgram/nova-3": { perMinute: micros(0.0077) },
  "deepgram/nova-3-multilingual": { perMinute: micros(0.0092) },
  "deepgram/flux-general-en": { perMinute: micros(0.0077) },
  // Soniox real-time: $0.12 an hour.
  "soniox/stt-rt-v3": { perMinute: micros(0.002) },
  // AssemblyAI Universal Streaming: $0.15 an hour (session time).
  "assemblyai/universal-streaming-english": { perMinute: micros(0.0025) },
  "assemblyai/universal-streaming-multilingual": { perMinute: micros(0.0025) },
});

export const TTS_PRICES: Readonly<Record<string, TtsPrice>> = Object.freeze({
  // ElevenLabs Flash v2.5 and Turbo v2.5: half a credit a character; $0.05 per 1,000 characters on the API's list price.
  "elevenlabs/eleven_flash_v2_5": { perThousandChars: micros(0.05) },
  "elevenlabs/eleven_turbo_v2_5": { perThousandChars: micros(0.05) },
  // Cartesia Sonic-3: a credit a character; $0.05 per 1,000 on its Pro plan.
  "cartesia/sonic-3": { perThousandChars: micros(0.05) },
  // Deepgram Aura-2: $0.030 per 1,000 characters.
  "deepgram/aura-2": { perThousandChars: micros(0.03) },
});

export type SpeechPrices = { stt: Record<string, SttPrice>; tts: Record<string, TtsPrice> };

/** The price table, with AGENT_SPEECH_PRICES's entries over the defaults; throws on an entry it cannot read. */
export function speechPrices(env: Record<string, string | undefined> = process.env): SpeechPrices {
  const prices: SpeechPrices = { stt: { ...STT_PRICES }, tts: { ...TTS_PRICES } };
  if (!env.AGENT_SPEECH_PRICES) return prices;
  let parsed: any;
  try { parsed = JSON.parse(env.AGENT_SPEECH_PRICES); } catch { throw new Error("AGENT_SPEECH_PRICES must be JSON: {\"stt\": {\"<provider>/<model>\": usdPerMinute}, \"tts\": {\"<provider>/<model>\": {\"perThousandChars\" | \"perMinute\": usd}}}"); }
  const usd = (value: unknown, name: string) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`AGENT_SPEECH_PRICES ${name} must be a non-negative number of USD`);
    return micros(value);
  };
  const reference = /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/;
  for (const [id, value] of Object.entries(parsed?.stt ?? {})) {
    if (!reference.test(id)) throw new Error(`AGENT_SPEECH_PRICES stt key ${id} must be <provider>/<model>`);
    prices.stt[id] = { perMinute: usd(value, `stt.${id}`) };
  }
  for (const [id, value] of Object.entries(parsed?.tts ?? {}) as [string, any][]) {
    if (!reference.test(id)) throw new Error(`AGENT_SPEECH_PRICES tts key ${id} must be <provider>/<model>`);
    if (value?.perThousandChars !== undefined) prices.tts[id] = { perThousandChars: usd(value.perThousandChars, `tts.${id}.perThousandChars`) };
    else prices.tts[id] = { perMinute: usd(value?.perMinute, `tts.${id}.perMinute`) };
  }
  return prices;
}

/** What `seconds` of audio transcribed by `reference` cost (USD), billed per second; undefined when it has no price. */
export function sttCost(prices: SpeechPrices, reference: string, seconds: number): number | undefined {
  const price = prices.stt[reference];
  return price && Math.ceil(seconds) * price.perMinute / 60 / 1_000_000;
}

/** What speech by `reference` cost (USD): its characters, or its seconds made, as its provider bills; undefined unpriced. */
export function ttsCost(prices: SpeechPrices, reference: string, made: { characters: number; seconds: number }): number | undefined {
  const price = prices.tts[reference];
  if (!price) return undefined;
  return "perThousandChars" in price ? made.characters * price.perThousandChars / 1000 / 1_000_000 : Math.ceil(made.seconds) * price.perMinute / 60 / 1_000_000;
}
