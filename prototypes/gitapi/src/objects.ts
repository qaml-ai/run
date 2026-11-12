// Git object format: hashing, tree/commit encode and parse, pack entries, pkt-lines. Platform-neutral: node:crypto
// and node:zlib exist in Node and in workerd (nodejs_compat), and both are synchronous, so hashing and deflating a
// commit never yields to the event loop.
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export type Sha = string;
export type ObjectType = "commit" | "tree" | "blob";
export const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3 };
export const CODE_TYPE: Record<number, ObjectType> = { 1: "commit", 2: "tree", 3: "blob" };
export const ZERO = "0".repeat(40);
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const enc = new TextEncoder();
const dec = new TextDecoder();
export const utf8 = (s: string) => enc.encode(s);
export const text = (b: Uint8Array) => dec.decode(b);

export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}
const hex = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

export function hashObject(type: ObjectType, content: Uint8Array): Sha {
  return createHash("sha1").update(`${type} ${content.byteLength}\0`).update(content).digest("hex");
}

export type Mode = "100644" | "100755" | "120000" | "40000" | "160000";
export type TreeEntry = { mode: Mode; name: string; sha: Sha };
const sortKey = (e: TreeEntry) => (e.mode === "40000" ? `${e.name}/` : e.name);

export function encodeTree(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => { const x = sortKey(a), y = sortKey(b); return x < y ? -1 : x > y ? 1 : 0; });
  return concat(sorted.flatMap((e) => [utf8(`${e.mode} ${e.name}\0`), unhex(e.sha)]));
}
export function parseTree(raw: Uint8Array): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < raw.byteLength) {
    const sp = raw.indexOf(0x20, i), nul = raw.indexOf(0, sp);
    out.push({ mode: text(raw.subarray(i, sp)) as Mode, name: text(raw.subarray(sp + 1, nul)), sha: hex(raw.subarray(nul + 1, nul + 21)) });
    i = nul + 21;
  }
  return out;
}

export type Person = { name: string; email: string };
export type Commit = { tree: Sha; parents: Sha[]; author: string; committer: string; message: string; time: number };
export function encodeCommit(c: { tree: Sha; parents: Sha[]; author: Person; message: string; at?: number }): Uint8Array {
  const who = `${c.author.name} <${c.author.email}> ${Math.floor((c.at ?? Date.now()) / 1000)} +0000`;
  return utf8([`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`), `author ${who}`, `committer ${who}`, "", c.message.endsWith("\n") ? c.message : `${c.message}\n`].join("\n"));
}
export function parseCommit(raw: Uint8Array): Commit {
  const s = text(raw), split = s.indexOf("\n\n");
  const c: Commit = { tree: "", parents: [], author: "", committer: "", message: s.slice(split + 2), time: 0 };
  for (const line of s.slice(0, split).split("\n")) {
    const sp = line.indexOf(" "), key = line.slice(0, sp), value = line.slice(sp + 1);
    if (key === "tree") c.tree = value;
    else if (key === "parent") c.parents.push(value);
    else if (key === "author") c.author = value;
    else if (key === "committer") { c.committer = value; c.time = Number(value.split(" ").at(-2)) * 1000; }
  }
  return c;
}

/** A pack entry: the type/size varint header followed by the zlib stream. Stored verbatim in segments. */
export function packEntry(type: ObjectType, content: Uint8Array): { entry: Uint8Array; hlen: number } {
  let size = content.byteLength;
  const head: number[] = [];
  let byte = (TYPE_CODE[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) { head.push(byte | 0x80); byte = size & 0x7f; size = Math.floor(size / 128); }
  head.push(byte);
  const z = deflateSync(content);
  const entry = new Uint8Array(head.length + z.byteLength);
  entry.set(head); entry.set(z, head.length);
  return { entry, hlen: head.length };
}
export const inflateEntry = (entry: Uint8Array, hlen: number) => new Uint8Array(inflateSync(entry.subarray(hlen)));

export function pkt(line: string | Uint8Array): Uint8Array {
  const p = typeof line === "string" ? utf8(line) : line;
  return concat([utf8((p.byteLength + 4).toString(16).padStart(4, "0")), p]);
}
export const FLUSH = utf8("0000");
export function readPkts(body: Uint8Array): string[] {
  const out: string[] = [];
  let i = 0;
  while (i + 4 <= body.byteLength) {
    const n = parseInt(text(body.subarray(i, i + 4)), 16);
    if (n === 0) { out.push(""); i += 4; continue; }
    out.push(text(body.subarray(i + 4, i + n)).replace(/\n$/, ""));
    i += n;
  }
  return out;
}
