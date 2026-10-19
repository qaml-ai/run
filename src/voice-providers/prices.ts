import { micros } from "../pricing.ts";

/**
 * What text to speech (POST /v1/speech) costs on the platform's keys, by `<provider>/<model>`: the providers' list
 * prices, passed through without a markup, as model tokens are. A tenant's own key is billed by its provider, not here
 * (its usage records still carry the cost, for its reports). It is billed as its provider bills it: per character for
 * ElevenLabs, Cartesia and Deepgram Aura, per second of speech made for OpenAI.
 *
 * AGENT_SPEECH_PRICES (JSON) overrides or adds entries: {"tts": {"cartesia/sonic-3": {"perThousandChars": 0.03}}}, USD.
 * AGENT_PRICE_SPEECH_USD still sets OpenAI's (pricing.ts).
 */

/** Micro-USD per thousand characters spoken, or per minute of speech made. */
export type TtsPrice = { perThousandChars: number } | { perMinute: number };

/** List prices as of 2026-10 (pay as you go). Check them against each provider's pricing page before relying on them. */
export const TTS_PRICES: Readonly<Record<string, TtsPrice>> = Object.freeze({
  // ElevenLabs Flash v2.5 and Turbo v2.5: half a credit a character; $0.05 per 1,000 characters on the API's list price.
  "elevenlabs/eleven_flash_v2_5": { perThousandChars: micros(0.05) },
  "elevenlabs/eleven_turbo_v2_5": { perThousandChars: micros(0.05) },
  // Cartesia Sonic-3: a credit a character; $0.05 per 1,000 on its Pro plan.
  "cartesia/sonic-3": { perThousandChars: micros(0.05) },
  // Deepgram Aura-2: $0.030 per 1,000 characters.
  "deepgram/aura-2": { perThousandChars: micros(0.03) },
});

export type SpeechPrices = { tts: Record<string, TtsPrice> };

/** The price table, with AGENT_SPEECH_PRICES's entries over the defaults; throws on an entry it cannot read. */
export function speechPrices(env: Record<string, string | undefined> = process.env): SpeechPrices {
  const prices: SpeechPrices = { tts: { ...TTS_PRICES } };
  if (!env.AGENT_SPEECH_PRICES) return prices;
  let parsed: any;
  try { parsed = JSON.parse(env.AGENT_SPEECH_PRICES); } catch { throw new Error("AGENT_SPEECH_PRICES must be JSON: {\"tts\": {\"<provider>/<model>\": {\"perThousandChars\" | \"perMinute\": usd}}}"); }
  const usd = (value: unknown, name: string) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`AGENT_SPEECH_PRICES ${name} must be a non-negative number of USD`);
    return micros(value);
  };
  const reference = /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/;
  for (const [id, value] of Object.entries(parsed?.tts ?? {}) as [string, any][]) {
    if (!reference.test(id)) throw new Error(`AGENT_SPEECH_PRICES tts key ${id} must be <provider>/<model>`);
    if (value?.perThousandChars !== undefined) prices.tts[id] = { perThousandChars: usd(value.perThousandChars, `tts.${id}.perThousandChars`) };
    else prices.tts[id] = { perMinute: usd(value?.perMinute, `tts.${id}.perMinute`) };
  }
  return prices;
}

/** What speech by `reference` cost (USD): its characters, or its seconds made, as its provider bills; undefined unpriced. */
export function ttsCost(prices: SpeechPrices, reference: string, made: { characters: number; seconds: number }): number | undefined {
  const price = prices.tts[reference];
  if (!price) return undefined;
  return "perThousandChars" in price ? made.characters * price.perThousandChars / 1000 / 1_000_000 : Math.ceil(made.seconds) * price.perMinute / 60 / 1_000_000;
}
