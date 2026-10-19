import { z } from "@hono/zod-openapi";
import { HttpError } from "./http.ts";
import { GROK_REALTIME } from "./voice/realtime/grok.ts";
import { OPENAI_REALTIME } from "./voice/realtime/openai.ts";
import { GEMINI_LIVE } from "./voice/realtime/gemini.ts";

export const VoiceSearchInput = z.object({
  provider: z.enum(["elevenlabs", "grok", "openai", "gemini"]),
  q: z.string().max(500).default(""),
  category: z.enum(["professional", "famous", "high_quality"]).optional(),
  limit: z.string().regex(/^([1-9]|[12][0-9]|30)$/).default("10").openapi({ description: "1 to 30, default 10" }),
});
export const LibraryVoice = z.object({
  provider: z.enum(["elevenlabs", "grok", "openai", "gemini"]), id: z.string(), name: z.string(),
  description: z.string().nullable(), labels: z.record(z.string(), z.string()),
  previewUrl: z.string().nullable(), category: z.string().nullable(),
});
export const VoiceSearchResult = z.object({ voices: z.array(LibraryVoice) });
export type VoiceSearch = z.infer<typeof VoiceSearchInput>;

/** Fresh library metadata only; neither the credential nor provider error bodies leave this boundary. */
export async function searchVoices(input: VoiceSearch, key: () => Promise<string | undefined>, request: typeof fetch = fetch) {
  const limit = Number(input.limit);
  if (input.provider !== "elevenlabs") {
    const definitions = { grok: GROK_REALTIME, openai: OPENAI_REALTIME, gemini: GEMINI_LIVE };
    const voices = input.category ? [] : definitions[input.provider].voices.filter(id => id.toLowerCase().includes(input.q.toLowerCase())).slice(0, limit);
    return { voices: voices.map(id => ({ provider: input.provider, id, name: id, description: null, labels: {}, previewUrl: null, category: null })) };
  }
  const apiKey = await key();
  if (!apiKey) throw new HttpError(400, "Voice search needs an ElevenLabs key: add one under Models & keys", "VOICE_SEARCH_UNAVAILABLE");
  // https://elevenlabs.io/docs/api-reference/voices/voice-library/get-shared
  const query = new URLSearchParams({ search: input.q, page_size: String(limit), ...(input.category ? { category: input.category } : {}) });
  try {
    const response = await request(`https://api.elevenlabs.io/v1/shared-voices?${query}`, {
      headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    if (!response.ok) throw new Error();
    const page = await response.json();
    const voices = page.voices.slice(0, limit).map((voice: any) => ({
      provider: "elevenlabs", id: voice.voice_id, name: voice.name,
      description: voice.description ?? null,
      labels: Object.fromEntries(["accent", "age", "gender", "use_case"].flatMap(label => typeof voice[label] === "string" ? [[label, voice[label]]] : [])),
      previewUrl: voice.preview_url ?? null, category: voice.category ?? null,
    }));
    return VoiceSearchResult.parse({ voices });
  } catch {
    throw new HttpError(502, "ElevenLabs voice search failed", "VOICE_SEARCH_FAILED");
  }
}
