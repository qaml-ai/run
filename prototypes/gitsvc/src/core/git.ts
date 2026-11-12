// Git as a wire format, written from a Durable Object: blob/tree/commit hashing, a pack writer, pkt-line, and a
// push over smart HTTP v1 (git-receive-pack) to an Artifacts repo. No working tree, no git binary: the object owns
// the tree index (path -> blob sha) and ships only the NEW objects of a commit (changed blobs, the trees on their
// paths, the commit); the server already has everything else. Reads come back through the Artifacts binding
// (readTree / readBlob / readFile), never through a clone.

const encoder = new TextEncoder();

export type Sha = string; // 40 hex chars

/** `<type> <size>\0<content>` hashed with SHA-1: the object id. */
export async function hashObject(type: "blob" | "tree" | "commit", content: Uint8Array): Promise<Sha> {
  const header = encoder.encode(`${type} ${content.byteLength}\0`);
  const bytes = concat([header, content]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return hex(digest);
}

export const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export const unhex = (text: string) => new Uint8Array(text.match(/../g)!.map((h) => parseInt(h, 16)));

export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export type TreeEntry = { mode: "100644" | "100755" | "120000" | "40000"; name: string; sha: Sha };

/** Git sorts tree entries by name as if directories ended in "/". */
function treeSortKey(entry: TreeEntry) { return entry.mode === "40000" ? `${entry.name}/` : entry.name; }

export function encodeTree(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  return concat(sorted.flatMap((entry) => [encoder.encode(`${entry.mode} ${entry.name}\0`), unhex(entry.sha)]));
}

export type CommitInput = { tree: Sha; parents: Sha[]; message: string; author: { name: string; email: string }; at?: number };

export function encodeCommit(input: CommitInput): Uint8Array {
  const seconds = Math.floor((input.at ?? Date.now()) / 1000);
  const person = `${input.author.name} <${input.author.email}> ${seconds} +0000`;
  const lines = [`tree ${input.tree}`, ...input.parents.map((p) => `parent ${p}`), `author ${person}`, `committer ${person}`, "", input.message.endsWith("\n") ? input.message : `${input.message}\n`];
  return encoder.encode(lines.join("\n"));
}

/** An object to ship: its type and raw content. */
export type PackObject = { type: "blob" | "tree" | "commit"; content: Uint8Array };
const TYPE_CODE = { commit: 1, tree: 2, blob: 3 } as const;

async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  // "deflate" in CompressionStream is zlib-wrapped (RFC 1950), which is what git's pack format stores.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Pack v2 of whole (undeltified) objects. Thin by nature: anything unchanged is referenced by sha, never sent. */
export async function writePack(objects: PackObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12);
  header.set(encoder.encode("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, objects.length);
  const parts: Uint8Array[] = [header];
  for (const object of objects) {
    // Object header: a varint whose first byte carries 3 bits of type and 4 bits of size.
    let size = object.content.byteLength;
    const head: number[] = [];
    let byte = (TYPE_CODE[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) { head.push(byte | 0x80); byte = size & 0x7f; size >>= 7; }
    head.push(byte);
    parts.push(new Uint8Array(head), await zlib(object.content));
  }
  const body = concat(parts);
  const trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
  return concat([body, trailer]);
}

export function pktLine(text: string | Uint8Array): Uint8Array {
  const payload = typeof text === "string" ? encoder.encode(text) : text;
  return concat([encoder.encode((payload.byteLength + 4).toString(16).padStart(4, "0")), payload]);
}
export const FLUSH = encoder.encode("0000");

/** The pkt-lines of a response, flush packets as "". */
export function parsePktLines(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    const length = parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (length === 0) { lines.push(""); offset += 4; continue; }
    lines.push(decoder.decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/, ""));
    offset += length;
  }
  return lines;
}

export const ZERO_SHA = "0".repeat(40);

export type RefUpdate = { ref: string; old: Sha; new: Sha };

/** The refs a remote advertises for receive-pack. */
export async function listRefs(remote: string, token: string): Promise<Map<string, Sha>> {
  const response = await fetch(`${remote}/info/refs?service=git-receive-pack`, { headers: authHeaders(token) });
  if (!response.ok) throw new Error(`info/refs ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const refs = new Map<string, Sha>();
  for (const line of parsePktLines(new Uint8Array(await response.arrayBuffer()))) {
    if (!line || line.startsWith("#")) continue;
    const [sha, rest] = line.split(" ");
    const ref = rest.split("\0")[0];
    if (/^[0-9a-f]{40}$/.test(sha) && ref !== "capabilities^{}") refs.set(ref, sha);
  }
  return refs;
}

/**
 * One push: every ref update is a compare-and-swap (`old` must be the remote's current value, ZERO_SHA for "must not
 * exist"), which is the only lock a branch head needs. Throws with the server's report when a ref is rejected.
 */
export async function push(remote: string, token: string, updates: RefUpdate[], objects: PackObject[]): Promise<void> {
  const commands = updates.map((update, index) => pktLine(`${update.old} ${update.new} ${update.ref}${index === 0 ? "\0report-status" : ""}\n`));
  const body = concat([...commands, FLUSH, await writePack(objects)]);
  const response = await fetch(`${remote}/git-receive-pack`, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/x-git-receive-pack-request", accept: "application/x-git-receive-pack-result" },
    body: body as BodyInit,
  });
  if (!response.ok) throw new Error(`git-receive-pack ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const report = parsePktLines(new Uint8Array(await response.arrayBuffer())).filter(Boolean);
  const failed = report.filter((line) => line.startsWith("ng ") || (line.startsWith("unpack") && line !== "unpack ok"));
  if (failed.length) throw new PushRejected(failed.join("; "), report);
}

export class PushRejected extends Error {
  readonly report: string[];
  constructor(message: string, report: string[]) { super(`push rejected: ${message}`); this.report = report; }
}

/** The token's secret is the part before `?expires=`; Artifacts takes it as a Bearer header. */
export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token.split("?")[0]}` };
}
