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
  publicOwnerId: z.string().nullable(), previewUrl: z.string().nullable(), category: z.string().nullable(),
});
export const VoiceLookupInput = z.object({
  provider: VoiceSearchInput.shape.provider,
  id: z.string().min(1).max(500).refine(id => id !== "." && id !== ".." && !/[\\/\x00-\x1f\x7f]/.test(id), "Invalid voice ID"),
});
export const VoiceLookupResult = LibraryVoice.extend({ usable: z.boolean(), reason: z.string() });
export type VoiceLookup = z.infer<typeof VoiceLookupInput>;
export const VoiceSearchResult = z.object({ voices: z.array(LibraryVoice) });
export type VoiceSearch = z.infer<typeof VoiceSearchInput>;

const fixedDefinitions = { grok: GROK_REALTIME, openai: OPENAI_REALTIME, gemini: GEMINI_LIVE };
function fixedVoice(provider: Exclude<VoiceSearch["provider"], "elevenlabs">, id: string) {
  return { provider, id, name: id, description: null, labels: {}, publicOwnerId: null, previewUrl: null, category: null };
}

/** Fresh library metadata only; neither the credential nor provider error bodies leave this boundary. */
export async function searchVoices(input: VoiceSearch, key: () => Promise<string | undefined>, request: typeof fetch = fetch) {
  const limit = Number(input.limit);
  if (input.provider !== "elevenlabs") {
    const provider = input.provider;
    const voices = input.category ? [] : fixedDefinitions[provider].voices.filter(id => id.toLowerCase().includes(input.q.toLowerCase())).slice(0, limit);
    return { voices: voices.map(id => fixedVoice(provider, id)) };
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
      publicOwnerId: voice.public_owner_id ?? null, previewUrl: voice.preview_url ?? null, category: voice.category ?? null,
    }));
    return VoiceSearchResult.parse({ voices });
  } catch {
    throw new HttpError(502, "ElevenLabs voice search failed", "VOICE_SEARCH_FAILED");
  }
}

/** Read-only exact lookup, following provisioning's account-copy and public-owner resolution. */
export async function getVoice(input: VoiceLookup, key: () => Promise<string | undefined>, request: typeof fetch = fetch) {
  if (input.provider !== "elevenlabs") {
    const supported = fixedDefinitions[input.provider].voices.some(id => id === input.id);
    if (!supported) throw new HttpError(404, "Unknown voice ID for this provider", "VOICE_NOT_FOUND");
    return { ...fixedVoice(input.provider, input.id), usable: true, reason: "Voice is in the provider's supported list" };
  }
  const apiKey = await key();
  if (!apiKey) throw new HttpError(400, "Voice lookup needs an ElevenLabs key: add one under Models & keys", "VOICE_LOOKUP_UNAVAILABLE");
  try {
    const get = (path: string) => request(`https://api.elevenlabs.io${path}`, {
      headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(15_000), cache: "no-store",
    });
    // As in the realtime resolver, an existing account copy can have a different ID.
    let accountId: string | undefined;
    let token: string | undefined;
    const tokens = new Set<string>();
    do {
      const query = new URLSearchParams({ page_size: "100", ...(token ? { next_page_token: token } : {}) });
      const response = await get(`/v2/voices?${query}`);
      if (!response.ok) throw new Error();
      const page = await response.json();
      if (!Array.isArray(page.voices)) throw new Error();
      accountId = page.voices.find((voice: any) => voice.voice_id === input.id || voice.sharing?.original_voice_id === input.id)?.voice_id;
      if (accountId) break;
      token = page.has_more ? page.next_page_token : undefined;
      if (page.has_more && (typeof token !== "string" || !token || tokens.has(token))) throw new Error();
      if (token) tokens.add(token);
    } while (token);
    const response = await get(`/v1/voices/${encodeURIComponent(accountId ?? input.id)}`);
    if (response.status === 404) throw new HttpError(404, "Voice was not found or is no longer available", "VOICE_NOT_FOUND");
    if (!response.ok) throw new Error();
    const voice = await response.json();
    if (voice.voice_id !== (accountId ?? input.id)) throw new Error();
    const sharing = voice.sharing;
    const owner = sharing?.public_owner_id;
    const retired = sharing?.status === "disabled" || sharing?.enabled_in_library === false ||
      (typeof sharing?.disable_at_unix === "number" && sharing.disable_at_unix > 0 && sharing.disable_at_unix <= Date.now() / 1000);
    const shared = typeof owner === "string" && owner.length > 0 && !retired;
    const usable = !!accountId || shared;
    return VoiceLookupResult.parse({
      provider: input.provider, id: input.id, name: voice.name ?? input.id,
      description: voice.description ?? null, labels: voice.labels ?? {},
      publicOwnerId: owner ?? null, previewUrl: voice.preview_url ?? null, category: voice.category ?? null,
      usable, reason: accountId ? "Voice is available in the account" : shared ? "Shared library voice can be added when a session starts" :
        retired ? "Voice is retired or sharing is disabled" : "Voice is not in the account and has no public owner for library import",
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "ElevenLabs voice lookup failed", "VOICE_LOOKUP_FAILED");
  }
}
