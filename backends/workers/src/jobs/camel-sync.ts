import { JOB_LIMITS, type JobVolumeSource } from "./job.ts";

/** Volume snapshots read by HostJob. */
export type SyncFile = { path: string; bytes: Uint8Array };
class SyncError extends Error {}

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
