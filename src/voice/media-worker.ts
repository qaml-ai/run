import { parentPort, workerData } from "node:worker_threads";
import type { VoiceTransport } from "../voice-sessions.ts";
import type { Playback } from "../voice-speech.ts";
import { safeError } from "../metrics.ts";
import { opusStats } from "../opus.ts";
import { MediaSession } from "./media.ts";
import { MEDIA_PROTOCOL, own, wireCut, type FromMedia, type MediaWorkerInit, type ToMedia } from "./protocol.ts";
import { clientFrom, TurnModelsUnavailable, type TurnModels } from "./turns/inference.ts";

/**
 * A media worker (src/voice/media-host.ts starts it): the media of one session, or a few, off the node's control
 * thread. Whatever goes wrong in here (a WebAssembly trap, an exception from a timer, a heap that runs out, a loop that
 * never yields) ends this worker at worst; the host tells its sessions, which restart in a fresh one. A session's own
 * failure on a message is caught and reported as that session's, so a worker holding several does not end for one.
 */

const port = parentPort!;
const init = workerData as MediaWorkerInit;
const post = (message: FromMedia, transfer: ArrayBuffer[] = []) => port.postMessage(message, transfer);

/** PCM pushed in by messages, read as an async iterable by playback. */
class Pushed implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private done = false;
  private error?: Error;
  private wake?: () => void;
  push(chunk: Uint8Array) { if (!this.done) { this.chunks.push(chunk); this.wake?.(); } }
  end(error?: string) { if (this.done) return; this.done = true; if (error) this.error = new Error(error); this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.chunks.length) { yield this.chunks.shift()!; continue; }
      if (this.done) { if (this.error) throw this.error; return; }
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

/**
 * The node's turn models, over this worker's port to them: shared by its sessions. When the port closes (the models
 * restarted), calls fail at once (each session's turn-taking falls back as it does when the models are busy) and the
 * worker asks the host for a fresh port.
 */
let modelsClient = init.models ? clientFrom(init.models) : undefined;
let asked = false;
const models: TurnModels | undefined = init.models ? {
  vad: (input, state) => current().vad(input, state),
  endOfTurn: audio => current().endOfTurn(audio),
  close() { modelsClient?.close(); },
} : undefined;
function current() {
  if (modelsClient && !modelsClient.closed) return modelsClient;
  if (!asked) { asked = true; post({ t: "models_lost" }); }
  return { vad: () => Promise.reject(new TurnModelsUnavailable("The turn models are restarting")), endOfTurn: () => Promise.reject(new TurnModelsUnavailable("The turn models are restarting")) } as unknown as TurnModels;
}

type Held = { media: MediaSession; playing: Map<number, { pcm: Pushed; playback: Playback }>; others?: string };
const sessions = new Map<string, Held>();

async function start() {
  if (init.protocol !== MEDIA_PROTOCOL) { post({ t: "refused", error: `media protocol ${init.protocol}, this worker speaks ${MEDIA_PROTOCOL}` }); return; }
  let transport: VoiceTransport;
  try {
    const module = await import(init.transport.module);
    transport = module[init.transport.export](init.transport.options);
  } catch (error) { post({ t: "refused", error: `transport did not load: ${safeError(error)}` }); return; }
  port.on("message", (message: ToMedia) => {
    try { handle(transport, message); }
    catch (error) { post({ t: "diagnostic", session: message.session ?? "", event: "audio_failed", fields: { error: safeError(error), message: message.t } }); }
  });
  const mb = (bytes: number) => Math.round(bytes / 1_048_576);
  const tick = () => {
    const memory = process.memoryUsage();
    const opus = opusStats();
    // Who is in each call, when it changed: the session's empty-call check reads it.
    for (const [session, held] of sessions) {
      const others = held.media.others();
      const key = others ? [...others].sort().join(",") : "?";
      if (key !== held.others) { held.others = key; post({ t: "others", session, users: others ? [...others] : null }); }
    }
    // `external` already counts ArrayBuffers (Buffers among them) and WebAssembly memory: each once.
    post({
      t: "tick", heapMb: mb(memory.heapUsed), externalMb: mb(memory.external), sessions: sessions.size,
      memory: {
        heapMb: mb(memory.heapUsed), heapTotalMb: mb(memory.heapTotal), externalMb: mb(memory.external), arrayBuffersMb: mb(memory.arrayBuffers),
        opusMb: mb(opus.heapBytes), opusCodecs: opus.live, sessions: [...sessions.values()].map(held => {
          // A report must never end the tick: a throw here would end the worker and every call on it.
          try { return held.media.sizes(); } catch { return {}; }
        }),
      },
    });
  };
  setInterval(tick, init.tickMs);
  tick();
}

function handle(transport: VoiceTransport, message: ToMedia) {
  if (message.t === "models") { modelsClient = clientFrom(message.port); asked = false; return; }
  const { session } = message;
  if (message.t === "open") {
    if (sessions.has(session)) return;
    const media = new MediaSession(transport, message.credentials, message.options, {
      ready: () => post({ t: "ready", session }),
      lost: (reason, detail) => post({ t: "lost", session, reason, ...(detail ? { detail } : {}) }),
      diagnostic: (event, fields) => post({ t: "diagnostic", session, event, fields }),
      speechStart: speaker => post({ t: "speech_start", session, speaker }),
      bargeIn: (speaker, speechMs) => post({ t: "barge_in", session, speaker, speechMs }),
      speechProgress: (speaker, speechMs) => post({ t: "speech_progress", session, speaker, speechMs }),
      pcm: (speaker, pcm) => { const buffer = own(pcm); post({ t: "pcm", session, speaker, pcm: buffer }, [buffer]); },
      drop: speaker => post({ t: "drop", session, speaker }),
      cut: cut => { const wire = wireCut(cut); post({ t: "cut", session, cut: wire.cut }, wire.transfer); },
      turn: event => post({ t: "turn", session, event }),
    }, models);
    sessions.set(session, { media, playing: new Map() });
    return;
  }
  const held = sessions.get(session);
  if (!held) return;
  switch (message.t) {
    case "update": held.media.update(message.credentials); return;
    case "configure": held.media.configure(message.options); return;
    case "play": {
      const pcm = new Pushed();
      const playback = held.media.play(pcm, () => post({ t: "started", session, id: message.id }), message.expectedMs);
      held.playing.set(message.id, { pcm, playback });
      void playback.done.then(result => {
        held.playing.delete(message.id);
        pcm.end();
        post({ t: "played", session, id: message.id, result, ...(playback.stats ? { stats: playback.stats() } : {}) });
      });
      return;
    }
    case "resume": held.media.resume(); return;
    case "pcm": held.playing.get(message.id)?.pcm.push(new Uint8Array(message.pcm)); return;
    case "pcm_end": held.playing.get(message.id)?.pcm.end(message.error); return;
    case "stop": {
      const playing = held.playing.get(message.id);
      playing?.playback.stop();
      playing?.pcm.end();
      return;
    }
    case "close":
      sessions.delete(session);
      void held.media.close(message.flush).catch(error => post({ t: "diagnostic", session, event: "audio_failed", fields: { error: safeError(error) } }))
        .finally(() => post({ t: "closed", session }));
      return;
  }
}

void start();
