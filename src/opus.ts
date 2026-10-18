import { createRequire } from "node:module";

/**
 * Opus in WebAssembly: opusscript's libopus build, without its JavaScript wrapper, which is not memory safe. The wrapper
 * (opusscript 0.1.1) views each PCM buffer at twice its allocation's address (`HEAPU16.subarray(pointer)` with a byte
 * pointer) and twice its size, so its writes land outside what it allocated, over the heap's other allocations (other
 * codecs' state); and its views are taken once, so they detach when the module's memory grows. With enough codecs (a
 * busy call's speakers, speech being played), every call traps ("memory access out of bounds"), including the free in
 * `delete`, which, thrown from a timer, ended the process.
 *
 * Here each buffer is allocated at its full size and viewed afresh on every call. The native handler takes PCM as one
 * byte per 16-bit element (the layout the wrapper's views made), so the bytes are spread and gathered that way.
 *
 * A codec never throws out of `delete`, and after a trap it is broken (its calls throw `OpusError`) and the module it is
 * in is not used for new codecs: a trap can leave the module's own state (its stack, its allocator) inconsistent.
 */
type Handler = { _encode(pcm: number, bytes: number, packet: number, frameSize: number): number; _decode(packet: number, bytes: number, pcm: number): number };
type Native = {
  HEAPU8: Uint8Array; HEAPU16: Uint16Array;
  _malloc(bytes: number): number; _free(pointer: number): void;
  OpusScriptHandler: { new(rate: number, channels: number, application: number): Handler; destroy_handler(handler: Handler): void };
};

const load = createRequire(import.meta.url)("opusscript/build/opusscript_native_wasm.js") as () => Native;
let current: Native | undefined;
const native = () => current ??= load();

/** 120 ms at 48 kHz, the longest frame Opus has, per channel; and the largest packet (three 1275-byte frames). */
const MAX_FRAME_SAMPLES = 5_760;
const MAX_PACKET_BYTES = 1276 * 3;
const APPLICATIONS = { voip: 2048, audio: 2049 } as const;

export class OpusError extends Error {}

let live = 0;
/** Codecs not yet deleted, and the current module's memory (it grows, and never shrinks): for tests and metrics. */
export function opusStats() { return { live, heapBytes: current?.HEAPU8.length ?? 0 }; }

export class Opus {
  readonly channels: number;
  readonly rate: number;
  private readonly module: Native;
  private handler?: Handler;
  /** One byte per 16-bit element: twice the PCM's bytes, so at least 2-aligned (malloc aligns to 8). */
  private pcm = 0;
  private packet = 0;
  private fault?: unknown;

  constructor(rate: 8_000 | 12_000 | 16_000 | 24_000 | 48_000, channels: 1 | 2, application: keyof typeof APPLICATIONS) {
    this.channels = channels;
    this.rate = rate;
    this.module = native();
    try {
      this.handler = new this.module.OpusScriptHandler(rate, channels, APPLICATIONS[application]);
      this.pcm = this.module._malloc(MAX_FRAME_SAMPLES * channels * 2 * 2);
      this.packet = this.module._malloc(MAX_PACKET_BYTES);
      if (!this.pcm || !this.packet) throw new OpusError("Opus: out of memory");
      live++;
    } catch (error) { this.failed(error); this.handler = undefined; }
  }

  /** Broken by a trap, or deleted: every call throws. */
  get broken() { return this.fault !== undefined || !this.handler; }

  /** 16-bit PCM (interleaved, `frameSize` samples per channel) to one packet. */
  encode(pcm: Uint8Array, frameSize: number): Buffer {
    const handler = this.ready();
    if (pcm.length > MAX_FRAME_SAMPLES * this.channels * 2) throw new OpusError("Opus: frame too long");
    try {
      this.module.HEAPU16.set(pcm, this.pcm >> 1);
      const length = handler._encode(this.pcm, pcm.length, this.packet, frameSize);
      if (length < 0) throw new OpusError(`Opus encode error ${length}`);
      return Buffer.from(this.module.HEAPU8.subarray(this.packet, this.packet + length));
    } catch (error) { throw this.failed(error); }
  }

  /** One packet to 16-bit PCM (interleaved). */
  decode(packet: Uint8Array): Buffer {
    const handler = this.ready();
    if (packet.length > MAX_PACKET_BYTES) throw new OpusError("Opus: packet too long");
    try {
      this.module.HEAPU8.set(packet, this.packet);
      const samples = handler._decode(this.packet, packet.length, this.pcm);
      if (samples < 0) throw new OpusError(`Opus decode error ${samples}`);
      const start = this.pcm >> 1;
      // Buffer.from of a Uint16Array takes each element's low byte: the PCM's bytes, as the handler spread them.
      return Buffer.from(this.module.HEAPU16.subarray(start, start + samples * this.channels * 2));
    } catch (error) { throw this.failed(error); }
  }

  /**
   * `ms` of audio where packets were lost, concealed by libopus (PLC: a decode without a packet), as 16-bit PCM. The
   * handler always conceals its longest frame (5,760 samples a channel), so only the first `ms` of it is kept: the
   * decoder's state runs on past the gap, which the next packet's decode picks up from (a concealment fades to silence).
   */
  conceal(ms: number): Buffer {
    const handler = this.ready();
    const samples = Math.min(MAX_FRAME_SAMPLES, Math.round(this.rate * ms / 1000));
    try {
      const made = handler._decode(0, 0, this.pcm);
      if (made < 0) throw new OpusError(`Opus concealment error ${made}`);
      const start = this.pcm >> 1;
      return Buffer.from(this.module.HEAPU16.subarray(start, start + Math.min(made, samples) * this.channels * 2));
    } catch (error) { throw this.failed(error); }
  }

  /** Free it. Idempotent, and never throws: a codec in a module that trapped is left as it is. */
  delete() {
    const handler = this.handler;
    this.handler = undefined;
    if (!handler) return;
    live--;
    if (this.fault !== undefined) return;
    try {
      this.module.OpusScriptHandler.destroy_handler(handler);
      this.module._free(this.pcm);
      this.module._free(this.packet);
    } catch (error) { this.failed(error); }
  }

  private ready(): Handler {
    if (this.fault !== undefined) throw new OpusError(`Opus codec is broken: ${(this.fault as Error)?.message ?? this.fault}`);
    if (!this.handler) throw new OpusError("Opus codec was deleted");
    return this.handler;
  }

  /** A codec error stays this codec's; a trap (WebAssembly.RuntimeError) also retires its module for new codecs. */
  private failed(error: unknown): unknown {
    if (error instanceof OpusError) return error;
    this.fault = error;
    if (error instanceof WebAssembly.RuntimeError && current === this.module) current = undefined;
    return new OpusError(`Opus codec failed: ${(error as Error)?.message ?? error}`);
  }
}
