import { Worker } from "node:worker_threads";
import type { TurnModelsHost } from "./turns/inference.ts";
import type { VoiceCredentials, VoiceTransport } from "../voice-sessions.ts";
import type { Playback, PlayOptions } from "../voice-speech.ts";
import { metricLine, safeError, writeMetricLine } from "../metrics.ts";
import type { Media, MediaEvents, MediaFactory, MediaOptions } from "./media.ts";
import { fromWireCut, MEDIA_PROTOCOL, own, type FromMedia, type MediaWorkerInit, type ToMedia, type TransportSpec, type WorkerMemory } from "./protocol.ts";

/**
 * Voice media off the control thread (docs/operations/voice-pipeline.md, "Shape"): each session's media in a worker
 * thread, `sessionsPerWorker` to a worker (1 by default: a crash then ends only its own session's media). The host
 * supervises them: a worker that exits, throws, runs out of heap, stops ticking for `stallMs` or holds more than
 * `maxMb` is ended, and each of its sessions is told (`MediaEvents.crashed`), so it can restart its media in a fresh
 * worker. Nothing that happens in a worker reaches this thread as an exception: its messages are handled under guard.
 */

export type MediaHostOptions = {
  transport: TransportSpec;
  /** Whether the transport's connections can play speech. */
  speaks: boolean;
  /** Sessions per worker (AGENT_VOICE_SESSIONS_PER_WORKER): 1 isolates each session. */
  sessionsPerWorker?: number;
  /**
   * Workers at most (AGENT_VOICE_WORKERS): past them, a new session shares the worker holding fewest, so a node with
   * many sessions keeps its memory (a busy worker is ~25-30 MB: its heap and libopus's WebAssembly memory) bounded.
   */
  maxWorkers?: number;
  /** A worker's heap, other memory and WebAssembly together past this (AGENT_VOICE_WORKER_MAX_MB) is ended. */
  maxMb?: number;
  /** Its V8 heap's limit (resourceLimits: past it the worker ends with ERR_WORKER_OUT_OF_MEMORY). */
  heapMb?: number;
  /** How often a worker ticks, and how long without a tick ends it. */
  tickMs?: number;
  stallMs?: number;
  /** How long a session's close waits for its worker to flush what its speakers said. */
  closeMs?: number;
  /** Workers kept started and empty, so a session's media does not wait for one to load (1 by default). */
  spare?: number;
  /** The node's turn models (src/voice/turns): each worker gets a port to them, and another when one closes. */
  turnModels?: TurnModelsHost;
};

export const MEDIA_HOST_DEFAULTS = Object.freeze({ sessionsPerWorker: 1, maxWorkers: 16, maxMb: 256, heapMb: 128, tickMs: 1_000, stallMs: 5_000, closeMs: 2_000, spare: 1 });

const WORKER = new URL("./media-worker.ts", import.meta.url);

/** One worker and the sessions it holds. */
type ShardOptions = Required<Omit<MediaHostOptions, "transport" | "speaks" | "turnModels">> & { transport: TransportSpec; turnModels?: TurnModelsHost };

class Shard {
  readonly worker: Worker;
  readonly sessions = new Map<string, WorkerMedia>();
  /** Sessions it was given in all: a shard full once does not take new ones, so a long-lived one is not reused forever. */
  given = 0;
  lastTick = Date.now();
  /** Its heap and other memory at its last tick, as it reported them; and that memory split, for the log of its end. */
  mb = 0;
  memory?: WorkerMemory;
  dead?: string;
  private readonly onDead: (shard: Shard, reason: string) => void;

  private readonly turnModels?: TurnModelsHost;
  private readonly onModels: () => void;

  constructor(options: ShardOptions, onDead: (shard: Shard, reason: string) => void, onModels: () => void = () => {}) {
    this.onDead = onDead;
    this.onModels = onModels;
    this.turnModels = options.turnModels;
    const models = options.turnModels?.port();
    const init: MediaWorkerInit = { protocol: MEDIA_PROTOCOL, transport: options.transport, tickMs: options.tickMs, ...(models ? { models } : {}) };
    this.worker = new Worker(WORKER, { workerData: init, transferList: models ? [models as never] : [], resourceLimits: { maxOldGenerationSizeMb: options.heapMb, maxYoungGenerationSizeMb: 16 }, stdout: false, stderr: false });
    this.worker.unref();
    this.worker.on("message", (message: FromMedia) => {
      try { this.message(message, options.maxMb); }
      catch (error) { console.error(JSON.stringify({ type: "voice_media_message_failed", message: message?.t, error: safeError(error) })); }
    });
    // Its own code failed, not a user's: the error's code or name says which (ERR_WORKER_OUT_OF_MEMORY, a WebAssembly trap…).
    this.worker.on("error", error => this.died(`error: ${(error as { code?: string }).code ?? error.name}: ${error.message.slice(0, 120)}`));
    this.worker.on("exit", code => this.died(`exit ${code}`));
  }

  post(message: ToMedia, transfer: ArrayBuffer[] = []) {
    if (!this.dead) this.worker.postMessage(message, transfer);
  }

  private message(message: FromMedia, maxMb: number) {
    if (message.t === "tick") {
      this.lastTick = Date.now();
      this.mb = message.heapMb + message.externalMb;
      this.memory = message.memory;
      if (this.mb > maxMb) this.kill(`memory ${this.mb} MB`);
      return;
    }
    if (message.t === "refused") { this.kill(`refused: ${message.error}`); return; }
    if (message.t === "models_lost") {
      // The models restarted: a fresh port, once they are ready again.
      void this.turnModels?.ready.then(() => {
        if (this.dead) return;
        const port = this.turnModels!.port();
        this.worker.postMessage({ t: "models", port }, [port as never]);
        this.onModels();
      }, () => {});
      return;
    }
    this.sessions.get(message.session)?.message(message);
  }

  /** End it now (it stopped ticking, holds too much, or refused): its sessions are told as it exits. */
  kill(reason: string) {
    if (this.dead) return;
    this.died(reason);
    void this.worker.terminate();
  }

  /** It ended: once, whatever said so first. A shard that ended empty (closed) tells no one. */
  private died(reason: string) {
    if (this.dead) return;
    this.dead = reason;
    this.onDead(this, reason);
  }
}

export class MediaHost {
  private readonly options: ShardOptions & { speaks: boolean };
  private readonly shards = new Set<Shard>();
  private readonly spares: Shard[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  /** Workers that died with sessions (crashes), since the host started: for tests and the node's stats. */
  crashes = 0;
  /** Fresh ports to the turn models handed to workers whose port closed (the models restarted). */
  modelPorts = 0;

  constructor(options: MediaHostOptions) {
    this.options = { ...MEDIA_HOST_DEFAULTS, ...options };
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const shard of this.shards) if (now - shard.lastTick > this.options.stallMs) shard.kill(`no heartbeat for ${now - shard.lastTick} ms`);
    }, Math.min(this.options.tickMs, 1_000));
    this.timer.unref();
  }

  /** A transport for the sessions' checks (whether it speaks); its connections are made in the workers, never here. */
  transport(): VoiceTransport {
    return { speaks: this.options.speaks, connect: () => { throw new Error("Voice connections are made in media workers"); } };
  }

  factory(): MediaFactory {
    return (session, credentials, options, events) => {
      const shard = this.shard();
      const media = new WorkerMedia(shard, session, this.options.speaks, events, this.options.closeMs, () => this.released(shard));
      shard.sessions.set(session, media);
      shard.given++;
      shard.post({ t: "open", session, credentials, options });
      return media;
    };
  }

  /** Workers running now, the sessions in them, and their memory at their last ticks. */
  stats() {
    const shards = [...this.shards];
    return { workers: shards.length, sessions: shards.reduce((sum, shard) => sum + shard.sessions.size, 0), memoryMb: shards.reduce((sum, shard) => sum + shard.mb, 0), crashes: this.crashes, modelPorts: this.modelPorts };
  }

  /** End every worker (the node is stopping: its sessions were released first). */
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all([...this.shards].map(shard => { shard.dead ??= "closed"; return shard.worker.terminate(); }));
    this.shards.clear();
    this.spares.length = 0;
  }

  /** A worker with room: a spare, one not yet full, or a new one; and a spare started for the next. */
  private shard(): Shard {
    if (this.closed) throw new Error("The media host is closed");
    let shard: Shard | undefined;
    const working = [...this.shards].filter(candidate => !candidate.dead && !this.spares.includes(candidate));
    for (const candidate of working) if (candidate.given < this.options.sessionsPerWorker) { shard = candidate; break; }
    // As many workers as allowed: the next session shares the one holding fewest.
    if (!shard && working.length >= this.options.maxWorkers) shard = working.reduce((fewest, candidate) => candidate.sessions.size < fewest.sessions.size ? candidate : fewest);
    shard ??= this.spares.shift() ?? this.start();
    queueMicrotask(() => this.refill());
    return shard;
  }

  private refill() {
    while (!this.closed && this.spares.length < this.options.spare) this.spares.push(this.start());
  }

  private start(): Shard {
    const shard = new Shard(this.options, (dead, reason) => this.dead(dead, reason), () => { this.modelPorts++; });
    this.shards.add(shard);
    return shard;
  }

  /** A session left its worker: an empty worker that will take no more ends. */
  private released(shard: Shard) {
    if (shard.sessions.size || shard.given < this.options.sessionsPerWorker || shard.dead) return;
    shard.dead = "closed";
    this.shards.delete(shard);
    void shard.worker.terminate();
  }

  private dead(shard: Shard, reason: string) {
    this.shards.delete(shard);
    const spare = this.spares.indexOf(shard);
    if (spare >= 0) this.spares.splice(spare, 1);
    if (reason === "closed" || this.closed) return;
    const sessions = [...shard.sessions.values()];
    if (sessions.length) this.crashes++;
    // Ended for its memory: what it held then (counts and sizes, never audio), to tell which part grew.
    const memory = reason.startsWith("memory") || /ERR_WORKER_OUT_OF_MEMORY/.test(reason) ? shard.memory : undefined;
    console.error(JSON.stringify({ type: "voice_worker_crashed", reason: reason.slice(0, 300), sessions: sessions.map(media => media.session), ...(memory ? { memory } : {}) }));
    writeMetricLine(metricLine("voice_worker_crashed", { dimensions: {}, rollups: [[]], metrics: { VoiceWorkerCrashes: 1, VoiceWorkerCrashSessions: sessions.length } }));
    shard.sessions.clear();
    // The session (and its tenant's webhook) hears only what kind of failure it was; this log has the rest.
    const kind = /ERR_WORKER_OUT_OF_MEMORY/.test(reason) ? "out_of_memory" : reason.startsWith("no heartbeat") ? "unresponsive" : reason.startsWith("memory") ? "memory_limit" : "crashed";
    for (const media of sessions) media.crashed(kind);
  }
}

/** A session's media in a worker, as the session sees it. */
class WorkerMedia implements Media {
  readonly session: string;
  readonly speaks: boolean;
  private readonly shard: Shard;
  private readonly events: MediaEvents;
  private readonly closeMs: number;
  private readonly released: () => void;
  private users?: string[];
  private nextId = 0;
  private readonly playing = new Map<number, { started: () => void; settle: (result: "done" | "stopped" | "error", stats?: Record<string, unknown>) => void }>();
  private closing?: () => void;
  private gone = false;

  constructor(shard: Shard, session: string, speaks: boolean, events: MediaEvents, closeMs: number, released: () => void) {
    this.shard = shard;
    this.session = session;
    this.speaks = speaks;
    this.events = events;
    this.closeMs = closeMs;
    this.released = released;
  }

  update(credentials: VoiceCredentials) { this.shard.post({ t: "update", session: this.session, credentials }); }
  configure(options: Partial<MediaOptions>) { this.shard.post({ t: "configure", session: this.session, options }); }
  others() { return this.users; }
  resume() { if (!this.gone) this.shard.post({ t: "resume", session: this.session }); }

  play(pcm: AsyncIterable<Uint8Array>, started: () => void, expectedMs?: number, options?: PlayOptions): Playback {
    const id = ++this.nextId;
    let stopped = false, stats: Record<string, unknown> | undefined;
    const done = new Promise<"done" | "stopped" | "error">(resolve => {
      this.playing.set(id, { started, settle: (result, given) => { stats = given; this.playing.delete(id); resolve(result); } });
    });
    if (this.gone) this.playing.get(id)!.settle("error");
    else this.shard.post({ t: "play", session: this.session, id, ...(expectedMs !== undefined ? { expectedMs } : {}), ...(options?.music ? { music: true } : {}) });
    // The speech goes to the worker as it is made; a playback stopped (or a worker gone) stops reading it.
    void (async () => {
      try {
        for await (const chunk of pcm) {
          if (stopped || this.gone || !this.playing.has(id)) return;
          const buffer = own(chunk);
          this.shard.post({ t: "pcm", session: this.session, id, pcm: buffer }, [buffer]);
        }
        this.shard.post({ t: "pcm_end", session: this.session, id });
      } catch (error) {
        this.shard.post({ t: "pcm_end", session: this.session, id, error: safeError(error) });
      }
    })();
    return {
      done,
      stop: () => {
        if (stopped) return;
        stopped = true;
        this.shard.post({ t: "stop", session: this.session, id });
      },
      stats: () => stats as never,
    };
  }

  async close(flush: "handoff" | "end" | "error") {
    if (this.gone) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>(resolve => { this.closing = resolve; timer = setTimeout(resolve, this.closeMs); });
    this.shard.post({ t: "close", session: this.session, flush });
    await closed;
    clearTimeout(timer);
    this.leave();
  }

  /** A message from its worker. */
  message(message: FromMedia) {
    if (this.gone) return;
    const events = this.events;
    switch (message.t) {
      case "ready": events.ready(); return;
      case "lost": events.lost(message.reason, message.detail); return;
      case "diagnostic": events.diagnostic(message.event, message.fields); return;
      case "speech_start": events.speechStart(message.speaker); return;
      case "barge_in": events.bargeIn?.(message.speaker, message.speechMs); return;
      case "speech_progress": events.speechProgress?.(message.speaker, message.speechMs); return;
      case "pcm": events.pcm(message.speaker, new Uint8Array(message.pcm)); return;
      case "drop": events.drop(message.speaker); return;
      case "cut": events.cut(fromWireCut(message.cut)); return;
      case "others": this.users = message.users ?? undefined; return;
      case "started": this.playing.get(message.id)?.started(); return;
      case "played": this.playing.get(message.id)?.settle(message.result, message.stats); return;
      case "closed": this.closing?.(); return;
      case "turn": events.turn?.(message.event); return;
      case "recorded": {
        const bytes = new Uint8Array(message.packets);
        let at = 0;
        events.recorded?.(message.lengths.map((length, index) => {
          const packet = bytes.subarray(at, at + length);
          at += length;
          return { speaker: message.speakers[index], at: message.at[index], packet };
        }));
        return;
      }
    }
  }

  /** Its worker died: what plays ends `error`, a close waiting resolves, and the session hears (`crashed`). */
  crashed(reason: string) {
    if (this.gone) return;
    const closing = this.closing;
    this.leave();
    if (closing) { closing(); return; }
    this.events.crashed?.(reason);
  }

  private leave() {
    if (this.gone) return;
    this.gone = true;
    for (const playing of [...this.playing.values()]) playing.settle("error");
    this.shard.sessions.delete(this.session);
    this.released();
  }
}
