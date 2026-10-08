import { meteredSegments, PreconditionFailed, removeSegments, segmentLog, validKey, type LogTail, type SegmentStore, type Storage, type StorageMeter } from "../../shared/storage.ts";
import type { Claim } from "../../src/ownership.ts";

/** How the object store misbehaves: at `rate`, an operation is slow, refused (5xx, throttled), or (a write) lands with its answer lost. */
export type StorageFaults = { rate: number; kinds: ("slow" | "error" | "throttle" | "lost")[]; slowMs: [number, number] };

/** What S3 answers when it refuses a request, as the SDK reports it. */
function s3Error(name: "InternalError" | "SlowDown", status: number) {
  return Object.assign(new Error(name === "SlowDown" ? "Please reduce your request rate." : "We encountered an internal error. Please try again."), { name, $metadata: { httpStatusCode: status }, simulated: true });
}

/**
 * The object store as S3 behaves, for the simulation: one store (`objects`) shared by every node, each node's view
 * failing once it crashed (`dead`), and every operation subject to `faults()` (none when it answers undefined):
 * - slow: the operation takes `slowMs` longer (on the node's timers), as S3's tail latency does;
 * - error, throttle: refused before it takes effect (500 InternalError, 503 SlowDown);
 * - lost: a create or delete that took effect, its answer lost (the connection dropped on the way back).
 * Objects are immutable once made (If-None-Match), as on S3. `draw` decides, from the simulation's seeded randomness.
 */
export function simStorage(tail: LogTail, meter: StorageMeter | undefined, objects: { logs: Map<string, Map<string, string>>; blobs: Map<string, Uint8Array> },
  dead: () => boolean, faults: () => StorageFaults | undefined, draw: { float(): number; int(n: number): number }, injected: Map<string, number>): Storage {
  /** Run `op` as S3 would under the faults in force. `writes` operations can lose their answer after taking effect. */
  async function s3<T>(op: () => T, writes = false): Promise<T> {
    if (dead()) throw new Error("The node crashed");
    const now = faults();
    const kind = now && draw.float() < now.rate ? now.kinds[draw.int(now.kinds.length)] : undefined;
    if (kind) injected.set(kind, (injected.get(kind) ?? 0) + 1);
    if (kind === "slow") await new Promise(resolve => setTimeout(resolve, now!.slowMs[0] + draw.int(now!.slowMs[1] - now!.slowMs[0] + 1)));
    if (kind === "error") throw s3Error("InternalError", 500);
    if (kind === "throttle") throw s3Error("SlowDown", 503);
    if (dead()) throw new Error("The node crashed");
    const result = op();
    if (kind === "lost" && writes) throw s3Error("InternalError", 500);
    return result;
  }
  const segments = (key: string): SegmentStore => {
    const objectsOf = () => { let entry = objects.logs.get(key); if (!entry) { entry = new Map(); objects.logs.set(key, entry); } return entry; };
    return meteredSegments({
      list: () => s3(() => {
        const names = [...objectsOf().keys()];
        return {
          segments: names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b),
          bytes: new Map(names.map(name => [name, Buffer.byteLength(objectsOf().get(name)!)])),
          snapshots: names.filter(name => name.startsWith("snapshot-")).map(name => Number(name.slice(9))).sort((a, b) => a - b),
        };
      }),
      read: name => s3(() => { const body = objectsOf().get(name); if (body === undefined) throw new Error(`Missing log object ${key}/${name}`); return body; }),
      create: (name, body) => s3(() => { if (objectsOf().has(name)) throw new PreconditionFailed(`${key}/${name}`); objectsOf().set(name, body); }, true),
      remove: names => s3(() => { for (const name of names) objectsOf().delete(name); }, true),
    }, key, meter);
  };
  return {
    metered: !!meter,
    log: <T>(key: string, claim?: Claim) => segmentLog<T>(segments(validKey(key)), key, tail, claim),
    async removeLog(key) { if (meter) await removeSegments(segments(validKey(key))); await s3(() => objects.logs.delete(validKey(key)), true); },
    readBlob: key => s3(() => { const data = objects.blobs.get(validKey(key)); return data && Uint8Array.from(data); }),
    async writeBlob(key, data) {
      if (await s3(() => objects.blobs.has(validKey(key)))) return;
      await s3(() => { if (!objects.blobs.has(key)) objects.blobs.set(key, Uint8Array.from(data)); }, true);
      meter?.(key, data.byteLength);
    },
    async removeBlobs(prefix) {
      for (const [key, data] of [...objects.blobs]) if (key.startsWith(prefix)) { await s3(() => objects.blobs.delete(key), true); meter?.(key, -data.byteLength); }
    },
    async removeBlob(key) {
      const data = await s3(() => objects.blobs.get(validKey(key)));
      if (!data) return;
      await s3(() => objects.blobs.delete(key), true);
      meter?.(key, -data.byteLength);
    },
    async *objects(prefix) {
      const listed = await s3(() => [
        ...[...objects.logs].filter(([key]) => key.startsWith(prefix)).flatMap(([key, entries]) => [...entries].map(([name, body]) => ({ key: `${key}.log/${name}`, bytes: Buffer.byteLength(body) }))),
        ...[...objects.blobs].filter(([key]) => key.startsWith(prefix)).map(([key, data]) => ({ key, bytes: data.byteLength })),
      ]);
      yield* listed;
    },
  };
}
