// Copied from backends/workers/src/jobs/camel-sync.ts: the tar writer today's job sync streams (ustar + pax long names).
const encoder = new TextEncoder();
const BLOCK = 512;

function octal(value: number, width: number) {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}
function header(name: string, size: number, type: "0" | "x") {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, offset: number, width: number) => block.set(encoder.encode(text).subarray(0, width), offset);
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(octal(sum, 7) + " ", 148, 8);
  return block;
}
/** A pax record `<len> path=<value>\n`, whose length counts its own digits. */
function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`, bodyBytes = encoder.encode(body).length;
  let length = bodyBytes + 1;
  while (String(length).length + bodyBytes !== length) length = String(length).length + bodyBytes;
  return encoder.encode(`${length}${body}`);
}
const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);

/**
 * One regular file as tar blocks (ustar, mode 0644). A path past ustar's 100 bytes, or not ASCII, goes in a pax header
 * first, which GNU tar reads; sizes past ustar's 8 GiB never happen (files are capped well under it).
 */
export function tarEntry(path: string, bytes: Uint8Array): Uint8Array[] {
  const name = encoder.encode(path);
  const blocks: Uint8Array[] = [];
  if (name.length >= 100 || /[^\x20-\x7e]/.test(path)) {
    const record = paxRecord("path", path);
    blocks.push(header("././@PaxHeader", record.length, "x"), record, padding(record.length));
  }
  blocks.push(header(name.length >= 100 ? "pax-long-name" : path, bytes.byteLength, "0"), bytes, padding(bytes.byteLength));
  return blocks;
}
/** The end of an archive: two zero blocks. */
export const tarEnd = () => new Uint8Array(BLOCK * 2);
