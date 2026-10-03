import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

/** Every entry of a zip, read through its central directory, as the export's reader would. */
export function unzip(zip: Buffer) {
  let end = zip.length - 22;
  while (zip.readUInt32LE(end) !== 0x06054b50) end--;
  let count = zip.readUInt16LE(end + 10), at = zip.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) {
    const record = Number(zip.readBigUInt64LE(end - 20 + 8));
    count = Number(zip.readBigUInt64LE(record + 32)); at = Number(zip.readBigUInt64LE(record + 48));
  }
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const compressed = zip.readUInt32LE(at + 20), nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(zip.subarray(data, data + compressed)));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}
