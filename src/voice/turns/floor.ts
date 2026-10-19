import { fold } from "../echo-guard.ts";

/**
 * Floor control for a bot in a group call: whether a turn is for the bot (addressing), and which of its replies still
 * deserve to be said (one reply at a time per call, a newer turn superseding an older reply not yet heard).
 *
 * Addressing is rules, not a model: language models pick a multi-party addressee near chance. A turn is the bot's when
 *
 * - it is alone with the bot: one person in the call (`alone`);
 * - it names the bot: one of `names` (its wake words), as a word or phrase anywhere in it, a near miss of a long name
 *   included, as speech recognition spells names (`named`);
 * - its speaker is in a conversation with the bot: the bot answered them, or they named it, within `conversationMs`
 *   (`conversation`), unless someone else named it since (the bot then talks with them);
 * - or the mode is `always` (every turn, as before floor control).
 *
 * Otherwise it is `not_addressed`: the session still delivers its event, and keeps it as context for the next turn
 * that is the bot's (the call's last `contextTurns`, within `contextMs`).
 */

export type AddressingPolicy = {
  mode: "always" | "addressed";
  /** The bot's names (wake words): "camel", "hey camel", a persona's name. */
  names: string[];
  conversationMs: number;
  /** Turns kept as context for the next one that is the bot's, and for how long. */
  contextTurns: number; contextMs: number;
};
export const DEFAULT_ADDRESSING: AddressingPolicy = Object.freeze({ mode: "always", names: [], conversationMs: 20_000, contextTurns: 8, contextMs: 120_000 }) as AddressingPolicy;

export type Addressed = { addressed: boolean; reason: "always" | "alone" | "named" | "conversation" | "not_addressed" };

/** Levenshtein distance, stopping once past `max`. */
function distance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

/** Whether `text` says one of `names`: each name's words in a row, a word of 5+ letters allowed one edit. */
export function mentions(text: string, names: readonly string[]) {
  const words = fold(text).split(" ").filter(Boolean);
  const joined = words.join("");
  for (const name of names) {
    const parts = fold(name).split(" ").filter(Boolean);
    if (!parts.length) continue;
    // Scripts without spaces (CJK): the name anywhere in the text.
    if (/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u.test(parts.join("")) && joined.includes(parts.join(""))) return true;
    for (let i = 0; i + parts.length <= words.length; i++) {
      if (parts.every((part, k) => {
        const word = words[i + k];
        if (word === part) return true;
        // "camel's", "camels": the name with a short ending.
        if (word.startsWith(part) && word.length - part.length <= 2 && part.length >= 4) return true;
        return part.length >= 5 && distance(word, part, 1) <= 1;
      })) return true;
    }
  }
  return false;
}

type Turn = { speaker: string; text: string; at: number };

export class Floor {
  readonly policy: AddressingPolicy;
  private readonly now: () => number;
  /** Who the bot is talking with now, and until when. */
  private readonly conversations = new Map<string, number>();
  private readonly recent: Turn[] = [];
  readonly stats = { turns: 0, addressed: 0, named: 0, conversation: 0, alone: 0, ignored: 0 };

  constructor(policy: Partial<AddressingPolicy> = {}, now: () => number = Date.now) {
    this.policy = { ...DEFAULT_ADDRESSING, ...policy };
    this.now = now;
  }

  /** Whether `speaker`'s turn (`text`) is the bot's; `humans`: how many people are in the call (undefined: not known). */
  decide(speaker: string, text: string, humans?: number): Addressed {
    this.stats.turns++;
    const now = this.now();
    const named = this.policy.names.length > 0 && mentions(text, this.policy.names);
    let reason: Addressed["reason"];
    if (named) {
      reason = "named";
      // Named by one person: the bot talks with them; someone else it was talking with must name it again.
      for (const other of [...this.conversations.keys()]) if (other !== speaker) this.conversations.delete(other);
    } else if (this.policy.mode === "always") reason = "always";
    else if (humans === 1) reason = "alone";
    else if ((this.conversations.get(speaker) ?? 0) > now) reason = "conversation";
    else reason = "not_addressed";
    const addressed = reason !== "not_addressed";
    if (addressed) {
      this.conversations.set(speaker, now + this.policy.conversationMs);
      this.stats.addressed++;
      if (reason === "named" || reason === "conversation" || reason === "alone") this.stats[reason]++;
    } else this.stats.ignored++;
    return { addressed, reason };
  }

  /** The bot answered `speaker`: the conversation goes on from now. */
  answered(speaker: string) {
    this.conversations.set(speaker, this.now() + this.policy.conversationMs);
  }

  /** Keep a turn the bot was not asked about, as context for the next it is. */
  overheard(speaker: string, text: string) {
    this.recent.push({ speaker, text, at: this.now() });
    while (this.recent.length > this.policy.contextTurns) this.recent.shift();
  }

  /** The turns overheard since the bot was last asked (within contextMs), and forgets them: they go with this turn. */
  takeContext(): Turn[] {
    const since = this.now() - this.policy.contextMs;
    const turns = this.recent.filter(turn => turn.at >= since);
    this.recent.length = 0;
    return turns;
  }
}

/** A turn's prompt with what was said around it: who said what before (`<@id>: text`), then the turn itself. */
export function withContext(text: string, context: { speaker: string; text: string }[]) {
  if (!context.length) return text;
  return `[Said in the call before this, not to you]\n${context.map(turn => `<@${turn.speaker}>: ${turn.text}`).join("\n")}\n[To you]\n${text}`;
}
