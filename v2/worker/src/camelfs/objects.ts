import { ApiError } from "../types.ts";

export type ObjectKind = "blob" | "tree" | "commit";
export type WriteDurabilityMode = "serial_r2" | "parallel_r2" | "sqlite_async_r2";

export interface TreeEntry {
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mode: number;
  hash: string;
  linkTarget?: string;
}

export interface CommitObject {
  tree: string;
  parents: string[];
  author: string;
  message: string;
  createdAt: number;
}

export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface ReadResponse {
  commit: string;
  path: string;
  size: number;
  mode: number;
  binary: boolean;
  content: string | null;
  base64: string | null;
}

export const DEFAULT_REF = "refs/heads/main";
export const DEFAULT_FILE_MODE = 0o644;
export const EXEC_FILE_MODE = 0o755;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export function objectKey(hash: string): string {
  return `objects/${hash.slice(0, 2)}/${hash}`;
}

/**
 * Computes the canonical Git-style SHA-256 content hash matching v2/camelfsd/internal/store:
 * sha256("<kind> <byteLength>\0<data>")
 */
export async function hashObject(kind: ObjectKind, data: Uint8Array): Promise<string> {
  const header = encoder.encode(`${kind} ${data.byteLength}\0`);
  const combined = new Uint8Array(header.byteLength + data.byteLength);
  combined.set(header, 0);
  combined.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function putObjectPrehashed(
  bucket: R2Bucket,
  kind: ObjectKind,
  hash: string,
  data: Uint8Array,
): Promise<void> {
  await bucket.put(objectKey(hash), data, {
    customMetadata: { kind },
  });
}

export async function putObjectsParallel(
  bucket: R2Bucket,
  items: Array<{ kind: ObjectKind; hash: string; data: Uint8Array }>,
  concurrency = 6,
): Promise<void> {
  if (items.length === 0) return;
  if (items.length <= concurrency) {
    await Promise.all(items.map((it) => putObjectPrehashed(bucket, it.kind, it.hash, it.data)));
    return;
  }
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      const it = items[i];
      await putObjectPrehashed(bucket, it.kind, it.hash, it.data);
    }
  });
  await Promise.all(workers);
}

export async function putObject(
  bucket: R2Bucket,
  kind: ObjectKind,
  data: Uint8Array,
): Promise<string> {
  const hash = await hashObject(kind, data);
  await putObjectPrehashed(bucket, kind, hash, data);
  return hash;
}

export function encodeTreeBytes(entries: TreeEntry[]): Uint8Array {
  const canonical = entries
    .map((e) => ({
      path: e.path,
      type: e.type || "file",
      size: e.size,
      mode: e.mode || DEFAULT_FILE_MODE,
      hash: e.hash,
      ...(e.linkTarget ? { linkTarget: e.linkTarget } : {}),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return encoder.encode(JSON.stringify(canonical));
}

export function encodeCommitBytes(commit: CommitObject): Uint8Array {
  const canonical: CommitObject = {
    tree: commit.tree,
    parents: commit.parents ?? [],
    author: commit.author,
    message: commit.message,
    createdAt: commit.createdAt,
  };
  return encoder.encode(JSON.stringify(canonical));
}

async function decompressZlib(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  const writePromise = writer.write(compressed).then(() => writer.close());
  const out = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  await writePromise;
  return out;
}

/**
 * Unpacks a legacy AWS S3 camelfsd object (`zlib.compress("<kind>\0<data>")`).
 * Allows direct cloud-to-cloud S3 -> R2 migration (Sippy / Super Slurper) without
 * re-uploading or decompressing 368k+ objects offline!
 */
export async function unpackLegacyS3Object(
  compressed: Uint8Array,
): Promise<{ kind: ObjectKind; data: Uint8Array }> {
  const raw = await decompressZlib(compressed);
  const sep = raw.indexOf(0);
  if (sep <= 0) {
    throw new ApiError(500, "internal", "corrupt legacy zlib-packed camelfs object header");
  }
  const kind = decoder.decode(raw.subarray(0, sep)) as ObjectKind;
  return { kind, data: raw.subarray(sep + 1) };
}

export async function getObject(
  bucket: R2Bucket,
  hash: string,
  expectedKind?: ObjectKind,
): Promise<{ kind: ObjectKind; data: Uint8Array }> {
  const obj = await bucket.get(objectKey(hash));
  if (!obj) {
    throw new ApiError(404, "not_found", `object ${hash} not found`);
  }
  const raw = new Uint8Array(await obj.arrayBuffer());
  const metaKind = obj.customMetadata?.kind as ObjectKind | undefined;
  let kind: ObjectKind;
  let data: Uint8Array;

  if (metaKind) {
    kind = metaKind;
    data = raw;
  } else if (raw.byteLength >= 2 && (raw[0] & 0x0f) === 0x08 && ((raw[0] << 8) | raw[1]) % 31 === 0) {
    // Legacy AWS S3 object copied directly via R2 Sippy / Super Slurper (zlib RFC 1950 header).
    try {
      const unpacked = await unpackLegacyS3Object(raw);
      kind = unpacked.kind;
      data = unpacked.data;
    } catch {
      kind = "blob";
      data = raw;
    }
  } else {
    kind = "blob";
    data = raw;
  }

  if (expectedKind && kind !== expectedKind) {
    throw new ApiError(500, "internal", `expected ${expectedKind} object for ${hash}, got ${kind}`);
  }
  return { kind, data };
}

export async function putTree(bucket: R2Bucket, entries: TreeEntry[]): Promise<string> {
  return putObject(bucket, "tree", encodeTreeBytes(entries));
}

export async function getTree(bucket: R2Bucket, hash: string): Promise<TreeEntry[]> {
  if (!hash) return [];
  const { data } = await getObject(bucket, hash, "tree");
  const parsed = JSON.parse(decoder.decode(data)) as TreeEntry[] | null;
  return Array.isArray(parsed) ? parsed : [];
}

export async function putCommit(bucket: R2Bucket, commit: CommitObject): Promise<string> {
  return putObject(bucket, "commit", encodeCommitBytes(commit));
}

export async function getCommit(bucket: R2Bucket, hash: string): Promise<CommitObject> {
  const { data } = await getObject(bucket, hash, "commit");
  const parsed = JSON.parse(decoder.decode(data)) as CommitObject;
  if (!Array.isArray(parsed.parents)) parsed.parents = [];
  return parsed;
}

export function normalizeRelPath(raw: string, allowEmpty: boolean): string {
  let s = raw.trim().replaceAll("\\", "/");
  if (s === "/workspace") s = "";
  else if (s.startsWith("/workspace/")) s = s.slice("/workspace/".length);
  s = s.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!s || s === ".") {
    if (allowEmpty) return "";
    throw new ApiError(400, "invalid_request", "path is required");
  }
  const parts: string[] = [];
  for (const part of s.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      throw new ApiError(400, "invalid_request", `invalid path traversal in "${raw}"`);
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (!joined) {
    if (allowEmpty) return "";
    throw new ApiError(400, "invalid_request", "path is required");
  }
  return joined;
}

export function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function isBinary(data: Uint8Array): boolean {
  const check = Math.min(data.byteLength, 8000);
  for (let i = 0; i < check; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}

export function buildReadResponse(
  commitHash: string,
  relPath: string,
  data: Uint8Array,
  mode: number,
  offset = 0,
  limit = 0,
): ReadResponse {
  const fullSize = data.byteLength;
  const bin = isBinary(data);
  const start = Math.min(Math.max(0, offset), fullSize);
  const end = limit > 0 && start + limit < fullSize ? start + limit : fullSize;
  const slice = data.subarray(start, end);
  return {
    commit: commitHash,
    path: relPath,
    size: fullSize,
    mode,
    binary: bin,
    content: bin ? null : decoder.decode(slice),
    base64: bin ? bytesToBase64(slice) : null,
  };
}

export function compileGlob(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (".+^${}()|[]\\".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
    i += 1;
  }
  out += "$";
  return new RegExp(out);
}

export function filterListEntries(
  entries: TreeEntry[],
  normDir: string,
  recursive: boolean,
  glob?: string,
): TreeEntry[] {
  let globRe: RegExp | null = null;
  if (glob && glob.trim()) {
    try {
      globRe = compileGlob(glob.trim());
    } catch (err) {
      throw new ApiError(400, "invalid_request", `invalid glob "${glob}": ${String(err)}`);
    }
  }
  const matchesGlob = (p: string): boolean => {
    if (!globRe) return true;
    if (globRe.test(p)) return true;
    if (normDir && p.startsWith(`${normDir}/`)) {
      return globRe.test(p.slice(normDir.length + 1));
    }
    return false;
  };

  if (normDir) {
    const exact = entries.find((e) => e.path === normDir && e.type !== "dir");
    if (exact) return matchesGlob(exact.path) ? [exact] : [];
  }

  const prefix = normDir ? `${normDir}/` : "";
  if (recursive) {
    return entries
      .filter((e) => (!prefix || e.path.startsWith(prefix)) && e.type !== "dir" && matchesGlob(e.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  const seenDirs = new Set<string>();
  const out: TreeEntry[] = [];
  for (const ent of entries) {
    if (prefix && !ent.path.startsWith(prefix)) continue;
    const rel = ent.path.slice(prefix.length);
    if (!rel) continue;
    const slash = rel.indexOf("/");
    if (slash >= 0) {
      const dirPath = prefix + rel.slice(0, slash);
      if (!seenDirs.has(dirPath)) {
        seenDirs.add(dirPath);
        if (matchesGlob(dirPath)) {
          out.push({ path: dirPath, type: "dir", size: 0, mode: EXEC_FILE_MODE, hash: "" });
        }
      }
    } else if (ent.type === "dir") {
      if (!seenDirs.has(ent.path)) {
        seenDirs.add(ent.path);
        if (matchesGlob(ent.path)) out.push(ent);
      }
    } else if (matchesGlob(ent.path)) {
      out.push(ent);
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export function grepTextLines(
  re: RegExp,
  filePath: string,
  data: Uint8Array,
  maxMatches: number,
  out: GrepMatch[],
): boolean {
  if (isBinary(data)) return false;
  const text = decoder.decode(data);
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "" && text.endsWith("\n")) {
    lines.pop();
  }
  for (let i = 0; i < lines.length; i++) {
    const clean = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
    const m = re.exec(clean);
    if (m) {
      out.push({
        path: filePath,
        line: i + 1,
        column: m.index + 1,
        text: clean,
      });
      if (out.length >= maxMatches) return true;
    }
  }
  return false;
}

export function encodeVmId(lineage: string): string {
  const bytes = encoder.encode(lineage);
  let b64 = "";
  for (const b of bytes) b64 += String.fromCharCode(b);
  const linB64 = btoa(b64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  const hex = Array.from(rand, (x) => x.toString(16).padStart(2, "0")).join("");
  return `vm_${linB64}_${hex}`;
}

export function decodeVmLineage(vmId: string): string | null {
  if (!vmId.startsWith("vm_")) return null;
  const rest = vmId.slice(3);
  const sep = rest.lastIndexOf("_");
  if (sep <= 0) return null;
  const b64url = rest.slice(0, sep);
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4);
  try {
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}
