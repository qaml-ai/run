import { safeError } from "../metrics.ts";
import { SpeechFailed, type SpeechCredentials, type SpeechInput, type SpeechProvider } from "../speech.ts";

/**
 * Speech made by the first of several providers that can (tts.ts has them): the chain POST /v1/speech speaks through.
 * Kept apart from tts.ts so speech.ts's Synthesizer can use it without importing every provider.
 */

/** A member of a speech chain: its provider, the voice it speaks in (its own: "" for its default), and its key. */
export type SpeechMember = { provider: SpeechProvider; voice: string; key(): Promise<(SpeechCredentials & { platform: boolean }) | undefined> };

/** Who made a speech: set before its first audio is yielded. */
export type Served = { provider: string; model: string; voice: string; platform: boolean };

export const SPEECH_CHAIN = Object.freeze({
  /**
   * A provider that has not sent audible audio by then (bytes of silence do not count: a provider may stream silence
   * and stall) is passed over for the next, when there is one.
   */
  firstAudioMs: 3_000,
  /** Audible: a 20 ms frame (24 kHz mono 16-bit) above -45 dBFS RMS. */
  audibleRms: 32_768 * 10 ** (-45 / 20),
});

/** Whether PCM fed to it in pieces (24 kHz mono s16le, split anywhere) has reached an audible 20 ms frame yet. */
class PcmLevel {
  private carry = Buffer.alloc(0);
  audible(chunk: Uint8Array): boolean {
    let pcm = Buffer.concat([this.carry, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
    const frame = 960;
    for (; pcm.length >= frame; pcm = pcm.subarray(frame)) {
      let sum = 0;
      for (let i = 0; i < frame; i += 2) sum += pcm.readInt16LE(i) ** 2;
      if (Math.sqrt(sum / (frame / 2)) > SPEECH_CHAIN.audibleRms) return true;
    }
    // A last piece shorter than a frame is judged as it is (a short speech's end).
    this.carry = Buffer.from(pcm);
    return false;
  }
  /** What is left over, less than a frame, judged alone. */
  rest(): boolean {
    if (this.carry.length < 2) return false;
    let sum = 0;
    for (let i = 0; i + 1 < this.carry.length; i += 2) sum += this.carry.readInt16LE(i) ** 2;
    return Math.sqrt(sum / (this.carry.length >> 1)) > SPEECH_CHAIN.audibleRms;
  }
}

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
    // What came before the first audible audio, held back (it is played once the provider is chosen), and whether the
    // stream ended there.
    const held: Uint8Array[] = [];
    let ended = false;
    try {
      const firstAudioMs = options.firstAudioMs ?? SPEECH_CHAIN.firstAudioMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // With another member to turn to, this one must make audible audio in time: silence, or a stream that stalls
      // after its first bytes, is passed over as an error would be. The last member is waited for.
      const late = more ? new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SpeechFailed(502, `${member.provider.id} made no audible audio within ${firstAudioMs} ms`)), firstAudioMs); }) : undefined;
      const level = new PcmLevel();
      let audible = false;
      try {
        for (;;) {
          const next = await (late ? Promise.race([iterator.next(), late]) : iterator.next());
          if (next.done) { ended = true; break; }
          held.push(next.value);
          if (!more) break;
          if (level.audible(next.value)) { audible = true; break; }
        }
      } finally { clearTimeout(timer); }
      if (more && !audible && !level.rest()) throw new SpeechFailed(502, `${member.provider.id} made ${held.some(chunk => chunk.byteLength) ? "only silence" : "no audio"}`);
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
      for (const chunk of held) yield chunk;
      if (ended) return;
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
