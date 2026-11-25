const MICROS = 1_000_000;
const micros = (usd: number) => Math.round(usd * MICROS);

/** A tool the model may call. */
export type RealtimeTool = { name: string; description: string; parameters: Record<string, unknown> };

/** Tokens one response used, as the provider counts them. */
export type RealtimeUsage = {
  inputText: number; inputAudio: number; cachedText: number; cachedAudio: number;
  outputText: number; outputAudio: number;
};

export const NO_USAGE: Readonly<RealtimeUsage> = Object.freeze({
  inputText: 0, inputAudio: 0, cachedText: 0, cachedAudio: 0, outputText: 0, outputAudio: 0,
});

/** Micro-USD per million tokens, or per minute of audio and per text input item. */
export type RealtimePrice =
  | { perMinute: number; perTextInput: number }
  | { inputText: number; cachedText: number; outputText: number; inputAudio: number; cachedAudio: number; outputAudio: number };

/** List prices, per million tokens. */
export const REALTIME_PRICES: Readonly<Record<string, RealtimePrice>> = Object.freeze({
  "openai/gpt-realtime-2.1": { inputText: micros(4), cachedText: micros(0.4), outputText: micros(24), inputAudio: micros(32), cachedAudio: micros(0.4), outputAudio: micros(64) },
  "openai/gpt-realtime-2.1-mini": { inputText: micros(0.6), cachedText: micros(0.06), outputText: micros(2.4), inputAudio: micros(10), cachedAudio: micros(0.3), outputAudio: micros(20) },
});

const ELEVENLABS_LLM_RATES: Record<string, string | undefined> = {
  "elevenlabs/gemini-2.5-flash-lite": "AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD",
  "elevenlabs/claude-haiku-5-5": "AGENT_PRICE_ELEVENLABS_HAIKU_LLM_MINUTE_USD",
  "elevenlabs/gemini-3.1-flash-lite": "AGENT_PRICE_ELEVENLABS_GEMINI_3_1_LLM_MINUTE_USD",
};

export function realtimePrice(reference: string, env: Record<string, string | undefined> = process.env): RealtimePrice | undefined {
  if (!reference.startsWith("elevenlabs/")) return REALTIME_PRICES[reference];
  const llmRate = ELEVENLABS_LLM_RATES[reference] ?? "AGENT_PRICE_ELEVENLABS_OTHER_LLM_MINUTE_USD";
  const names = ["AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD", llmRate] as const;
  const rates = names.map(name => {
    const raw = env[name] ?? (name === "AGENT_PRICE_ELEVENLABS_OTHER_LLM_MINUTE_USD" ? "0.05" : undefined);
    if (raw === undefined || raw === "") return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(micros(value)) || micros(value) <= 0) {
      throw new Error(`${name} must be a positive number of USD`);
    }
    return micros(value);
  });
  if (rates.some(rate => rate === undefined)) return undefined;
  return { perMinute: rates[0]! + rates[1]!, perTextInput: 0 };
}

/** Nearest realtime voice mapping for OpenAI TTS voice names. */
export const REALTIME_VOICE_FOR: Readonly<Record<string, string>> = Object.freeze({
  nova: "marin", onyx: "cedar", fable: "ballad",
});
