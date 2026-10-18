import { clock as nodeClock, type Clock } from "../node-context.ts";

/**
 * Barge-in that the bot's own voice cannot trigger (docs/guides/voice-calls.md, "Barge-in").
 *
 * Someone on laptop speakers, without headphones, sends the bot's speech back into the call: their mic hears it, and
 * Discord's echo cancellation does not always remove it. We only get their processed mic stream, so we cannot cancel it
 * ourselves. Barge-in on the first loud packet then cut the bot off about a second into every reply.
 *
 * So a person talking over the bot is a *candidate* first:
 *
 * 1. After `minMs` of speech over the bot, the media pauses playback (src/voice/media.ts). It holds the speech and
 *    does not throw it away. The person hears silence.
 * 2. The guard then decides from what was said. If the words are the bot's own (`echoVerdict`: in the same order as
 *    what it is saying or just said), or nothing was said, playback resumes where it paused. If they are other words,
 *    the bot stops (`barge_in`), as before.
 * 3. Without words: speech that goes on for `confirmMs` after the pause stops the bot. Echo cannot do that, because
 *    pausing silences what it echoes. At `resumeMs` the pause ends either way: the bot stops if they are still
 *    talking, and resumes if not.
 *
 * The guard only makes decisions; the session pauses, resumes and stops. Times come from the node's clock.
 */

export type BargeInPolicy = {
  /** Speech over the bot (ms, loud packets) before it pauses. Shorter sounds (a click, a cough) do nothing. */
  minMs: number;
  /**
   * Speech after the pause (ms) that stops the bot without waiting for its words. 0: no pause, the bot stops at
   * `minMs` (barge-in without the echo guard).
   */
  confirmMs: number;
  /** The longest pause (ms): then the bot stops if they are still talking, else goes on. */
  resumeMs: number;
};

export const DEFAULT_BARGE_IN: Readonly<BargeInPolicy> = Object.freeze({ minMs: 300, confirmMs: 1_000, resumeMs: 3_000 });
export const BARGE_IN_LIMITS = Object.freeze({
  minMs: { min: 0, max: 2_000 },
  confirmMs: { min: 0, max: 5_000 },
  resumeMs: { min: 500, max: 10_000 },
});

/** Speech heard within this long (ms) of now counts as still talking. */
const STILL_TALKING_MS = 300;
/** The bot's words compared against: the last this many. */
const BOT_WORDS = 120;

/** Lowercase, no accents or punctuation, single spaces: how words are compared. */
export function fold(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

const words = (text: string) => fold(text).split(" ").filter(Boolean);

/** The same word, allowing one slip (a letter dropped, added or changed) in words of four letters or more. */
function same(a: string, b: string) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, slips = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++slips > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return slips + (a.length - i) + (b.length - j) <= 1;
}

export type EchoVerdict = {
  /** echo: the bot's words; speech: someone else's; unsure: too few words to say. */
  verdict: "echo" | "speech" | "unsure";
  /** Words heard, and how many of them are the bot's in its order, in runs of two or more. */
  heard: number; matched: number;
  /** matched / heard. */
  score: number;
};

/**
 * Whether `heard` (a transcript of the interrupting speech) is the bot's own speech (`spoken`, oldest first) coming
 * back. Echo repeats the bot's words in its order. So the score counts the heard words that match the bot's words in
 * order (a longest common subsequence, allowing small spelling slips) in runs of two or more consecutive words. Words
 * shared by chance ("you", "that") rarely line up in runs.
 *
 * - Three words or more: echo when at least 60% are in such runs.
 * - Two words: echo when both are a run of the bot's.
 * - One word: speech if the bot did not say it, else unsure.
 */
export function echoVerdict(heard: string, spoken: readonly string[]): EchoVerdict {
  const h = words(heard);
  const b = spoken.flatMap(words).slice(-BOT_WORDS);
  const n = h.length;
  if (!n) return { verdict: "unsure", heard: 0, matched: 0, score: 0 };
  if (n === 1) {
    const said = b.some(word => same(word, h[0]));
    return { verdict: said ? "unsure" : "speech", heard: 1, matched: said ? 1 : 0, score: said ? 1 : 0 };
  }
  // Longest common subsequence, then the pairs it aligned, in order.
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = same(h[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (same(h[i], b[j]) && table[i][j] === table[i + 1][j + 1] + 1) { pairs.push([i, j]); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  // A pair in a run: next to an aligned neighbour on both sides (the bot's side may skip a word the transcript dropped).
  const runs = (a: [number, number], z: [number, number]) => z[0] - a[0] === 1 && z[1] - a[1] >= 1 && z[1] - a[1] <= 2;
  let matched = 0;
  for (let k = 0; k < pairs.length; k++) {
    if ((k > 0 && runs(pairs[k - 1], pairs[k])) || (k + 1 < pairs.length && runs(pairs[k], pairs[k + 1]))) matched++;
  }
  const score = matched / n;
  const echo = n === 2 ? matched === 2 : score >= 0.6;
  return { verdict: echo ? "echo" : "speech", heard: n, matched, score: Math.round(score * 100) / 100 };
}

/** Why a candidate stopped the bot, or why it did not. */
export type BargeInOutcome =
  | { type: "confirmed"; why: "words" | "sustained" | "immediate"; pausedMs: number; speechMs: number }
  | { type: "echo_rejected"; why: "echo" | "no_words" | "timeout"; pausedMs: number; speechMs: number; score?: number };

export type GuardHooks = {
  /** Whether the bot is saying something now (being made or playing). */
  speaking(): boolean;
  /** What the bot is saying and just said, oldest first. */
  spoken(): string[];
  /** It was someone talking: stop the bot (and end the pause). */
  stop(outcome: Extract<BargeInOutcome, { type: "confirmed" }>): void;
  /** It was not: playback resumes where it paused. */
  resume(outcome: Extract<BargeInOutcome, { type: "echo_rejected" }>): void;
};

type Candidate = {
  speaker: string; startedAt: number; pausedAt: number;
  /** Their utterance's speech (ms) when it paused, and now; when they were last heard. */
  speechAtPause: number; speechMs: number; lastLoudAt: number;
  timer?: ReturnType<Clock["setTimeout"]>;
};

/** One session's barge-in decisions. */
export class BargeInGuard {
  readonly policy: BargeInPolicy;
  private readonly hooks: GuardHooks;
  private readonly clock: Clock;
  private readonly candidates = new Map<string, Candidate>();
  /** The longest of the pauses still open began then. */
  private pausedAt?: number;
  /**
   * Utterances judged echo before their final transcript (from partials): when each began, by speaker. Their final
   * transcript is echo too, so it is not delivered as theirs (`heard` answers echo for it).
   */
  private readonly echoed = new Map<string, number>();

  constructor(policy: Partial<BargeInPolicy>, hooks: GuardHooks, clock: Clock = nodeClock()) {
    this.policy = { ...DEFAULT_BARGE_IN, ...policy };
    this.hooks = hooks;
    this.clock = clock;
  }

  /** Whether playback is paused for a candidate. */
  get pausing() { return this.candidates.size > 0; }

  /**
   * The media paused playback: `speaker` talked over the bot for `speechMs` (their utterance began at `startedAt`). Answers
   * whether it is a candidate. If not, the bot was silent, and the caller ends the pause.
   */
  candidate(speaker: string, speechMs: number, startedAt = this.clock.now()): boolean {
    if (!this.hooks.speaking()) { if (!this.candidates.size) this.pausedAt = undefined; return false; }
    const now = this.clock.now();
    const existing = this.candidates.get(speaker);
    if (existing) { existing.speechMs = Math.max(existing.speechMs, speechMs); existing.lastLoudAt = now; return true; }
    const candidate: Candidate = { speaker, startedAt, pausedAt: now, speechAtPause: speechMs, speechMs, lastLoudAt: now };
    this.pausedAt ??= now;
    this.candidates.set(speaker, candidate);
    if (this.policy.confirmMs <= 0) { this.confirm(candidate, "immediate"); return true; }
    candidate.timer = this.clock.setTimeout(() => this.timeout(candidate), this.policy.resumeMs);
    (candidate.timer as { unref?: () => void }).unref?.();
    return true;
  }

  /** More speech from a speaker during the pause: their utterance's speech so far (ms). */
  progress(speaker: string, speechMs: number) {
    const candidate = this.candidates.get(speaker);
    if (!candidate) return;
    candidate.speechMs = Math.max(candidate.speechMs, speechMs);
    candidate.lastLoudAt = this.clock.now();
    if (candidate.speechMs - candidate.speechAtPause >= this.policy.confirmMs) this.confirm(candidate, "sustained");
  }

  /**
   * Words heard from a speaker: a partial transcript of their utterance so far, or its final transcript
   * (`final`, with the utterance's start, so an earlier utterance's late transcript is not taken for this one's). Answers
   * the verdict when it decided a candidate.
   */
  heard(speaker: string, text: string, final: boolean, startedAt?: number): EchoVerdict["verdict"] | undefined {
    const candidate = this.candidates.get(speaker);
    if (!candidate) {
      const echoedAt = this.echoed.get(speaker);
      if (!final || echoedAt === undefined) return undefined;
      // The final transcript of an utterance its partials already showed to be echo, not an earlier one's.
      if (startedAt !== undefined && startedAt < echoedAt - 250) return undefined;
      this.echoed.delete(speaker);
      return "echo";
    }
    if (final) this.echoed.delete(speaker);
    // An utterance cut before this one began.
    if (startedAt !== undefined && startedAt < candidate.startedAt - 250) return undefined;
    const verdict = echoVerdict(text, this.hooks.spoken());
    // A partial transcript's first words may be a first guess, or the start of someone quoting the bot: it takes two
    // words or more to stop the bot, and three to resume it. The whole transcript decides at once.
    if (verdict.verdict === "echo" && (final || verdict.heard >= 3)) {
      if (!final) this.echoed.set(speaker, candidate.startedAt);
      this.release(candidate, "echo", verdict.score);
      return "echo";
    }
    if (verdict.verdict === "speech" && (final || verdict.heard >= 2)) { this.confirm(candidate, "words"); return "speech"; }
    if (final) {
      // One word the bot said, or nothing at all: not someone taking the turn.
      this.release(candidate, verdict.heard ? "echo" : "no_words", verdict.heard ? verdict.score : undefined);
      return verdict.heard ? "echo" : "unsure";
    }
    return undefined;
  }

  /** The bot stopped for another reason (interrupt, DELETE, the session ending): no candidate is left. */
  clear() {
    for (const candidate of this.candidates.values()) this.clock.clearTimeout(candidate.timer);
    this.candidates.clear();
    this.pausedAt = undefined;
  }

  close() { this.clear(); this.echoed.clear(); }

  private timeout(candidate: Candidate) {
    if (this.candidates.get(candidate.speaker) !== candidate) return;
    if (this.clock.now() - candidate.lastLoudAt <= STILL_TALKING_MS) this.confirm(candidate, "sustained");
    else this.release(candidate, "timeout");
  }

  private pausedMs() { return this.pausedAt === undefined ? 0 : Math.max(0, Math.round(this.clock.now() - this.pausedAt)); }

  /** Someone is talking: the bot stops, and every candidate goes with it. */
  private confirm(candidate: Candidate, why: "words" | "sustained" | "immediate") {
    const outcome = { type: "confirmed" as const, why, pausedMs: why === "immediate" ? 0 : this.pausedMs(), speechMs: Math.round(candidate.speechMs) };
    this.clear();
    this.hooks.stop(outcome);
  }

  /** Not someone talking: forgotten; playback resumes once no other candidate holds the pause. */
  private release(candidate: Candidate, why: "echo" | "no_words" | "timeout", score?: number) {
    this.clock.clearTimeout(candidate.timer);
    this.candidates.delete(candidate.speaker);
    if (this.candidates.size) return;
    const outcome = { type: "echo_rejected" as const, why, pausedMs: this.pausedMs(), speechMs: Math.round(candidate.speechMs), ...(score !== undefined ? { score } : {}) };
    this.pausedAt = undefined;
    this.hooks.resume(outcome);
  }
}
