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
