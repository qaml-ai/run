// The wire between a job host (jobhost/agent.ts) and the runtime (backends/workers/src/jobs/hosts.ts), and between the
// host and the guest agent in a VM (jobhost/guest.ts). docs/design/job-hosts-plan.md.
//
// Host <-> runtime: one WebSocket per host, the host dialing out. Every message is a JSON document; one bigger than a
// frame (a job's files, a result's outputs) is sent as frames of at most FRAME_CHARS characters, `{ t: "part", n, i, of,
// data }`, and assembled by `Frames`. A Workers WebSocket message is at most 1 MiB, so frames stay well under it.

export const FRAME_CHARS = 256 * 1024;
/** Most a whole message may be (base64 included), so a host or the runtime never assembles without bound. */
export const MESSAGE_MAX_CHARS = 96 * 1024 * 1024;

/** A file as it crosses the wire: its bytes in base64. */
export type WireFile = { path: string; data: string };

/** Runtime → host. */
export type RuntimeMessage =
  | { type: "registered"; host: string }
  | { type: "job"; id: string; spec: WireJob }
  | { type: "cancel"; id: string };
/** Host → runtime. */
export type HostMessage =
  | { type: "hello"; host: string; slots: number; free: number; vcpus: number; memoryMiB: number; version: string; features?: string[]; pool?: "build" | "test" }
  | { type: "heartbeat"; running: string[]; free: number }
  | { type: "started"; id: string; at: number }
  | { type: "result"; id: string; result: WireResult };

/** What a host needs to run a job: its command and limits, and its files inline. */
export type WireJob = {
  command: string; timeoutSeconds: number; outputs: string[];
  limits: { cpus?: number; memoryMiB?: number; diskMiB?: number; pids?: number };
  internet: boolean; files: WireFile[]; secretEnv?: Record<string, string>;
  /** The job's /repo as a camelFS tree: the host mounts a fork of it (no `files`, no `sync`). */
  camelfs?: { lineage: string; tree: string; commit?: boolean };
  /**
   * A tree too large to send inline: the host fetches each file from the runtime itself (GET `url`/<index>, with
   * `token` as a bearer, one job's only), checks its size and sha256, and writes it into the VM in pieces.
   */
  sync?: { url: string; token: string; files: { path: string; size: number; sha256: string }[];
    /** The whole sync must end by then (epoch ms): the job's deadline, which its token does not outlive. */
    until?: number };
};
export type WireStream = { data: string; size: number; truncated: boolean };
export type WireResult =
  | { ok: true; exitCode: number | null; timedOut: boolean; stdout: WireStream; stderr: WireStream; outputs: Record<string, WireStream>; missing: string[];
      timings: { startMs: number; syncMs: number; commandMs: number; collectMs: number; totalMs: number }; pids: "enforced" | "unenforced";
      camelfs?: { tree?: string; root?: string; warm: boolean; mountMs: number; applyMs: number; checkpointMs?: number; checkpointError?: string;
        checkpoint?: { walkMs: number; streamMs: number; freezeMs: number; files: number; bytes: number; skipped: number;
          changedChunks: number; uploadedChunks: number; changedBytes: number; reflinkMs: number; fiemapMs: number; hashMs: number; uploadMs: number } } }
  | { ok: false; code: "start_failed" | "sync_failed" | "container_failed" | "disk_low" | "stopped"; message: string;
      /** For a failure after its VM started: when it started (after `startMs`) and ended (`totalMs`), from dispatch. */
      timings?: { startMs: number; totalMs: number } };

let counter = 0;
/** One message as the frames to send. */
export function frames(message: unknown): string[] {
  const text = JSON.stringify(message);
  if (text.length > MESSAGE_MAX_CHARS) throw new Error(`A job host message of ${text.length} characters is over ${MESSAGE_MAX_CHARS}`);
  if (text.length <= FRAME_CHARS) return [text];
  const n = `${Date.now().toString(36)}-${(counter++).toString(36)}`, of = Math.ceil(text.length / FRAME_CHARS);
  return Array.from({ length: of }, (_, i) => JSON.stringify({ t: "part", n, i, of, data: text.slice(i * FRAME_CHARS, (i + 1) * FRAME_CHARS) }));
}

/** Messages being assembled at once, at most: frames of more than this many messages interleaved are refused. */
export const ASSEMBLIES_MAX = 4;

/**
 * Assembles frames into messages: `add` answers a whole message, or undefined while one is incomplete. Bounded: each
 * frame's data is at most FRAME_CHARS, a message at most MESSAGE_MAX_CHARS, and at most ASSEMBLIES_MAX are open at once,
 * so a peer cannot make it hold more than about ASSEMBLIES_MAX × MESSAGE_MAX_CHARS. A whole frame is at most a frame.
 */
export class Frames {
  private parts = new Map<string, { of: number; got: number; chunks: string[]; size: number }>();
  add(frame: string): unknown {
    if (frame.length > FRAME_CHARS + 512) throw new Error("Invalid job host frame");
    const value = JSON.parse(frame) as { t?: string; n?: string; i?: number; of?: number; data?: string };
    if (value?.t !== "part") return value;
    const { n, i, of, data } = value;
    if (typeof n !== "string" || n.length > 64 || !Number.isInteger(i) || !Number.isInteger(of) || typeof data !== "string" || data.length > FRAME_CHARS || of! < 1 || i! < 0 || i! >= of! || of! * FRAME_CHARS > MESSAGE_MAX_CHARS + FRAME_CHARS)
      throw new Error("Invalid job host frame");
    if (!this.parts.has(n) && this.parts.size >= ASSEMBLIES_MAX) throw new Error("Too many job host messages in flight");
    const entry = this.parts.get(n) ?? { of: of!, got: 0, chunks: [], size: 0 };
    if (entry.of !== of || entry.chunks[i!] !== undefined) throw new Error("Invalid job host frame");
    entry.chunks[i!] = data; entry.got++; entry.size += data.length;
    if (entry.size > MESSAGE_MAX_CHARS) { this.parts.delete(n); throw new Error("A job host message is too large"); }
    if (entry.got < entry.of) { this.parts.set(n, entry); return undefined; }
    this.parts.delete(n);
    return JSON.parse(entry.chunks.join(""));
  }
}

const encoder = new TextEncoder(), decoder = new TextDecoder();
export const toBase64 = (bytes: Uint8Array) => { let out = ""; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(out); };
export const fromBase64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
export const textBase64 = (text: string) => toBase64(encoder.encode(text));
export const base64Text = (data: string) => decoder.decode(fromBase64(data));
