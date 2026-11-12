// Git-compatible objects: a volume version is a tree of these, so its root hash IS the git tree id, and exporting
// to git or GitHub is writing the same bytes into a pack. SHA-1 because that is what GitHub speaks (sha256 repos are
// not supported there); `node:crypto` is synchronous in Node and in workerd (nodejs_compat), which lets the Durable
// Object build and merge trees inside one synchronous block with no await (see store.ts on why that matters for GC).
import { createHash } from "node:crypto";

export type Sha = string; // 40 hex chars
export type Mode = "100644" | "100755" | "120000" | "40000";
export type Entry = { mode: Mode; name: string; sha: Sha };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function hashObject(type: "blob" | "tree" | "commit", content: Uint8Array): Sha {
  return createHash("sha1").update(`${type} ${content.byteLength}\0`).update(content).digest("hex");
}

export const isTree = (e: Entry) => e.mode === "40000";
const sortKey = (e: Entry) => (isTree(e) ? `${e.name}/` : e.name);
const byGitOrder = (a: Entry, b: Entry) => { const x = sortKey(a), y = sortKey(b); return x < y ? -1 : x > y ? 1 : 0; };

export function encodeTree(entries: Entry[]): Uint8Array {
  const sorted = [...entries].sort(byGitOrder);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const e of sorted) {
    const head = encoder.encode(`${e.mode} ${e.name}\0`);
    const raw = Buffer.from(e.sha, "hex");
    parts.push(head, raw); size += head.byteLength + 20;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

export function decodeTree(bytes: Uint8Array): Entry[] {
  const out: Entry[] = [];
  let i = 0;
  while (i < bytes.length) {
    const space = bytes.indexOf(0x20, i), nul = bytes.indexOf(0, space);
    const mode = decoder.decode(bytes.subarray(i, space)) as Mode;
    const name = decoder.decode(bytes.subarray(space + 1, nul));
    const sha = Buffer.from(bytes.subarray(nul + 1, nul + 21)).toString("hex");
    out.push({ mode: mode === ("040000" as Mode) ? "40000" : mode, name, sha });
    i = nul + 21;
  }
  return out;
}

export const EMPTY_TREE = encodeTree([]);
export const EMPTY_TREE_SHA = hashObject("tree", EMPTY_TREE); // 4b825dc642cb6eb9a060e54bf8d69288fbee4904

export type CommitInput = { tree: Sha; parents: Sha[]; message: string; at: number };
export function encodeCommit(c: CommitInput): Uint8Array {
  const who = `camelRun <volumes@camelai.com> ${Math.floor(c.at / 1000)} +0000`;
  return encoder.encode(
    `tree ${c.tree}\n${c.parents.map((p) => `parent ${p}\n`).join("")}author ${who}\ncommitter ${who}\n\n${c.message}\n`,
  );
}
export function decodeCommit(bytes: Uint8Array): { tree: Sha; parents: Sha[] } {
  const text = decoder.decode(bytes);
  const tree = /^tree ([0-9a-f]{40})$/m.exec(text)![1];
  const parents = [...text.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]);
  return { tree, parents };
}

export const utf8 = (s: string) => encoder.encode(s);
export const text = (b: Uint8Array) => decoder.decode(b);
