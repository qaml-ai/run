// Snapshots on our job hosts (docs/design/job-hosts-plan.md, slice 5), the runtime's side; HostJob (hosts.ts) uses it.
//
// The bytes live in the runtime's own R2 bucket (BUCKET) under `snapshots/<tenant>/<id>.gz`, and only the runtime
// touches R2: there is no S3 or R2 key anywhere else. A job's host moves the bytes through the runtime, as host-side
// sync does, with a token for that one job (hashed in the HostJob's SQLite, HostSnapshotStore here, gone with the job):
// - save: PUT /v1/internal/job-hosts/snapshots/<job>/parts/<n>, each part straight into an R2 multipart upload that the
//   job object starts on the first part, then POST …/complete with the size and sha256 the host computed;
// - load: GET /v1/internal/job-hosts/snapshots/<job>, the one snapshot that job's spec names, streamed from R2.
// The key is always the payer's tenant's, whatever handle the job was given. The handle (a ComputerSnapshot) is
// self-describing: its id is `host:<id>:<sha256 of the archive>` and its size is the archive's, which the host checks
// the download against. Each saved snapshot also has a record in the registry (hosts.ts JobHostRegistry), which deletes
// one superseded by a newer save of the same name for the same payer, and sweeps those past their expiry.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_PART_BYTES, type WireJob, type WireResult } from "../../../../shared/job-host-protocol.ts";
import { SNAPSHOT_TTL_MS, type ComputerSnapshot } from "../computers/provider.ts";
import { HOST_SNAPSHOT_PREFIX, isHostSnapshot } from "./driver.ts";
import type { JobSpec } from "./job.ts";

export type HostSnapshotEnv = {
  /** The runtime's R2 bucket: snapshots on hosts are on wherever it (and AGENT_PUBLIC_URL, for the hosts' routes) is. */
  BUCKET?: R2Bucket;
  AGENT_PUBLIC_URL?: string;
  TEST_MODE?: string;
  /** TEST_MODE only: a smaller upload part (at least R2's 5 MiB), and a shorter snapshot life, to test both. */
  JOB_HOST_SNAPSHOT_PART_BYTES?: string;
  JOB_HOST_SNAPSHOT_TTL_SECONDS?: string;
};

/** R2's smallest multipart part (all but the last). */
const R2_MIN_PART_BYTES = 5 * 1024 * 1024;
/** R2's most parts in one upload. */
export const SNAPSHOT_MAX_PARTS = 10_000;

export const snapshotsOn = (env: HostSnapshotEnv) => !!env.BUCKET && !!env.AGENT_PUBLIC_URL;
export function snapshotPartBytes(env: HostSnapshotEnv) {
  const test = Number(env.JOB_HOST_SNAPSHOT_PART_BYTES);
  return env.TEST_MODE === "1" && Number.isInteger(test) && test >= R2_MIN_PART_BYTES && test <= SNAPSHOT_PART_BYTES ? test : SNAPSHOT_PART_BYTES;
}
export function snapshotTtlMs(env: HostSnapshotEnv) {
  const test = Number(env.JOB_HOST_SNAPSHOT_TTL_SECONDS);
  return env.TEST_MODE === "1" && Number.isFinite(test) && test >= 1 ? test * 1000 : SNAPSHOT_TTL_MS;
}

/** A host snapshot's id and archive digest, from its handle's id `host:<id>:<sha256>`; undefined: not one. */
export function hostSnapshotParts(snapshot: Pick<ComputerSnapshot, "id">) {
  const match = /^host:(hs_[A-Za-z0-9_-]{16,64}):([0-9a-f]{64})$/.exec(snapshot.id);
  return match ? { id: match[1]!, sha256: match[2]! } : undefined;
}
/** A tenant id as it can appear in a snapshot's key and the host's cache id. */
const SNAPSHOT_TENANT = /^[A-Za-z0-9._-]{1,128}$/;
export const snapshotKey = (tenant: string, id: string) => `snapshots/${tenant}/${id}.gz`;
/** Who a save belongs to, for superseding: the payer (its tenant, and its agent or workflow). */
export const snapshotPayer = (payer: JobSpec["payer"]) => `${payer.tenant}:${payer.kind ?? "agent"}:${payer.agent}`;

/** What a job does with snapshots, once checked: the one it starts from, and the one it saves. */
export type HostSnapshotPlan = {
  /** The snapshot it starts from: its key (the payer's tenant's), the host cache id, and what the handle says. */
  load?: { key: string; cacheId: string; sha256: string; size: number };
  /** The snapshot it saves: a new id under the payer's tenant. */
  save?: { id: string; key: string; cacheId: string; name: string; payer: string; tenant: string };
};

/**
 * What a job on a host does with snapshots, checked before anything starts: a refusal (start_failed) for what hosts
 * cannot do, else its plan. Hosts run the workspace image, start only from their own snapshots, and save or start from
 * one only where the bucket is bound. Whether the snapshot still exists is the registry's (HostJob asks it next).
 */
export function hostSnapshotPlan(spec: Pick<JobSpec, "image" | "snapshot" | "saveSnapshot" | "payer">, env: HostSnapshotEnv, now = Date.now()): { refused: string } | HostSnapshotPlan {
  if (spec.image !== undefined && spec.image !== "workspace") return { refused: `Job hosts run the workspace image only, not ${spec.image}: run this job on Cloudflare Containers (JOB_PROVIDER=auto routes it there)` };
  if (spec.snapshot && !isHostSnapshot(spec.snapshot)) return { refused: `Snapshot ${spec.snapshot.name} was taken on Cloudflare Containers: run this job there (JOB_PROVIDER=auto routes it there)` };
  const from = spec.snapshot ? hostSnapshotParts(spec.snapshot) : undefined;
  if (spec.snapshot && !from) return { refused: `Snapshot ${spec.snapshot.name} is not a valid job host snapshot` };
  if (!from && !spec.saveSnapshot) return {};
  const tenant = spec.payer.tenant;
  if (!snapshotsOn(env)) return { refused: "Snapshots on job hosts are not configured here (they need the R2 bucket binding and AGENT_PUBLIC_URL)" };
  if (!SNAPSHOT_TENANT.test(tenant)) return { refused: "This tenant's id cannot name a job host snapshot" };
  if (spec.snapshot && spec.snapshot.expiresAt <= now) return { refused: `Snapshot ${spec.snapshot.name} expired; take a new one` };
  const saveId = spec.saveSnapshot ? `hs_${randomBytes(16).toString("base64url")}` : undefined;
  return {
    // The cache id the host keeps it under: the payer's tenant and the id, so no tenant starts from another's copy.
    ...(from ? { load: { key: snapshotKey(tenant, from.id), cacheId: `${tenant}/${from.id}`, sha256: from.sha256, size: spec.snapshot!.size } } : {}),
    ...(saveId ? { save: { id: saveId, key: snapshotKey(tenant, saveId), cacheId: `${tenant}/${saveId}`, name: spec.saveSnapshot!, payer: snapshotPayer(spec.payer), tenant } } : {}),
  };
}

/** The job's snapshot routes, for its host, with its token. */
export function snapshotWire(plan: HostSnapshotPlan, job: string, token: string, env: HostSnapshotEnv): Pick<WireJob, "snapshot" | "save"> {
  const url = `${env.AGENT_PUBLIC_URL!.replace(/\/+$/, "")}/v1/internal/job-hosts/snapshots/${encodeURIComponent(job)}`;
  return {
    ...(plan.load ? { snapshot: { id: plan.load.cacheId, url, token, sha256: plan.load.sha256, size: plan.load.size } } : {}),
    ...(plan.save ? { save: { id: plan.save.cacheId, url, token, partBytes: snapshotPartBytes(env) } } : {}),
  };
}

/** A completed save, as HostSnapshotStore keeps it. */
export type SavedSnapshot = { size: number; sha256: string; createdAt: number; expiresAt: number };

/** The result's snapshot handle, or why there is none: a save is only what the runtime itself completed. */
export function snapshotResult(plan: HostSnapshotPlan, saved: SavedSnapshot | undefined, wire: Extract<WireResult, { ok: true }>): { snapshot?: ComputerSnapshot; snapshotError?: string } {
  if (!plan.save || wire.exitCode !== 0 || wire.timedOut) return {};
  if (saved) return { snapshot: { id: `${HOST_SNAPSHOT_PREFIX}${plan.save.id}:${saved.sha256}`, name: plan.save.name, size: saved.size, image: "workspace", createdAt: saved.createdAt, expiresAt: saved.expiresAt } };
  return { snapshotError: (wire.snapshotError ?? "The job host did not save the snapshot").slice(0, 500) };
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
type Row = { hash: string; expires_at: number; load_key: string | null; load_size: number | null; save_key: string | null; upload_id: string | null; saved_size: number | null };

/**
 * A job's snapshot routes (HostJob), in the job object's own SQLite: its token (hashed) and until when, the key it may
 * read, the key it may write, the R2 multipart upload in progress (its id and each part's etag), and the save once
 * completed. One job's record; a run made again replaces it, and the job's end clears it.
 */
export class HostSnapshotStore {
  private readonly sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS host_snapshot (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, expires_at INTEGER NOT NULL, load_key TEXT, load_size INTEGER,
      save_key TEXT, upload_id TEXT, saved_size INTEGER, saved_sha256 TEXT, created_at INTEGER, saved_expires_at INTEGER)`);
    sql.exec("CREATE TABLE IF NOT EXISTS host_snapshot_parts (n INTEGER PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL)");
  }
  put(token: string, expiresAt: number, load?: { key: string; size: number }, saveKey?: string) {
    this.clear();
    this.sql.exec("INSERT INTO host_snapshot (id, hash, expires_at, load_key, load_size, save_key) VALUES (1, ?, ?, ?, ?, ?)", digest(token), expiresAt, load?.key ?? null, load?.size ?? null, saveKey ?? null);
  }
  /** The record for a bearer of the token, while it lasts; undefined: refused. */
  private row(token: string, now: number) {
    const row = this.sql.exec<Row>("SELECT hash, expires_at, load_key, load_size, save_key, upload_id, saved_size FROM host_snapshot WHERE id = 1").toArray()[0];
    return row && row.expires_at > now && same(digest(token), row.hash) ? row : undefined;
  }
  /** What the token may read: the snapshot the job starts from. */
  load(token: string, now = Date.now()): { ok: true; key: string; size: number } | { ok: false; status: 401 | 404 } {
    const row = this.row(token, now);
    if (!row) return { ok: false, status: 401 };
    return row.load_key ? { ok: true, key: row.load_key, size: Number(row.load_size) } : { ok: false, status: 404 };
  }
  /** What the token may write, and the upload in progress (no id yet: the first part starts it). */
  save(token: string, now = Date.now()): { ok: true; key: string; uploadId?: string; done: boolean } | { ok: false; status: 401 | 404 } {
    const row = this.row(token, now);
    if (!row) return { ok: false, status: 401 };
    if (!row.save_key) return { ok: false, status: 404 };
    return { ok: true, key: row.save_key, ...(row.upload_id ? { uploadId: row.upload_id } : {}), done: row.saved_size !== null };
  }
  started(uploadId: string) { this.sql.exec("UPDATE host_snapshot SET upload_id = ? WHERE id = 1", uploadId); }
  part(n: number, etag: string, size: number) { this.sql.exec("INSERT OR REPLACE INTO host_snapshot_parts (n, etag, size) VALUES (?, ?, ?)", n, etag, size); }
  parts() { return this.sql.exec<{ n: number; etag: string; size: number }>("SELECT n, etag, size FROM host_snapshot_parts ORDER BY n").toArray().map(part => ({ n: Number(part.n), etag: part.etag, size: Number(part.size) })); }
  /** The bytes written so far, but for part `n` (written again). */
  writtenBesides(n: number) { return Number(this.sql.exec<{ total: number }>("SELECT COALESCE(SUM(size), 0) AS total FROM host_snapshot_parts WHERE n != ?", n).one().total); }
  completed(saved: SavedSnapshot) {
    this.sql.exec("UPDATE host_snapshot SET saved_size = ?, saved_sha256 = ?, created_at = ?, saved_expires_at = ? WHERE id = 1", saved.size, saved.sha256, saved.createdAt, saved.expiresAt);
  }
  /** The completed save, if there is one. */
  saved(): SavedSnapshot | undefined {
    const row = this.sql.exec<{ saved_size: number | null; saved_sha256: string | null; created_at: number | null; saved_expires_at: number | null }>("SELECT saved_size, saved_sha256, created_at, saved_expires_at FROM host_snapshot WHERE id = 1").toArray()[0];
    return row && row.saved_size !== null ? { size: Number(row.saved_size), sha256: row.saved_sha256!, createdAt: Number(row.created_at), expiresAt: Number(row.saved_expires_at) } : undefined;
  }
  /** An upload started and never completed: its key and id, to abort. */
  unfinished(): { key: string; uploadId: string } | undefined {
    const row = this.sql.exec<{ save_key: string | null; upload_id: string | null; saved_size: number | null }>("SELECT save_key, upload_id, saved_size FROM host_snapshot WHERE id = 1").toArray()[0];
    return row?.save_key && row.upload_id && row.saved_size === null ? { key: row.save_key, uploadId: row.upload_id } : undefined;
  }
  clear() {
    this.sql.exec("DELETE FROM host_snapshot");
    this.sql.exec("DELETE FROM host_snapshot_parts");
  }
}

/** A part's checks before it is written: its number, its size, and the total so far within the cap. */
export function checkPart(n: number, length: number, partBytes: number, writtenBesides: number): string | undefined {
  if (!Number.isInteger(n) || n < 1 || n > SNAPSHOT_MAX_PARTS) return "Invalid part number";
  if (!Number.isInteger(length) || length < 1 || length > partBytes) return `A part is 1 to ${partBytes} bytes, with its Content-Length`;
  if (writtenBesides + length > SNAPSHOT_MAX_BYTES) return `A snapshot is at most ${SNAPSHOT_MAX_BYTES} bytes`;
  return undefined;
}
/**
 * A completion's checks: parts 1 to N with none missing, every one but the last exactly a part's size (R2's rule),
 * and the size the host says is what was written.
 */
export function checkComplete(parts: { n: number; size: number }[], partBytes: number, size: unknown, sha256: unknown): string | undefined {
  if (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > SNAPSHOT_MAX_BYTES || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return "A completion says the snapshot's size and sha256";
  if (!parts.length || parts.some((part, index) => part.n !== index + 1)) return "The snapshot's parts are not all there";
  if (parts.slice(0, -1).some(part => part.size !== partBytes)) return `Every part but the last is ${partBytes} bytes`;
  if (parts.reduce((sum, part) => sum + part.size, 0) !== size) return "The snapshot's parts do not add up to its size";
  return undefined;
}
