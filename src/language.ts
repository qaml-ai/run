import { HttpError } from "./http.ts";

/** The longest language tag an agent takes. */
export const MAX_LANGUAGE_LENGTH = 35;

const english = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * An agent's `language`: a BCP 47 tag ("en", "es-ES", "pt-BR", "zh-Hant") in its canonical form, or null for none.
 * Junk is refused: a tag that is not well formed, one with no primary language (private use, grandfathered), or one
 * whose language has no name.
 */
export function languageInput(value: unknown): string | null {
  if (value === null) return null;
  const refuse = () => new HttpError(400, `language must be a BCP 47 language tag of at most ${MAX_LANGUAGE_LENGTH} characters, such as "en", "es-ES", "pt-BR" or "zh-Hant", or null`);
  if (typeof value !== "string" || !value || value.length > MAX_LANGUAGE_LENGTH || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value)) throw refuse();
  let tag: string;
  try { tag = Intl.getCanonicalLocales(value)[0]; } catch { throw refuse(); }
  if (!tag || !english.of(new Intl.Locale(tag).language)) throw refuse();
  return tag;
}

/** A language's name in English and in itself: "Spanish (español)", or once where they are the same ("English"). */
export function languageName(tag: string): string {
  const inEnglish = new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  let own: string | undefined;
  try { own = new Intl.DisplayNames([tag], { type: "language" }).of(tag); } catch { own = undefined; }
  return own && own !== inEnglish ? `${inEnglish} (${own})` : inEnglish;
}

/**
 * The system prompt section for an agent's language: one fixed sentence per tag, so the prompt (and its cached prefix)
 * is the same text on every turn.
 */
export function languageInstructions(tag: string): string {
  return `Language: reply in ${languageName(tag)} by default. If the person clearly writes in another language, reply in that language instead.`;
}

/**
 * A tag's primary language as providers name it: lowercase ISO 639-1 where there is one ("pt-BR" → "pt", "som" → "so"),
 * with the deprecated codes some still use mapped to the current ones (iw → he, in → id, nb and nn → no; fil → tl).
 * Undefined for a tag that is not well formed.
 */
export function primaryLanguage(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  let base: string;
  try { base = new Intl.Locale(tag).language.toLowerCase(); } catch { return undefined; }
  return ({ iw: "he", in: "id", ji: "yi", nb: "no", nn: "no", fil: "tl" } as Record<string, string>)[base] ?? base;
}

/**
 * The languages OpenAI's transcription (`gpt-transcribe`, in the realtime input and POST /audio/transcriptions, on
 * OpenAI and Azure alike) takes as `language`: any other is refused (invalid_value, "Supported values are: …", as Azure
 * answered for "so" on 2026-10-29). Whisper's list; iw is taken as he.
 */
const OPENAI_TRANSCRIPTION_LANGUAGES = new Set((
  "af ar az be bg bs ca cs cy da de el en es et fa fi fr gl he hi hr hu hy id is it ja kk kn ko lt lv mi mk mr ms " +
  "ne nl no pl pt ro ru sk sl sr sv sw ta th tl tr uk ur vi zh"
).split(" "));

/** A language as OpenAI's transcription takes it (its base code), or undefined where it takes none: it detects the language then. */
export function openaiTranscriptionLanguage(tag: string | undefined): string | undefined {
  const base = primaryLanguage(tag);
  return base && OPENAI_TRANSCRIPTION_LANGUAGES.has(base) ? base : undefined;
}

/**
 * xAI Voice Agent's `language_hint` codes (docs.x.ai, speech-to-speech, "Supported Languages", 2026-10-29): Spanish,
 * Portuguese and Arabic only with a region. It ignores others, detecting the language instead.
 */
const GROK_LANGUAGES = ["en", "ar-EG", "ar-SA", "ar-AE", "bn", "zh", "fr", "de", "hi", "id", "it", "ja", "ko", "pt-BR", "pt-PT", "ru", "es-MX", "es-ES", "tr", "vi"];

/** A language as Grok's transcription takes it (the tag itself, else its base code), or undefined where it takes none. */
export function grokTranscriptionLanguage(tag: string | undefined): string | undefined {
  const base = primaryLanguage(tag);
  if (!tag || !base) return undefined;
  let region: string | undefined;
  try { region = new Intl.Locale(tag).region; } catch { return undefined; }
  return GROK_LANGUAGES.find(code => code === `${base}-${region}`) ?? GROK_LANGUAGES.find(code => code === base);
}

/**
 * ElevenLabs Agents' languages (the agent's `language`, for its speech recognition and Eleven v4's speech): lowercase
 * ISO 639-1, else ISO 639-3 where there is none (elevenlabs.io/docs, "What languages do you support?" and Eleven v4's
 * list, 2026-10-29).
 */
const ELEVENLABS_LANGUAGES = new Set((
  "af am ar hy as ast az be bn bs bg my yue ca ceb hr cs da nl en et fil fi fr ff gl ka de el gu ha he hi hu is id it " +
  "ja kn kk ko ky lo ln lt lg lb mk ms ml mt zh mi mr mn ne no oc or ps fa pl pt pa ro ru sr sn sd sk sl so ckb es sw " +
  "sv tg ta te th tr uk ur uz vi cy wo"
).split(" "));

/** A language as ElevenLabs Agents takes it, or undefined where it takes none. */
export function elevenlabsLanguage(tag: string | undefined): string | undefined {
  const base = primaryLanguage(tag);
  const code = base === "tl" ? "fil" : base;
  return code && ELEVENLABS_LANGUAGES.has(code) ? code : undefined;
}
