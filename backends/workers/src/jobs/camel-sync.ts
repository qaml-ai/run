import type { ContainerApi } from "../computers/provider.ts";
import { JOB_LIMITS, JOB_REPO, jobPath, type JobFiles, type JobVolumeSource } from "./job.ts";

/**
 * camel-sync, phase 1: the runtime pushes a job's files into its container as one tar stream on the stdin of `tar -x`
 * in /repo, before the command. No FUSE and no network filesystem. The design's version runs in the container and asks
 * the repository object for only the paths that differ from the snapshot's commit; that needs the repository object,
 * so this one sends the whole set it is given (inline files, or a volume snapshot's tree).
 */
export type SyncFile = { path: string; bytes: Uint8Array };
export class SyncError extends Error {}

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

/** Inline files as sync files, in path order. */
export async function* inlineFiles(files: JobFiles): AsyncGenerator<SyncFile> {
  for (const path of Object.keys(files).sort()) yield { path, bytes: files[path] };
}

type VolumeEntry = { path: string; key: string; size: number; sha256?: string };
type VolumeReader = { readSet(prefix?: string, snapshot?: string): Promise<{ files: VolumeEntry[] }> | { files: VolumeEntry[] } };
export type VolumeSyncEnv = {
  VOLUMES?: { getByName(name: string): VolumeReader };
  BUCKET?: { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> };
};
async function sha256(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map(b => b.toString(16).padStart(2, "0")).join("");
}
/**
 * A volume snapshot's files, read from object storage by the keys the snapshot pins (so no garbage collection takes
 * them mid-sync), each checked against its digest as Volume.read does.
 */
export async function* volumeFiles(env: VolumeSyncEnv, source: JobVolumeSource): AsyncGenerator<SyncFile> {
  if (!env.VOLUMES || !env.BUCKET) throw new SyncError("Volume storage is not bound here");
  const { files } = await env.VOLUMES.getByName(`${source.tenant}:${source.volume}`).readSet("/", source.snapshot);
  if (files.length > JOB_LIMITS.syncFiles) throw new SyncError(`A job syncs at most ${JOB_LIMITS.syncFiles} files`);
  let total = 0;
  for (const file of files) total += file.size;
  if (total > JOB_LIMITS.syncBytes) throw new SyncError(`A job syncs at most ${JOB_LIMITS.syncBytes} bytes`);
  for (const file of files) {
    if (file.size > JOB_LIMITS.syncFileBytes) throw new SyncError(`${file.path} is larger than a job syncs (${JOB_LIMITS.syncFileBytes} bytes)`);
    const object = await env.BUCKET.get(file.key);
    if (!object) throw new SyncError(`${file.path}: file object missing`);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== file.size || await sha256(bytes) !== (file.sha256 ?? file.key.split("/").at(-1)))
      throw new SyncError(`${file.path}: file integrity check failed`);
    yield { path: file.path, bytes };
  }
}

async function readSmall(stream: ReadableStream<Uint8Array> | null, max = 4096) {
  if (!stream) return "";
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size < max) chunks.push(value.subarray(0, max - size));
      size += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(concat(chunks));
}
function concat(chunks: Uint8Array[]) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/**
 * Stream `files` into /repo through `tar -x`. Every path is checked again here (relative, no `..`); a duplicate keeps
 * the last. Returns the files and bytes written.
 */
export async function camelSync(container: Pick<ContainerApi, "exec">, files: AsyncIterable<SyncFile>, signal: AbortSignal) {
  const process = await container.exec(["tar", "-x", "-f", "-", "-C", JOB_REPO, "--no-same-owner", "--no-same-permissions"], {
    signal, stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  if (!process.stdin) throw new SyncError("Container stdin unavailable");
  const writer = process.stdin.getWriter(), stderr = readSmall(process.stderr);
  let count = 0, bytes = 0;
  try {
    for await (const file of files) {
      const path = jobPath(file.path, "file path");
      for (const block of tarEntry(path, file.bytes)) if (block.byteLength) await writer.write(block);
      count++; bytes += file.bytes.byteLength;
    }
    await writer.write(tarEnd());
    await writer.close();
  } catch (error) {
    process.kill(9);
    await writer.abort(error).catch(() => {});
    throw error instanceof SyncError ? error : new SyncError(`Sync failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown"}`);
  } finally {
    writer.releaseLock();
  }
  const [code, message] = await Promise.all([process.exitCode, stderr]);
  if (code) throw new SyncError(`tar exited ${code}: ${message.trim().slice(0, 500)}`);
  return { files: count, bytes };
}
