import { fold } from "../echo-guard.ts";

/**
 * Floor control for a bot in a group call: whether a turn is for the bot (addressing).
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
 * Otherwise it is `not_addressed`: the session still delivers its event, and the realtime model hears it as context.
 */

export type AddressingPolicy = {
  mode: "always" | "addressed";
  /** The bot's names (wake words): "camel", "hey camel", a persona's name. */
  names: string[];
  conversationMs: number;
};
export const DEFAULT_ADDRESSING: AddressingPolicy = Object.freeze({ mode: "always", names: [], conversationMs: 20_000 }) as AddressingPolicy;

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

export class Floor {
  readonly policy: AddressingPolicy;
  private readonly now: () => number;
  /** Who the bot is talking with now, and until when. */
  private readonly conversations = new Map<string, number>();
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

  /**
   * Whether `speaker`'s turn is the bot's before its words are known (a realtime brain answers before a transcript):
   * always, alone, or in a conversation with the bot; undefined when only its words could say (it names the bot or
   * not). Changes nothing: `decide` does, once the words are known.
   */
  standing(speaker: string, humans?: number): Addressed["reason"] | undefined {
    if (this.policy.mode === "always") return "always";
    if (humans === 1) return "alone";
    if ((this.conversations.get(speaker) ?? 0) > this.now()) return "conversation";
    return undefined;
  }

  /** The bot answered `speaker`: the conversation goes on from now. */
  answered(speaker: string) {
    this.conversations.set(speaker, this.now() + this.policy.conversationMs);
  }
}
