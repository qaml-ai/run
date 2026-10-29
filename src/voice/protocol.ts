import type { VoiceCredentials } from "../voice-sessions.ts";
import type { Cut } from "../voice-audio.ts";
import type { MessagePort } from "node:worker_threads";
import type { MediaOptions } from "./media.ts";
import type { TurnEvent } from "./turns/turn-taker.ts";

/**
 * Messages between a node's control thread and its media workers (docs/operations/voice-pipeline.md, "Protocol").
 * Each names the session it is about, since a worker may hold several. PCM (24 kHz mono 16-bit) travels as a
 * transferred ArrayBuffer of its own, never a view of a pool: the sender copies it out first.
 */

/** The protocol's version: a worker refuses a host of another (a deploy replaces both together; this is a guard). */
export const MEDIA_PROTOCOL = 1;

/** Which transport a worker builds its connections with: a module's export, called with `options` (structured-cloneable). */
export type TransportSpec = { module: string; export: string; options?: unknown };

/** What a worker is started with (workerData). */
export type MediaWorkerInit = { protocol: number; transport: TransportSpec; tickMs: number; /** A port to the node's turn models (src/voice/turns), transferred. */ models?: MessagePort };

/** A media worker's memory, split, and what its sessions hold (counted), as its tick reports them. */
export type WorkerMemory = { heapMb: number; heapTotalMb: number; externalMb: number; arrayBuffersMb: number; opusMb: number; opusCodecs: number; sessions: Record<string, number>[] };

/** A cut, as it crosses: its packets in one buffer, by length. */
export type WireCut = Omit<Cut, "packets"> & { packets: ArrayBuffer; lengths: number[] };

/** Control → media. */
export type ToMedia =
  | { t: "open"; session: string; credentials: VoiceCredentials; options: MediaOptions }
  | { t: "update"; session: string; credentials: VoiceCredentials }
  | { t: "configure"; session: string; options: Partial<MediaOptions> }
  /** `music`: audio the bot plays (src/voice/jukebox.ts), which barge-in leaves be. */
  | { t: "play"; session: string; id: number; expectedMs?: number; music?: boolean }
  | { t: "pcm"; session: string; id: number; pcm: ArrayBuffer }
  | { t: "pcm_end"; session: string; id: number; error?: string }
  | { t: "stop"; session: string; id: number }
  /** End a barge-in pause (Media.resume). */
  | { t: "resume"; session: string }
  | { t: "close"; session: string; flush: "handoff" | "end" | "error" }
  /** A fresh port to the node's turn models, for the worker (its last one closed: the models restarted). */
  | { t: "models"; session?: undefined; port: MessagePort };

/** Media → control. */
export type FromMedia =
  | { t: "ready"; session: string }
  | { t: "lost"; session: string; reason: "kicked" | "credentials" | "error"; detail?: string }
  | { t: "diagnostic"; session: string; event: string; fields: Record<string, unknown> }
  | { t: "speech_start"; session: string; speaker: string }
  | { t: "barge_in"; session: string; speaker: string; speechMs: number }
  | { t: "speech_progress"; session: string; speaker: string; speechMs: number }
  | { t: "pcm"; session: string; speaker: string; pcm: ArrayBuffer }
  | { t: "drop"; session: string; speaker: string }
  | { t: "cut"; session: string; cut: WireCut }
  /** Packets for the session's recording: their bytes in one buffer, by length, with each one's speaker and time. */
  | { t: "recorded"; session: string; packets: ArrayBuffer; lengths: number[]; speakers: string[]; at: number[] }
  | { t: "others"; session: string; users: string[] | null }
  | { t: "started"; session: string; id: number }
  | { t: "played"; session: string; id: number; result: "done" | "stopped" | "error"; stats?: Record<string, unknown> }
  | { t: "closed"; session: string }
  /** Turn-taking's event for a session with smart end of turn. */
  | { t: "turn"; session: string; event: TurnEvent }
  /** The worker's port to the turn models closed: it asks for another (`models`). */
  | { t: "models_lost" }
  /**
   * The worker's heartbeat: its isolate's heap, its other memory (`external`: ArrayBuffers and WebAssembly memory with
   * the rest, each counted once), the sessions it holds; and `memory`, that memory split (ArrayBuffers, Opus's
   * WebAssembly heap, its live codecs) with what each session holds, counted (MediaSession.sizes), for the log of a
   * worker ended for its memory.
   */
  | { t: "tick"; heapMb: number; externalMb: number; sessions: number; memory?: WorkerMemory }
  /** The worker cannot serve (a protocol mismatch, a transport that does not load). */
  | { t: "refused"; error: string };

/** `bytes` copied into an ArrayBuffer of its own, to transfer. */
export function own(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function wireCut(cut: Cut): { cut: WireCut; transfer: ArrayBuffer[] } {
  const lengths = cut.packets.map(packet => packet.byteLength);
  const packets = new Uint8Array(lengths.reduce((sum, length) => sum + length, 0));
  let at = 0;
  for (const packet of cut.packets) { packets.set(packet, at); at += packet.byteLength; }
  return { cut: { ...cut, packets: packets.buffer, lengths }, transfer: [packets.buffer] };
}

export function fromWireCut(wire: WireCut): Cut {
  const bytes = new Uint8Array(wire.packets);
  const packets: Uint8Array[] = [];
  let at = 0;
  for (const length of wire.lengths) { packets.push(bytes.subarray(at, at + length)); at += length; }
  const { lengths: _lengths, ...cut } = wire;
  return { ...cut, packets };
}
