import { safeError } from "../metrics.ts";
import { SpeechFailed, type SpeechCredentials, type SpeechInput, type SpeechProvider } from "../speech.ts";

/**
 * Speech made by the first of several providers that can (tts.ts has them): the chain voice sessions speak through.
 * Kept apart from tts.ts so speech.ts's Synthesizer can use it without importing every provider.
 */

/** A member of a speech chain: its provider, the voice it speaks in (its own: "" for its default), and its key. */
export type SpeechMember = { provider: SpeechProvider; voice: string; key(): Promise<(SpeechCredentials & { platform: boolean }) | undefined> };

/** Who made a speech: set before its first audio is yielded. */
export type Served = { provider: string; model: string; voice: string; platform: boolean };

export const SPEECH_CHAIN = Object.freeze({
  /** A provider that has not sent its first audio by then is passed over for the next (when there is one). */
  firstAudioMs: 3_000,
});

/**
 * A speech made by the first member that can: each in turn, skipping one without a key, and moving on when one fails
 * (or is slower than `firstAudioMs` to start) before any audio is out. `served` is called before the first chunk.
 * A refusal of the text itself (400) is not the provider's fault: the next one is tried too, since its rules differ.
 */
export async function* chainedSpeech(members: SpeechMember[], input: Omit<SpeechInput, "voice">, signal: AbortSignal,
  served: (who: Served) => void, options: { firstAudioMs?: number; log?: Record<string, unknown> } = {}): AsyncGenerator<Uint8Array> {
  let last: Error | undefined;
  for (const [index, member] of members.entries()) {
    if (signal.aborted) return;
    const more = index < members.length - 1;
    let key: Awaited<ReturnType<SpeechMember["key"]>>;
    try { key = await member.key(); } catch (error) { last = error as Error; continue; }
    if (!key) continue;
    const { platform, ...credentials } = key;
    const { voice } = member;
    // Its own abort, so a provider passed over stops making speech.
    const own = new AbortController();
    const onAbort = () => own.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const iterator = member.provider.stream({ ...input, voice }, credentials, own.signal)[Symbol.asyncIterator]();
    let first: IteratorResult<Uint8Array>;
    try {
      const firstAudioMs = options.firstAudioMs ?? SPEECH_CHAIN.firstAudioMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = more ? new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SpeechFailed(502, `${member.provider.id} made no audio within ${firstAudioMs} ms`)), firstAudioMs); }) : undefined;
      try { first = await (late ? Promise.race([iterator.next(), late]) : iterator.next()); } finally { clearTimeout(timer); }
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      own.abort();
      void iterator.return?.().catch(() => {});
      if (signal.aborted) throw error;
      last = error as Error;
      console.error(JSON.stringify({ type: "voice_tts_failover", provider: member.provider.id, model: member.provider.model, to: members[index + 1]?.provider.id ?? null, ...options.log, error: safeError(error) }));
      continue;
    }
    try {
      served({ provider: member.provider.id, model: member.provider.model, voice, platform });
      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      own.abort();
      void iterator.return?.().catch(() => {});
    }
  }
  throw last ?? new SpeechFailed(400, "No speech provider has a key: add one under Models & keys (PUT /v1/providers/<provider>/key)");
}
