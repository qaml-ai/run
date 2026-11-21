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
 * ElevenLabs Agents' languages (the agent's `language`, for its speech recognition and Eleven v4's speech): lowercase
 * ISO 639-1, else ISO 639-3 where there is none.
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
