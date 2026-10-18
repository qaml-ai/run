import { safeError } from "../metrics.ts";
import { openaiLiveTranscription, LIVE_TRANSCRIPTION_MODEL, type LiveOptions, type LiveTranscript, type LiveTranscription, type LiveTranscriptionProvider } from "../transcription-live.ts";
import type { TranscriptionCredentials } from "../transcription.ts";
import type { SocketFactory } from "./socket.ts";
import { assemblyaiLiveTranscription, ASSEMBLYAI_MODEL } from "./stt-assemblyai.ts";
import { DEEPGRAM_MODELS, deepgramFlux, deepgramLiveTranscription, type FluxTuning } from "./stt-deepgram.ts";
import { SONIOX_MODEL, sonioxLiveTranscription } from "./stt-soniox.ts";

/**
 * Streaming speech to text across providers: each named `<provider>/<model>` (deepgram/nova-3, deepgram/flux-general-en,
 * soniox/stt-rt-v3, assemblyai/universal-streaming-english, openai/gpt-live-transcribe), and an ordered chain of them
 * that fails over mid-turn. A chain keeps each utterance's audio until its transcript comes, so when a provider fails
 * (its connection drops, it errs, it does not answer a commit in `failoverMs`), the next one is given the utterance
 * whole and transcribes it; only when all fail does the commit reject, and the caller transcribes after (the batch
 * provider, OpenAI with its Azure deployment, is the last resort).
 */

/** The live providers a chain may name, with the model each streams by default. */
export const STT_PROVIDERS = ["deepgram", "soniox", "assemblyai", "openai"] as const;
export const DEFAULT_STT_MODELS: Record<string, string> = { deepgram: DEEPGRAM_MODELS.nova, soniox: SONIOX_MODEL, assemblyai: ASSEMBLYAI_MODEL, openai: LIVE_TRANSCRIPTION_MODEL };
/** Short names for models: deepgram/flux is Flux's English model. */
const ALIASES: Record<string, string> = { "deepgram/flux": `deepgram/${DEEPGRAM_MODELS.flux}`, "deepgram/nova": `deepgram/${DEEPGRAM_MODELS.nova}` };

/** `<provider>` or `<provider>/<model>` as `<provider>/<model>`; throws for a provider it does not know. */
export function sttReference(given: string): string {
  const [provider, ...rest] = given.trim().split("/");
  if (!(STT_PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown speech-to-text provider ${provider}: one of ${STT_PROVIDERS.join(", ")}`);
  const model = rest.join("/");
  if (model && !/^[A-Za-z0-9._-]{1,80}$/.test(model)) throw new Error(`Unknown speech-to-text model ${given}`);
  const reference = `${provider}/${model || DEFAULT_STT_MODELS[provider]}`;
  return ALIASES[reference] ?? reference;
}

/** Where each provider is dialled (an operator's proxy or a test's server), and the tuning some take. */
export type SttEndpoints = {
  openai?: string; deepgram?: string; soniox?: string; assemblyai?: string;
  socket?: SocketFactory; openaiDelay?: string; flux?: FluxTuning; commitTimeoutMs?: number;
};

/** The provider for a reference (`sttReference`). */
export function liveProvider(reference: string, endpoints: SttEndpoints = {}): LiveTranscriptionProvider {
  const [provider, model] = sttReference(reference).split("/") as [string, string];
  const { socket, commitTimeoutMs } = endpoints;
  const common = { ...(socket ? { socket } : {}), ...(commitTimeoutMs ? { commitTimeoutMs } : {}) };
  switch (provider) {
    case "deepgram": return model.startsWith("flux")
      ? deepgramFlux({ model, ...common, ...(endpoints.deepgram ? { baseUrl: endpoints.deepgram } : {}), ...(endpoints.flux ? { flux: endpoints.flux } : {}) })
      : deepgramLiveTranscription({ model, ...common, ...(endpoints.deepgram ? { baseUrl: endpoints.deepgram } : {}) });
    case "soniox": return sonioxLiveTranscription({ model, ...common, ...(endpoints.soniox ? { url: endpoints.soniox } : {}) });
    case "assemblyai": return assemblyaiLiveTranscription({ model, ...common, ...(endpoints.assemblyai ? { baseUrl: endpoints.assemblyai } : {}) });
    default: return openaiLiveTranscription({ model, ...(endpoints.openai ? { baseUrl: endpoints.openai } : {}), ...(endpoints.openaiDelay ? { delay: endpoints.openaiDelay } : {}), ...(socket ? { socket: socket as never } : {}) });
  }
}

/** A member of a chain: its provider, and its key for the stream's tenant (found when the chain first needs it). */
export type ChainMember = { provider: LiveTranscriptionProvider; key(): Promise<(TranscriptionCredentials & { platform: boolean }) | undefined> };

export const CHAIN_LIMITS = Object.freeze({
  /** A commit its provider has not answered by then goes to the next provider. */
  failoverMs: 3_000,
  /** The most audio kept for a commit not yet answered (2 minutes): enough for any utterance. */
  replayBytes: 2 * 60 * 24_000 * 2,
  /** A connection that closes by itself sooner than this after opening has failed (the next member serves); later, it is reopened. */
  healthyMs: 5_000,
});

type Outstanding = { audio: Uint8Array[]; resolve(transcript: LiveTranscript): void; reject(error: Error): void; done: boolean };
type Active = { stream: LiveTranscription; member: ChainMember; platform: boolean; index: number; openedAt: number };

/**
 * A stream over a chain of providers, tried in order: the first with a key that can stream serves, and on failure the
 * next. Each transcript names its `provider` and whether the platform's key made it (`platform`).
 */
export function chainedLive(members: ChainMember[], options: LiveOptions & { failoverMs?: number; log?: Record<string, unknown> } = {}): LiveTranscription {
  return new ChainedLive(members, options);
}

class ChainedLive implements LiveTranscription {
  private readonly members: ChainMember[];
  private readonly options: LiveOptions & { failoverMs?: number; log?: Record<string, unknown> };
  private active?: Active;
  private connecting = false;
  /** The next member to try. */
  private next = 0;
  private exhausted = false;
  private ended = false;
  private closing = false;
  /** Commits waiting for transcripts, oldest first, each with its audio (for the next provider, should this one fail). */
  private readonly outstanding: Outstanding[] = [];
  /** Audio since the last commit or clear. */
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(members: ChainMember[], options: ChainedLive["options"]) {
    this.members = members;
    this.options = options;
    this.connect();
  }

  get closed() { return this.ended || this.exhausted; }

  append(pcm: Uint8Array) {
    if (this.closed || !pcm.byteLength) return;
    this.pending.push(pcm);
    this.pendingBytes += pcm.byteLength;
    // An utterance runs on past what is kept: its oldest audio is not replayed.
    while (this.pendingBytes > CHAIN_LIMITS.replayBytes && this.pending.length > 1) this.pendingBytes -= this.pending.shift()!.byteLength;
    const active = this.usable();
    if (active) active.stream.append(pcm);
  }

  commit(): Promise<LiveTranscript> {
    if (this.closed) return Promise.reject(new Error(this.exhausted ? "No provider can transcribe live" : "The live transcription is closed"));
    const { promise, resolve, reject } = Promise.withResolvers<LiveTranscript>();
    const entry: Outstanding = { audio: this.pending, resolve, reject, done: false };
    this.pending = [];
    this.pendingBytes = 0;
    this.outstanding.push(entry);
    const active = this.usable();
    if (active) this.send(active, entry);
    return promise;
  }

  clear() {
    if (this.closed) return;
    this.pending = [];
    this.pendingBytes = 0;
    this.usable()?.stream.clear();
  }

  close(graceful = false) {
    if (this.ended) return;
    if (graceful && this.outstanding.length) { this.closing = true; return; }
    this.ended = true;
    this.active?.stream.close(graceful);
    this.active = undefined;
    for (const entry of this.outstanding.splice(0)) this.settle(entry, new Error("The live transcription is closed"));
  }

  /** The stream to use now; one that closed by itself (idle, the provider's limit) with nothing waiting is reopened. */
  private usable(): Active | undefined {
    const active = this.active;
    if (active?.stream.closed && !this.outstanding.length) {
      // One that lasted a while is reopened; one that closed soon after opening failed: the next member.
      const lasted = Date.now() - active.openedAt >= CHAIN_LIMITS.healthyMs;
      if (!lasted) console.error(JSON.stringify({ type: "voice_stt_failover", provider: active.member.provider.id, model: active.member.provider.model, to: this.members[active.index + 1]?.provider.id ?? null, ...this.options.log, error: "closed soon after opening" }));
      this.active = undefined;
      this.next = lasted ? active.index : active.index + 1;
      this.connect();
      return undefined;
    }
    return active;
  }

  /** Open the next member that has a key and can stream; then hand it what is waiting, in order. */
  private connect() {
    if (this.connecting || this.ended) return;
    this.connecting = true;
    void (async () => {
      while (this.next < this.members.length && !this.ended) {
        const index = this.next++;
        const member = this.members[index];
        const key = await member.key().catch(error => {
          // A refusal (spent credit) or a lookup failure: the next member.
          console.error(JSON.stringify({ type: "voice_stt_key_failed", provider: member.provider.id, ...this.options.log, error: safeError(error) }));
          return undefined;
        });
        if (!key || this.ended) continue;
        const { platform, ...credentials } = key;
        let stream: LiveTranscription | undefined;
        try { stream = member.provider.connect(credentials, this.options); } catch (error) {
          console.error(JSON.stringify({ type: "voice_stt_connect_failed", provider: member.provider.id, model: member.provider.model, ...this.options.log, error: safeError(error) }));
        }
        if (!stream) continue;
        const active: Active = { stream, member, platform, index, openedAt: Date.now() };
        this.active = active;
        this.connecting = false;
        // The commits waiting, each with its audio, then the audio since: as the stream would have had them.
        for (const entry of this.outstanding) {
          for (const pcm of entry.audio) stream.append(pcm);
          this.send(active, entry);
        }
        for (const pcm of this.pending) stream.append(pcm);
        return;
      }
      this.connecting = false;
      if (this.ended) return;
      this.exhausted = true;
      for (const entry of this.outstanding.splice(0)) this.settle(entry, new Error("No provider could transcribe live"));
    })();
  }

  private send(active: Active, entry: Outstanding) {
    const failoverMs = this.options.failoverMs ?? CHAIN_LIMITS.failoverMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${active.member.provider.id} did not answer within ${failoverMs} ms`)), failoverMs); timer.unref?.(); });
    void Promise.race([active.stream.commit(), late]).then(transcript => {
      clearTimeout(timer);
      this.settle(entry, { ...transcript, provider: active.member.provider.id, platform: active.platform });
    }, error => {
      clearTimeout(timer);
      if (!entry.done) this.failover(active, error as Error);
    });
  }

  /** The serving provider failed: the next one takes over, with every commit still waiting and the audio since. */
  private failover(failed: Active, error: Error) {
    if (this.active !== failed || this.ended) return;
    console.error(JSON.stringify({ type: "voice_stt_failover", provider: failed.member.provider.id, model: failed.member.provider.model, to: this.members[failed.index + 1]?.provider.id ?? null, ...this.options.log, error: safeError(error) }));
    this.active = undefined;
    failed.stream.close();
    this.next = failed.index + 1;
    this.connect();
  }

  private settle(entry: Outstanding, outcome: LiveTranscript | Error) {
    if (entry.done) return;
    entry.done = true;
    const index = this.outstanding.indexOf(entry);
    if (index >= 0) this.outstanding.splice(index, 1);
    if (outcome instanceof Error) entry.reject(outcome);
    else entry.resolve(outcome);
    if (this.closing && !this.outstanding.length) this.close();
  }
}
