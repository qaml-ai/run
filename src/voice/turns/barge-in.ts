import type { TurnClock, TurnEvent } from "./turn-taker.ts";

/**
 * Barge-in that works in a group call: who talks while the bot speaks does not stop it at their first sound.
 *
 * - Speech starting while the bot speaks ducks it at once (`duck`: the pipeline pauses playback), so the bot does not
 *   talk over them while it finds out what this is.
 * - It becomes a barge-in (`barge_in`: stop the speech, and what was to follow) once they have talked over it for
 *   `minMs` and, when their words are known (interim transcripts), said at least `minWords` that are not a
 *   backchannel ("mm-hm", "yeah", "ok", in many languages) and are not the bot's own words coming back through their
 *   speakers (echo). Without transcripts, `noTranscriptMs` of speech is enough.
 * - Otherwise it was not one: a backchannel or a cough (`backchannel`, when their words said so), or nothing real
 *   within `resumeMs` of the duck. Playback resumes (`unduck`) where it was paused.
 *
 * Pure decisions: TurnTaker's events and transcripts in, these events out; the session acts on them.
 */

export type BargeInPolicy = {
  /** Talking over the bot this long (ms of speech) before it can stop the bot. */
  minMs: number;
  /** With transcripts: words beyond backchannels and echo that it takes. */
  minWords: number;
  /** Without transcripts: speech this long stops the bot. */
  noTranscriptMs: number;
  /** Ducked this long with nothing real, playback resumes. */
  resumeMs: number;
  /** More backchannel words or phrases (lowercase), beyond BACKCHANNELS. */
  backchannels: string[];
};
export const DEFAULT_BARGE_IN: BargeInPolicy = Object.freeze({ minMs: 400, minWords: 1, noTranscriptMs: 700, resumeMs: 2_000, backchannels: [] }) as BargeInPolicy;

/**
 * Words people say to show they listen, not to take the turn, in the languages Smart Turn knows (and a few more).
 * Matched against a whole interim transcript, folded (lowercase, no accents or punctuation), word by word.
 */
export const BACKCHANNELS: readonly string[] = Object.freeze([
  // English
  "mm", "mhm", "mmhm", "mm hm", "mm hmm", "uh huh", "uhhuh", "hmm", "hm", "yeah", "yea", "yep", "yup", "yes", "ok", "okay", "right", "sure",
  "i see", "got it", "cool", "nice", "wow", "oh", "ah", "aha", "true", "exactly", "totally", "indeed", "alright", "all right", "go on", "sounds good",
  // Spanish, Portuguese, Italian, French
  "si", "sí", "vale", "claro", "ya", "aja", "ajá", "bueno", "sim", "ta", "tá", "uhum", "isso", "certo", "beleza", "va bene", "certo", "esatto",
  "oui", "ouais", "d accord", "dac", "voila", "voilà", "exact", "bien sur",
  // German, Dutch, Scandinavian
  "ja", "genau", "jo", "stimmt", "klar", "achso", "ach so", "okay", "jawohl", "precies", "inderdaad", "klopt", "nee", "nej", "nei", "jaha", "mm ja",
  // Slavic, Turkish, Finnish
  "da", "tak", "aha", "ага", "да", "угу", "так", "evet", "tamam", "he", "joo", "niin", "kyllä",
  // Hindi, Bengali, Marathi, Arabic, Indonesian, Vietnamese
  "haan", "han", "ha", "accha", "achha", "theek", "ji", "हाँ", "हां", "अच्छा", "ঠিক", "হ্যাঁ", "होय", "نعم", "اه", "أيوه", "iya", "oke", "ya", "vâng", "dạ", "ừ", "uh",
  // Chinese, Japanese, Korean
  "嗯", "对", "對", "是", "好", "哦", "はい", "うん", "ええ", "そう", "なるほど", "네", "응", "예", "그래",
]);

export type BargeInEvent =
  | { type: "duck"; speaker: string; at: number }
  | { type: "unduck"; speaker: string; at: number; why: "backchannel" | "short" | "echo" | "timeout" }
  | { type: "barge_in"; speaker: string; at: number; words?: string; speechMs: number }
  | { type: "backchannel"; speaker: string; at: number; words: string };

/** Lowercase, no accents or punctuation, single spaces: how words are compared. */
export function fold(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Whether all of `text` is backchannel: each word, or each pair, in the lexicon (and some text at all). */
export function isBackchannel(text: string, extra: readonly string[] = []) {
  const lexicon = new Set([...BACKCHANNELS, ...extra].map(fold));
  const words = fold(text).split(" ").filter(Boolean);
  if (!words.length) return false;
  // CJK has no spaces: a short run that is in the lexicon whole, or made of its one-character words.
  if (words.length === 1 && /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u.test(words[0])) {
    const word = words[0];
    return lexicon.has(word) || [...word].every(char => lexicon.has(char));
  }
  for (let i = 0; i < words.length;) {
    if (i + 1 < words.length && lexicon.has(`${words[i]} ${words[i + 1]}`)) { i += 2; continue; }
    if (!lexicon.has(words[i])) return false;
    i++;
  }
  return true;
}

/**
 * Words of `heard` beyond backchannels and beyond the bot's own words (`spoken`: what it is saying now): echo of the
 * bot through a speaker's speakers is its words; most of a candidate's words in the bot's text is echo.
 */
export function realWords(heard: string, spoken: string | undefined, extra: readonly string[] = []): { words: string[]; echo: boolean } {
  const lexicon = new Set([...BACKCHANNELS, ...extra].map(fold));
  const words = fold(heard).split(" ").filter(Boolean);
  const bot = new Set(spoken ? fold(spoken).split(" ").filter(Boolean) : []);
  const content = words.filter(word => !lexicon.has(word));
  const fromBot = content.filter(word => bot.has(word)).length;
  const echo = content.length >= 2 && fromBot / content.length >= 0.6;
  return { words: echo ? [] : content, echo };
}

type Candidate = { speaker: string; at: number; speechMs: number; words: string; timer?: unknown; done?: boolean };

export class BargeIn {
  readonly policy: BargeInPolicy;
  private readonly clock: TurnClock;
  private readonly listeners = new Set<(event: BargeInEvent) => void>();
  /** What the bot is saying now (null: silent). */
  private speaking: string | null = null;
  private readonly candidates = new Map<string, Candidate>();
  /** Whether playback is ducked, and for whom. */
  private ducked = new Set<string>();
  readonly stats = { ducks: 0, bargeIns: 0, backchannels: 0, falseInterruptions: 0, echoes: 0 };

  constructor(policy: Partial<BargeInPolicy> = {}, clock: TurnClock) {
    this.policy = { ...DEFAULT_BARGE_IN, ...policy };
    this.clock = clock;
  }

  on(listener: (event: BargeInEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** The bot started saying `text`, or stopped (null): candidates end with it. */
  botSpeaking(text: string | null) {
    this.speaking = text;
    if (text === null) {
      for (const candidate of this.candidates.values()) this.clock.clearTimeout(candidate.timer);
      this.candidates.clear();
      this.ducked.clear();
    }
  }

  /** A turn event (TurnTaker's), with the speech so far of the speaker's turn when known. */
  turn(event: TurnEvent, speechMs?: number) {
    if (event.type === "speech_start") this.started(event.speaker, event.at);
    else if (event.type === "turn_end") this.ended(event.speaker, event.speechMs);
    else if (speechMs !== undefined) this.progress(event.speaker, speechMs);
  }

  /** More of a speaker's speech while their turn is open (ms of speech in it so far). */
  progress(speaker: string, speechMs: number) {
    const candidate = this.candidates.get(speaker);
    if (!candidate || candidate.done) return;
    candidate.speechMs = Math.max(candidate.speechMs, speechMs);
    this.decide(candidate);
  }

  /** An interim transcript of a speaker's current turn (all of it so far). */
  interim(speaker: string, text: string) {
    const candidate = this.candidates.get(speaker);
    if (!candidate || candidate.done) return;
    candidate.words = text;
    this.decide(candidate);
  }

  close() {
    this.botSpeaking(null);
    this.listeners.clear();
  }

  private emit(event: BargeInEvent) { for (const listener of this.listeners) listener(event); }

  private started(speaker: string, at: number) {
    if (this.speaking === null || this.candidates.has(speaker)) return;
    const candidate: Candidate = { speaker, at, speechMs: 0, words: "" };
    this.candidates.set(speaker, candidate);
    this.duck(speaker, at);
    // Nothing real within resumeMs: it was not a barge-in.
    candidate.timer = this.clock.setTimeout(() => this.release(candidate, "timeout"), this.policy.resumeMs);
  }

  private ended(speaker: string, speechMs: number) {
    const candidate = this.candidates.get(speaker);
    if (!candidate || candidate.done) return;
    candidate.speechMs = Math.max(candidate.speechMs, speechMs);
    this.decide(candidate);
    if (candidate.done) return;
    // Their turn ended without becoming one: a backchannel, a cough, a word or two.
    const known = candidate.words.trim();
    if (known && isBackchannel(known, this.policy.backchannels)) {
      this.stats.backchannels++;
      this.emit({ type: "backchannel", speaker, at: this.clock.now(), words: known });
      this.release(candidate, "backchannel");
    } else this.release(candidate, "short");
  }

  private decide(candidate: Candidate) {
    if (candidate.done || this.speaking === null || candidate.speechMs < this.policy.minMs) return;
    const known = candidate.words.trim();
    let real: boolean;
    if (known) {
      const { words, echo } = realWords(known, this.speaking, this.policy.backchannels);
      if (echo) { this.stats.echoes++; this.release(candidate, "echo"); return; }
      real = words.length >= this.policy.minWords;
    } else real = candidate.speechMs >= this.policy.noTranscriptMs;
    if (!real) return;
    candidate.done = true;
    this.clock.clearTimeout(candidate.timer);
    this.candidates.delete(candidate.speaker);
    this.ducked.delete(candidate.speaker);
    this.stats.bargeIns++;
    this.emit({ type: "barge_in", speaker: candidate.speaker, at: this.clock.now(), ...(known ? { words: known } : {}), speechMs: candidate.speechMs });
  }

  private duck(speaker: string, at: number) {
    const first = !this.ducked.size;
    this.ducked.add(speaker);
    if (!first) return;
    this.stats.ducks++;
    this.emit({ type: "duck", speaker, at });
  }

  /** Not a barge-in: forgotten; playback resumes once no one else holds it ducked. */
  private release(candidate: Candidate, why: Extract<BargeInEvent, { type: "unduck" }>["why"]) {
    if (candidate.done) return;
    candidate.done = true;
    this.clock.clearTimeout(candidate.timer);
    this.candidates.delete(candidate.speaker);
    if (why !== "backchannel") this.stats.falseInterruptions++;
    if (!this.ducked.delete(candidate.speaker) || this.ducked.size || this.speaking === null) return;
    this.emit({ type: "unduck", speaker: candidate.speaker, at: this.clock.now(), why });
  }
}
