import { randomBytes } from "node:crypto";
import type { HttpError } from "./http.ts";
import { safeError } from "./metrics.ts";
import { SPEECH_RATE, type SpeechCredentials, type SpeechInput, type Synthesizer } from "./speech.ts";
import type { Served } from "./voice-providers/tts-chain.ts";
import type { TurnClock } from "./voice/latency.ts";

/**
 * A voice session's speech (voice-sessions.ts): what its bot was asked to say, said one at a time on the session's
 * connection. Each is made as it plays (speech.ts streams PCM, voice-audio.ts encodes 20 ms Opus packets as they come),
 * so the first audio goes out well before the whole is made. Stopping (a new speech that interrupts, a DELETE, a person
 * starting to talk with barge-in on, the session ending or moving) cuts the one playing and clears the queue; each
 * speech ends once, with what it made (and cost) so far.
 */

/** Something asked to be said. */
export type SpeechItem = {
  id: string; text: string; voice: string; instructions?: string; queuedAt: number;
  /** Part of an agent's reply the session speaks (agentReplies): the agent and its run. */
  reply?: { agent: string; requestId: string };
  /** The turn it answers (src/voice/latency.ts): its first audio, or how it ended without, ends the turn. */
  turn?: TurnClock;
};
/** How a speech ended: said whole, cut short (`by` whom), or failed. */
export type SpeechEnding = { reason: "done" | "interrupted" | "error"; by?: StopReason; seconds: number; costUsd: number; error?: string };
export type StopReason = "interrupt" | "requested" | "barge_in" | "end" | "handoff" | "budget";

/** A playback on a connection: done when its packets ran out (`done`), it was stopped, or it failed. */
export interface Playback {
  done: Promise<"done" | "stopped" | "error">; stop(): void;
  /** Packets sent, the time spent waiting for the next packet (speech still being made), and time held back by why. */
  stats?(): { packets: number; startMs: number; waitedMs: number; gapMs: number; heldMs: Record<string, number> };
}
/**
 * Where speech plays: a session's media (src/voice/media.ts). `pcm` is the speech as it is made (24 kHz mono 16-bit,
 * as speech.ts makes it), which the media encodes; `started` is called as its first packet goes out.
 */
export interface Player { play(pcm: AsyncIterable<Uint8Array>, started: () => void): Playback }

/** What a session's speech needs of it: the connection, the money checks, and where its events and usage go. */
export interface SpeechEffects {
  /** The connection to play on now, if the session has one that can play. */
  player(): Player | undefined;
  /** The tenant may spend (run limit); throws a 402 HttpError otherwise. */
  admit(): Promise<void>;
  /** Holds `usd` of the end user's credit, where the tenant meters end users; throws 402 END_USER_CREDIT. */
  hold(usd: number, speech: string): Promise<{ settle(usd: number): Promise<void>; release(): Promise<void> } | undefined>;
  /** Waits for a fresh lease: a node cut off from the cluster makes no effects. */
  fresh(): Promise<void>;
  credentials(): Promise<SpeechCredentials & { platform: boolean }>;
  /**
   * Speech through the session's chain of providers (Synthesizer.speak), which calls `served` before its first audio;
   * without it, the built-in provider on `credentials`. `estimate` and `cost` then price it (USD): before, at most what
   * its text costs; after, what the provider that served billed for it.
   */
  speak?(input: SpeechInput, signal: AbortSignal, served: (who: Served) => void): AsyncIterable<Uint8Array>;
  estimate?(text: string): number;
  cost?(who: Served, made: { characters: number; seconds: number }): number;
  /** The speech started playing, `latencyMs` after it was asked for. */
  started(item: SpeechItem, latencyMs: number, turn?: TurnClock): void;
  /** It ended; `platform` says whose key made it (usage), `served` which provider (when a chain made it). */
  ended(item: SpeechItem, ending: SpeechEnding, platform: boolean | undefined, served?: Served): void;
  /** The money ran out: the session ends (`budget`). */
  budget(limit: "tenant" | "end_user", endUserReason?: string): void;
}

/** Speeches waiting at most per session, and how long one waits for a connection to play on. */
export const SPEECH_QUEUE = Object.freeze({ max: 20, connectionWaitMs: 15_000 });

export const speechId = () => `sp_${randomBytes(12).toString("hex")}`;

/**
 * A speech being made: admitted, its credit held, and its provider's PCM read as fast as it comes (`pcm` replays it to
 * the player at the player's pace). `made` settles once the provider is done (or failed, or was stopped).
 */
type Making = {
  item: SpeechItem; abort: AbortController;
  ready: Promise<{ held: Awaited<ReturnType<SpeechEffects["hold"]>>; pcm: AsyncIterable<Uint8Array> } | { budget: { limit: "tenant" | "end_user"; endUserReason?: string } }>;
  made: Promise<void>;
  /** PCM samples made so far: what is billed. */
  samples: number;
  /** Whose key made it, and (through a chain of providers) which provider: known once it began. */
  platform?: boolean; served?: Served;
};

export class SessionSpeech {
  private readonly queue: SpeechItem[] = [];
  private current?: { item: SpeechItem; abort: AbortController; playback?: Playback; stoppedBy?: StopReason };
  /**
   * The next speech, made while the current one plays: begun once the current one's speech is all made, so a reply's
   * next sentence is ready when the one before it ends, and no provider round trip falls between them.
   */
  private ahead?: Making;
  private running = false;
  private closed = false;
  /** Bumped by each stop: a reply being spoken stops adding to the queue once what it was part of is stopped. */
  generation = 0;
  private readonly synthesizer: Synthesizer;
  private readonly effects: SpeechEffects;

  constructor(synthesizer: Synthesizer, effects: SpeechEffects) {
    this.synthesizer = synthesizer;
    this.effects = effects;
  }

  /** Whether a speech is being made or played now. */
  get speaking() { return !!this.current; }
  /** Speeches waiting behind the current one. */
  get waiting() { return this.queue.length; }

  /** Queue a speech (`interrupt`: stop what is playing and clear the queue first); answers its place: 0 plays next. */
  say(item: SpeechItem, interrupt = false) {
    if (interrupt) this.stop("interrupt");
    this.queue.push(item);
    void this.run();
    return this.queue.length - 1 + (this.current && !this.current.stoppedBy ? 1 : 0);
  }

  /** Stop the speech playing and clear the queue: each ends `interrupted`, `by`. Answers how many there were. */
  stop(by: StopReason) {
    this.generation++;
    const cleared = this.queue.splice(0);
    const ahead = this.ahead;
    this.ahead = undefined;
    for (const item of cleared) {
      item.turn?.end("interrupted");
      // One being made ahead ends once its making stops: what it made is billed, as for one cut short playing.
      if (ahead?.item === item) void this.abandon(ahead, by);
      else this.effects.ended(item, { reason: "interrupted", by, seconds: 0, costUsd: 0 }, undefined);
    }
    const current = this.current;
    if (current && !current.stoppedBy) {
      current.stoppedBy = by;
      current.abort.abort();
      current.playback?.stop();
    }
    return cleared.length + (current ? 1 : 0);
  }

  /** The session ended or moved: nothing more is said. */
  close(by: "end" | "handoff") {
    this.closed = true;
    this.stop(by);
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (let item; !this.closed && (item = this.queue.shift());) {
        const ahead = this.ahead?.item === item ? this.ahead : undefined;
        if (ahead) this.ahead = undefined;
        await this.speak(item, ahead);
      }
    } finally { this.running = false; }
  }

  /**
   * Begin making a speech: the tenant admitted and the end user's credit held for it (a 402 is `budget`), a fresh
   * lease, then its audio: through the session's chain of providers (which says who served), else the built-in
   * provider on its key; read as fast as it comes into a buffer the player drains.
   */
  private make(item: SpeechItem): Making {
    const abort = new AbortController();
    let made!: () => void;
    const making: Making = { item, abort, samples: 0, made: new Promise<void>(resolve => { made = resolve; }), ready: undefined as never };
    making.ready = (async () => {
      let held: Awaited<ReturnType<SpeechEffects["hold"]>>;
      try {
        await this.effects.admit();
        held = await this.effects.hold(this.effects.estimate?.(item.text) ?? this.synthesizer.cost(this.synthesizer.estimateSeconds(item.text)), item.id);
      } catch (refused) {
        if ((refused as HttpError).status !== 402) throw refused;
        const endUser = (refused as HttpError).code === "END_USER_CREDIT";
        const reason = (refused as HttpError).details?.reason;
        return { budget: { limit: endUser ? "end_user" as const : "tenant" as const, ...(endUser && typeof reason === "string" ? { endUserReason: reason } : {}) } };
      }
      try {
        await this.effects.fresh();
        const input = { text: item.text, voice: item.voice, ...(item.instructions ? { instructions: item.instructions } : {}) };
        const chain = this.effects.speak;
        let source: AsyncIterable<Uint8Array>;
        if (chain) source = chain(input, abort.signal, who => { making.served = who; making.platform = who.platform; });
        else {
          const credentials = await this.effects.credentials();
          making.platform = credentials.platform;
          source = this.synthesizer.stream(input, credentials, abort.signal);
        }
        // What was made is what is billed: counted as it comes from the provider.
        const pcm = counted(source, () => item.turn?.mark("ttsFirstAudio"), bytes => { making.samples += bytes >> 1; });
        return { held, pcm: eager(pcm, made) };
      } catch (error) {
        await held?.release().catch(() => {});
        throw error;
      }
    })();
    making.ready.then(ready => { if ("budget" in ready) made(); }, () => made());
    return making;
  }

  /** What a speech made so far cost (USD): at what the provider that served bills, else the built-in provider's price. */
  private costOf(making: Making, seconds: number) {
    if (!making.samples) return 0;
    return making.served && this.effects.cost ? this.effects.cost(making.served, { characters: making.item.text.length, seconds }) : this.synthesizer.cost(seconds);
  }

  /** The next speech in the queue begins being made, if none is yet. */
  private lookAhead() {
    const next = this.queue[0];
    if (this.closed || this.ahead || !next) return;
    this.ahead = this.make(next);
  }

  /** A speech made ahead that will not play (the queue was stopped): it ends with what it made, and that is billed. */
  private async abandon(making: Making, by: StopReason) {
    making.abort.abort();
    let held: Awaited<ReturnType<SpeechEffects["hold"]>>;
    try {
      const ready = await making.ready;
      if (!("budget" in ready)) held = ready.held;
    } catch { /* it failed before making anything */ }
    await making.made;
    const seconds = Math.round(making.samples / SPEECH_RATE * 100) / 100;
    const costUsd = this.costOf(making, seconds);
    if (held) await (making.samples ? held.settle(costUsd) : held.release()).catch(failure => console.error(JSON.stringify({ type: "voice_speech_credit_failed", speech: making.item.id, error: safeError(failure) })));
    this.effects.ended(making.item, { reason: "interrupted", by, seconds, costUsd }, making.platform, making.served);
  }

  private async speak(item: SpeechItem, ahead?: Making) {
    const making = ahead ?? this.make(item);
    const { abort } = making;
    const current: NonNullable<SessionSpeech["current"]> = { item, abort };
    this.current = current;
    let error: string | undefined, result: "done" | "stopped" | "error" = "error";
    let held: Awaited<ReturnType<SpeechEffects["hold"]>>;
    try {
      const ready = await making.ready;
      if ("budget" in ready) {
        current.stoppedBy = "budget";
        this.effects.budget(ready.budget.limit, ready.budget.endUserReason);
        return;
      }
      held = ready.held;
      if (current.stoppedBy) return;
      const player = await this.connected(abort.signal);
      if (current.stoppedBy) return;
      if (!player) throw new Error("No connection to speak on");
      // Once this speech is all made, the next one's making begins, while this one plays.
      void making.made.then(() => { if (this.current === current && !current.stoppedBy) this.lookAhead(); });
      current.playback = player.play(ready.pcm, () => {
        // The first speech of a turn ends it, and tells its stages; a turn's later pieces do not.
        const turn = item.turn && !item.turn.ended ? item.turn : undefined;
        turn?.mark("firstPacket").end("spoken");
        this.effects.started(item, Date.now() - item.queuedAt, turn);
      });
      if (current.stoppedBy) current.playback.stop();
      result = await current.playback.done;
    } catch (failure) {
      if (!current.stoppedBy) error = safeError(failure);
    } finally {
      abort.abort();
      await making.made;
      const seconds = Math.round(making.samples / SPEECH_RATE * 100) / 100;
      const costUsd = this.costOf(making, seconds);
      if (held) await (making.samples ? held.settle(costUsd) : held.release()).catch(failure => console.error(JSON.stringify({ type: "voice_speech_credit_failed", speech: item.id, error: safeError(failure) })));
      const ending: SpeechEnding = current.stoppedBy
        ? { reason: "interrupted", by: current.stoppedBy, seconds, costUsd }
        : result === "done" && !error ? { reason: "done", seconds, costUsd } : { reason: "error", seconds, costUsd, ...(error ? { error } : {}) };
      if (this.current === current) this.current = undefined;
      item.turn?.end(ending.reason === "done" ? "no_reply" : ending.reason);
      this.effects.ended(item, ending, making.platform, making.served);
    }
  }

  /** The connection to play on, waiting a while for one (a reconnect); undefined if none comes, or it was stopped. */
  private async connected(signal: AbortSignal) {
    const deadline = Date.now() + SPEECH_QUEUE.connectionWaitMs;
    for (;;) {
      const player = this.effects.player();
      if (player || signal.aborted || Date.now() >= deadline) return player;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

/**
 * `source` read as fast as it comes, into a buffer its reader drains at its own pace: the provider's stream is never
 * held up by playback, so its speech is all made (and `made` called) as soon as the provider can make it. The reader
 * gets what was buffered, then what follows, then the source's error if it failed.
 */
function eager(source: AsyncIterable<Uint8Array>, made: () => void): AsyncIterable<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let done = false, failure: unknown, wake: (() => void) | undefined;
  void (async () => {
    try { for await (const chunk of source) { chunks.push(chunk); wake?.(); } }
    catch (error) { failure = error; }
    finally { done = true; made(); wake?.(); }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (chunks.length) { yield chunks.shift()!; continue; }
        if (done) { if (failure) throw failure; return; }
        await new Promise<void>(resolve => { wake = resolve; });
        wake = undefined;
      }
    },
  };
}

/** `chunks` as they come: `first` called as the first arrives, `bytes` with each one's length. */
async function* counted(chunks: AsyncIterable<Uint8Array>, first: () => void, bytes: (count: number) => void): AsyncGenerator<Uint8Array> {
  let seen = false;
  for await (const chunk of chunks) {
    if (!chunk.byteLength) continue;
    if (!seen) { seen = true; first(); }
    bytes(chunk.byteLength);
    yield chunk;
  }
}

/** The most of an agent's reply a session speaks, and the longest piece spoken at once when a sentence runs on. */
export const REPLY_LIMITS = Object.freeze({
  chars: 400, pieceChars: 250,
  /**
   * A reply's first piece may end at a clause (a comma, semicolon, colon or dash) once it has this many characters, so
   * its first audio waits for a clause, not a whole sentence; the pieces after it are whole sentences.
   */
  firstClauseChars: 24,
});

/**
 * Text as it may be spoken: markdown's marks gone (emphasis, headings, list bullets, quotes, tables), a link's text
 * without its address, images and bare URLs gone, inline code's text kept without its backticks, whitespace folded.
 * Code blocks are left out before this (`SpokenReply`).
 */
export function speakable(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/\bhttps?:\/\/\S+/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/`/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

/**
 * An agent's reply as it streams, cut into pieces to speak as each is whole: sentences (at . ! ? or a line's end), or
 * at a comma or space when one runs past REPLY_LIMITS.pieceChars. Code blocks are left out; each piece is made
 * `speakable`; at most `limit` characters are spoken in all, the last piece cut at a word with an ellipsis.
 */
export class SpokenReply {
  private buffer = "";
  private fenced = false;
  private spoken = 0;
  private stopped = false;
  private readonly say: (text: string) => void;
  private readonly limit: number;

  constructor(say: (text: string) => void, limit: number = REPLY_LIMITS.chars) { this.say = say; this.limit = limit; }

  /** Whether it has spoken all it may. */
  get full() { return this.stopped; }

  push(delta: string) {
    if (this.stopped) return;
    this.buffer += delta;
    this.drain(false);
  }

  /** The reply is whole: what is left is the last piece. */
  end() {
    if (this.stopped) return;
    this.drain(true);
    if (!this.fenced) this.piece(this.buffer);
    this.buffer = "";
  }

  private drain(final: boolean) {
    for (;;) {
      if (this.stopped) return;
      if (this.fenced) {
        const close = this.buffer.indexOf("```");
        if (close < 0) { this.buffer = this.buffer.slice(-2); return; }
        const line = this.buffer.indexOf("\n", close + 3);
        if (line < 0 && !final) { this.buffer = this.buffer.slice(close); return; }
        this.buffer = line < 0 ? "" : this.buffer.slice(line + 1);
        this.fenced = false;
        continue;
      }
      const fence = this.buffer.indexOf("```");
      const prose = fence < 0 ? this.buffer : this.buffer.slice(0, fence);
      // The first piece goes as soon as a clause of it is whole.
      const end = sentenceEnd(prose, final || fence >= 0) || (this.spoken === 0 ? clauseEnd(prose) : 0);
      if (end > 0) {
        this.piece(prose.slice(0, end));
        this.buffer = this.buffer.slice(end);
        continue;
      }
      if (fence >= 0) {
        this.piece(prose);
        const line = this.buffer.indexOf("\n", fence + 3);
        if (line < 0 && !final) { this.buffer = this.buffer.slice(fence); return; }
        this.buffer = line < 0 ? "" : this.buffer.slice(line + 1);
        this.fenced = true;
        continue;
      }
      // A sentence that runs on is cut at a comma, else a space.
      if (prose.length > REPLY_LIMITS.pieceChars) {
        const window = prose.slice(0, REPLY_LIMITS.pieceChars);
        const cut = Math.max(window.lastIndexOf(", ") + 1, 0) || window.lastIndexOf(" ");
        const at = cut > 0 ? cut : REPLY_LIMITS.pieceChars;
        this.piece(prose.slice(0, at));
        this.buffer = this.buffer.slice(at);
        continue;
      }
      return;
    }
  }

  private piece(raw: string) {
    const text = speakable(raw);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    const room = this.limit - this.spoken;
    if (text.length <= room) {
      this.spoken += text.length + 1;
      this.say(text);
      if (this.spoken >= this.limit) this.stopped = true;
      return;
    }
    this.stopped = true;
    if (room < 20) return;
    const cut = text.slice(0, room).replace(/\s+\S*$/, "");
    if (cut) this.say(`${cut}…`);
  }
}

/** Where the first clause of `text` at least REPLY_LIMITS.firstClauseChars long ends (after its mark, with more after it), or 0. */
function clauseEnd(text: string): number {
  const pattern = /[,;:\u2014\u2013](?=\s+\S)|\s[-\u2013\u2014](?=\s+\S)/g;
  for (let match; (match = pattern.exec(text));) {
    const end = match.index + match[0].length;
    if (end >= REPLY_LIMITS.firstClauseChars) return end;
  }
  return 0;
}

/** Where the first whole sentence of `text` ends (after its mark, or its line), or 0 when none is whole yet. */
function sentenceEnd(text: string, final: boolean): number {
  const pattern = /[.!?…]+["'”’)\]]*(?=\s)|\n/g;
  for (let match; (match = pattern.exec(text));) {
    const end = match.index + match[0].length;
    if (end < text.length || final) return end;
  }
  return 0;
}
