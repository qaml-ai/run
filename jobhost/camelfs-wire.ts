import { Readable } from "node:stream";

export const WIRE = Object.freeze({ jsonMax: 64 * 1024, rawMax: 1024 * 1024, frameMax: 1024 * 1024 + 64 * 1024 });
export const MODES = ["100644", "100755", "120000"] as const;
export function encodeFrame(payload: Uint8Array | string | object): Buffer {
  const bytes = payload instanceof Uint8Array ? Buffer.from(payload) : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  if (bytes.length > WIRE.frameMax) throw new Error("frame exceeds frameMax");
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

/** Pull only the current frame; reject its length before allocating its body. */
export class FrameReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;
  constructor(stream: NodeJS.ReadableStream) {
    // destroyOnReturn=false leaves the write side available for the failure reply.
    this.iterator = (stream as Readable).iterator({ destroyOnReturn: false });
  }
  private async read(size: number, eof = false): Promise<Buffer | null> {
    let result: Buffer | undefined, used = 0;
    while (used < size) {
      if (this.offset === this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) { if (eof && !used) return null; throw new Error("unexpected EOF in apply stream"); }
        this.chunk = next.value; this.offset = 0;
        if (!this.chunk.length) continue;
      }
      result ??= Buffer.alloc(size);
      const n = Math.min(size - used, this.chunk.length - this.offset);
      this.chunk.copy(result, used, this.offset, this.offset + n); used += n; this.offset += n;
    }
    return result ?? Buffer.alloc(0);
  }
  async next(): Promise<Buffer | null> {
    const prefix = await this.read(4, true);
    if (!prefix) return null;
    const length = prefix.readUInt32BE();
    if (length > WIRE.frameMax) throw new Error("frame exceeds frameMax");
    return this.read(length);
  }
}
export function jsonFrame(payload: Buffer): Record<string, unknown> {
  if (payload.length > WIRE.jsonMax) throw new Error("JSON frame exceeds jsonMax");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("JSON frame must be a plain object");
  return value as Record<string, unknown>;
}
export function checkPath(path: string): string {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0")) throw new Error("invalid path: must be relative, nonempty and without NUL");
  if (Buffer.byteLength(path) > 4096) throw new Error("path exceeds 4096 bytes");
  // Reject lone surrogates rather than silently replacing them during UTF-8 encoding.
  if (Buffer.from(path).toString() !== path) throw new Error("path is not UTF-8");
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new Error("invalid path component");
  if (parts.some(part => Buffer.byteLength(part) > 255)) throw new Error("path component exceeds 255 bytes");
  if (parts[0] === ".git") throw new Error("path is under .git");
  return path;
}
