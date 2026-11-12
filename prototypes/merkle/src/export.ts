// GitHub mirroring: the store's objects are git objects, so an export is a pack of the commits since what the remote
// has, plus the trees and blobs those commits reach and the remote's commits do not. The same bytes, the same ids:
// `git-receive-pack` at GitHub takes this pack as is (with `old new ref` for the CAS), and the prototype test checks it
// with `git index-pack` + `git fsck --strict`. No git server, no clone: the walk is in SQLite, the blobs come from R2.
import { decodeCommit, isTree, type Sha } from "./objects.ts";
import type { MerkleStore } from "./store.ts";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

type PackObject = { type: "blob" | "tree" | "commit"; content: Uint8Array };
const TYPE = { commit: 1, tree: 2, blob: 3 } as const;

/** Commits from `head` back to (not including) any of `haves` or the history horizon, with everything they add. */
export async function exportObjects(store: MerkleStore, head: Sha, haves: Sha[]): Promise<PackObject[]> {
  const have = new Set(haves);
  const known = new Set<Sha>();
  const mark = (tree: Sha) => { if (known.has(tree)) return; known.add(tree); for (const e of store.tree(tree)) isTree(e) ? mark(e.sha) : known.add(e.sha); };
  for (const h of haves) { const b = store.commitBody(h); if (b) mark(decodeCommit(b).tree); }
  const objects: PackObject[] = [];
  const blobs: Sha[] = [];
  const addTree = (tree: Sha) => {
    if (known.has(tree)) return;
    known.add(tree);
    objects.push({ type: "tree", content: store.treeBody(tree)! });
    for (const e of store.tree(tree)) isTree(e) ? addTree(e.sha) : known.has(e.sha) || (known.add(e.sha), blobs.push(e.sha));
  };
  const stack = [head], seen = new Set<Sha>();
  while (stack.length) {
    const c = stack.pop()!;
    if (have.has(c) || seen.has(c)) continue;
    seen.add(c);
    const body = store.commitBody(c);
    if (!body) throw new Error(`commit ${c} is beyond the history horizon: mirror before it is cut`);
    objects.push({ type: "commit", content: body });
    const parsed = decodeCommit(body);
    addTree(parsed.tree);
    stack.push(...parsed.parents);
  }
  for (const sha of blobs) objects.push({ type: "blob", content: await store.getBlob(sha) });
  return objects;
}

export async function exportPack(store: MerkleStore, head: Sha, haves: Sha[]): Promise<Uint8Array> {
  return writePack(await exportObjects(store, head, haves));
}

/** Pack v2 of whole (undeltified) objects. */
export function writePack(objects: PackObject[]): Uint8Array {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write("PACK", 0); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) {
    let size = o.content.byteLength;
    const head: number[] = [];
    let byte = (TYPE[o.type] << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) { head.push(byte | 0x80); byte = size & 0x7f; size >>= 7; }
    head.push(byte);
    parts.push(Buffer.from(head), deflateSync(o.content));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}
