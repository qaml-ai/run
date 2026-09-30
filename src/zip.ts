import { Readable } from "node:stream";
import { createDeflateRaw, crc32 } from "node:zlib";

/**
 * A zip archive written as a stream, one entry at a time: each entry's bytes are deflated as they
 * arrive, and its CRC and sizes follow it in a data descriptor, so nothing is held but the central
 * directory (a few dozen bytes an entry). ZIP64 records are added only where the archive needs them:
 * past 4 GiB or 65,535 entries. A single entry must stay under 4 GiB (volume files are at most 256 MiB).
 */
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** General purpose flags: sizes in a data descriptor (bit 3), names in UTF-8 (bit 11). */
const FLAGS = 0x0808;

type Entry = { name: Buffer; crc: number; compressed: number; size: number; offset: number; time: number; date: number };

function dosTime(at: Date) {
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((Math.max(1980, at.getUTCFullYear()) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

export class ZipWriter {
  private readonly entries: Entry[] = [];
  private offset = 0;

  private out(buffer: Buffer) { this.offset += buffer.length; return buffer; }

  /** One file: its local header, its deflated bytes, then its data descriptor. */
  async *file(path: string, source: string | Uint8Array | AsyncIterable<Uint8Array>, modified = new Date()): AsyncGenerator<Buffer> {
    const name = Buffer.from(path.replace(/^\/+/, ""), "utf8");
    if (!name.length || name.length > MAX16) throw new Error("A zip entry needs a name of 1 to 65535 bytes");
    const { time, date } = dosTime(modified);
    const entry: Entry = { name, crc: 0, compressed: 0, size: 0, offset: this.offset, time, date };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt16LE(name.length, 26);
    yield this.out(header);
    yield this.out(name);
    const input = typeof source === "string" ? [Buffer.from(source, "utf8")] : source instanceof Uint8Array ? [source] : source;
    const counted = async function* () {
      for await (const chunk of input) {
        entry.crc = crc32(chunk, entry.crc);
        entry.size += chunk.byteLength;
        yield chunk;
      }
    };
    const readable = Readable.from(counted(), { objectMode: false });
    const deflate = createDeflateRaw();
    readable.on("error", error => deflate.destroy(error));
    readable.pipe(deflate);
    try {
      for await (const chunk of deflate as AsyncIterable<Buffer>) {
        entry.compressed += chunk.length;
        yield this.out(chunk);
      }
    } finally { readable.destroy(); }
    if (entry.size >= MAX32 || entry.compressed >= MAX32) throw new Error(`${path} is too large for a zip entry`);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(entry.crc, 4);
    descriptor.writeUInt32LE(entry.compressed, 8);
    descriptor.writeUInt32LE(entry.size, 12);
    yield this.out(descriptor);
    this.entries.push(entry);
  }

  /** The central directory and its end records. */
  *end(): Generator<Buffer> {
    const start = this.offset;
    for (const entry of this.entries) {
      const far = entry.offset >= MAX32;
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(far ? 45 : 20, 4);
      header.writeUInt16LE(far ? 45 : 20, 6);
      header.writeUInt16LE(FLAGS, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(far ? 12 : 0, 30);
      header.writeUInt32LE(far ? MAX32 : entry.offset, 42);
      yield this.out(header);
      yield this.out(entry.name);
      if (far) {
        // The ZIP64 extra field holds only what its header left at 0xFFFFFFFF: here the offset.
        const extra = Buffer.alloc(12);
        extra.writeUInt16LE(1, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(entry.offset), 4);
        yield this.out(extra);
      }
    }
    const size = this.offset - start;
    const count = this.entries.length;
    if (count >= MAX16 || size >= MAX32 || start >= MAX32) {
      const at = this.offset;
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(size), 40);
      record.writeBigUInt64LE(BigInt(start), 48);
      yield this.out(record);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(at), 8);
      locator.writeUInt32LE(1, 16);
      yield this.out(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(count, MAX16), 8);
    end.writeUInt16LE(Math.min(count, MAX16), 10);
    end.writeUInt32LE(Math.min(size, MAX32), 12);
    end.writeUInt32LE(Math.min(start, MAX32), 16);
    yield this.out(end);
  }
}
