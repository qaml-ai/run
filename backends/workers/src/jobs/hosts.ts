// Jobs on our own hosts (docs/design/job-hosts-plan.md, slices 3 and 4), behind the JobDriver seam (driver.ts):
// - JobHostRegistry: the hosts, their free slots and last heartbeat, and who may connect (one object, "hosts"). A host
//   enrolls first (POST /v1/internal/job-hosts/enroll): it proves who it is with an attestation (shared/job-host-attest.ts:
//   AWS sts:GetCallerIdentity in production, a test secret in tests), and gets a short-lived credential bound to the host
//   id the attestation proves. A host can be revoked: its credentials go, its socket closes, it takes no job;
// - JobHost: one per host. The host's agent (jobhost/agent.ts) dials out to it over a WebSocket; its first message is
//   its credential, checked against the registry, and the socket closes when the credential expires. It sends the host
//   only that host's jobs and takes their results;
// - HostJob: one per job id, as ContainerComputer is for a container job: it admits the payer, takes a computer slot,
//   places the job on a host, meters it from dispatch to result under the session `job:<id>` (so a job run again is
//   charged once), and answers the JobResult;
// - snapshots (slice 5, host-snapshots.ts): a job may save its disk (saveSnapshot) or start from one saved on a host,
//   its bytes in R2 through token-authorised runtime routes (no storage key anywhere else). Hosts report the snapshots
//   they hold, and placement prefers a holder. On wherever the R2 bucket (BUCKET) and AGENT_PUBLIC_URL are.
// Off by default: jobDriver() picks these only where the bindings and JOB_HOST_ATTESTORS are set (test configs today).
import { DurableObject } from "cloudflare:workers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { releaseComputer, reserveComputer } from "../../../../src/core/computer-limit.ts";
import { AttestationError, awsCaller, checkAwsAttestation } from "../../../../shared/job-host-attest.ts";
import { CACHED_REPORT_MAX, Frames, frames, fromBase64, toBase64, type HostMessage, type WireFile, type WireJob, type WireResult, type WireStream } from "../../../../shared/job-host-protocol.ts";
import { guardAlarms } from "../alarm-guard.ts";
import { ComputerMeter } from "../computers/meter.ts";
import { meterBilling } from "../computers/meter-billing.ts";
import type { KeyEnv } from "../security-services.ts";
import { keyServices } from "../security-services.ts";
import { transaction, withSql } from "../postgres.ts";
import type { WebhookEnv } from "../webhooks.ts";
import { volumeFiles, type VolumeSyncEnv } from "./camel-sync.ts";
import { jobLifetimeMs, jobPath, jobSpec, JOB_LIMITS, type JobResult, type JobSpec, type JobStream } from "./job.ts";
import { checkComplete, checkPart, hostSnapshotPlan, HostSnapshotStore, snapshotPartBytes, snapshotResult, snapshotTtlMs, snapshotWire, type HostSnapshotEnv } from "./host-snapshots.ts";
import { HostSyncStore } from "./host-sync-store.ts";
import { jobObjectName } from "./driver.ts";
import { buildSandboxShape, HOST_POOL_PRICES, HOST_POOLS, hostInstance, hostPool, hostRoles, hostSecondRate, hostSessionCost, hostShape, chargedSpan, type HostPool, type HostPriceEnv, type HostShape } from "./host-pricing.ts";

/** The provider our hosts' time is recorded under (usage rows, receipts), with the job's shape as its model. */
export const HOSTS_PROVIDER = "camelrun-hosts";
/** A host not heard from in this long takes no new job. */
const HOST_STALE_MS = 30_000;
/** A waiting job not heard from in this long has stopped waiting (its object was evicted, say). */
const WAITER_STALE_MS = 20_000;
/** A host not heard from in this long is forgotten (demand prunes it). */
const HOST_FORGET_MS = 24 * 3600_000;
/** A placement this recent counts though the host's heartbeat does not list it yet (it was in flight). */
const PLACEMENT_GRACE_MS = 60_000;
/** How long a job waits for a host of its pool (a cold pool's host boots in a few minutes), at most; JOB_HOST_WAIT_SECONDS. */
export const HOST_WAIT_MS = 10 * 60_000;
/**
 * Inline files and a volume's files cross to the host inline, up to this much (raw). They cross DO RPC as base64 first
 * (dispatch), which carries at most 32 MiB: 16 MiB raw is about 21 MiB there, with room for the rest of the job. A
 * larger tree waits for host-side sync.
 */
export const HOST_SYNC_BYTES = 16 * 1024 * 1024;
/** A socket that has not sent a valid credential by then is closed. */
const AUTH_DEADLINE_MS = 10_000;
/** How long a host's credential lasts; the host enrolls again before then, and its socket closes at the end. */
export const HOST_CREDENTIAL_MS = 60 * 60_000;
/** A signed STS request is accepted once, and remembered this long (past its own validity). */
const ATTESTATION_MEMORY_MS = 20 * 60_000;
export const HOST_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export type JobHostsEnv = KeyEnv & WebhookEnv & VolumeSyncEnv & HostPriceEnv & HostSnapshotEnv & {
  /** Which attestors enroll hosts: "aws" (needs JOB_HOST_ROLE_ARNS), "test" (needs TEST_MODE and JOB_HOST_TEST_SECRET). */
  JOB_HOST_ATTESTORS?: string;
  /**
   * Comma-separated IAM role ARNs a host's instance role must be (aws attestor). The host id is the role session name,
   * which whoever assumes the role chooses: EC2 sets it to the instance id, but anyone else allowed to assume the role
   * could name any instance and take its jobs. So each role here MUST trust only `ec2.amazonaws.com` (no user, role or
   * account may hold sts:AssumeRole on it, and it must not trust itself). Slice 7's Terraform enforces this.
   */
  JOB_HOST_ROLE_ARNS?: string;
  /** How long a job waits for a host of its pool before it fails start_failed (seconds; HOST_WAIT_MS by default). */
  JOB_HOST_WAIT_SECONDS?: string;
  /** The scaler's credential (infra/job-hosts/scaler): it reads demand and drains hosts, nothing else. */
  JOB_HOST_SCALER_TOKEN?: string;
  /** Host-side sync fetches per client address (a Cloudflare rate limiting binding; generous). Unset, not limited. */
  JOB_HOST_SYNC_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Enrollments per client address (a Cloudflare rate limiting binding). The aws attestor refuses to run without it outside TEST_MODE. */
  JOB_HOST_ENROLL_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  AGENT_PUBLIC_URL?: string;
  JOB_HOST_TEST_SECRET?: string;
  /** TEST_MODE only: a credential's lifetime in seconds (to test its expiry), and where STS requests go (a fake). */
  JOB_HOST_CREDENTIAL_SECONDS?: string;
  JOB_HOST_STS_TEST_URL?: string;
  JOB_HOSTS?: DurableObjectNamespace<JobHost>;
  HOST_JOBS?: DurableObjectNamespace<HostJob>;
  JOB_HOST_REGISTRY?: DurableObjectNamespace<JobHostRegistry>;
  TEST_MODE?: string;
};
/** The message prefix a revoked host's refusal carries across Durable Object RPC. */
const HOST_REVOKED = "HOST_REVOKED";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const sameText = (a: string, b: string) => { const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b); return x.length === y.length && timingSafeEqual(x, y); };

/** The hosts, their capacity, their credentials and who is revoked. One object, named "hosts". */
export class JobHostRegistry extends DurableObject<JobHostsEnv> {
  constructor(ctx: DurableObjectState, env: JobHostsEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS hosts (name TEXT PRIMARY KEY, slots INTEGER NOT NULL, free INTEGER NOT NULL, seen_at INTEGER NOT NULL)");
    const columns = sql.exec<{ name: string }>("PRAGMA table_info(hosts)").toArray().map(column => column.name);
    if (!columns.includes("revoked")) sql.exec("ALTER TABLE hosts ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0");
    // A host's pool (host-pricing.ts), as it says in its hello; a host from before pools is a test host.
    if (!columns.includes("pool")) sql.exec("ALTER TABLE hosts ADD COLUMN pool TEXT NOT NULL DEFAULT 'test'");
    // Memory its running VMs hold (MiB): placement packs a host to its pool's sandbox memory, never past it.
    if (!columns.includes("used_mib")) sql.exec("ALTER TABLE hosts ADD COLUMN used_mib INTEGER NOT NULL DEFAULT 0");
    // Draining (the scaler is about to end it): it takes no new job. Idle since: when it last had every slot free.
    if (!columns.includes("draining")) sql.exec("ALTER TABLE hosts ADD COLUMN draining INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("idle_since")) sql.exec("ALTER TABLE hosts ADD COLUMN idle_since INTEGER");
    // Jobs waiting for a host of their pool, oldest first; a waiter not heard from in WAITER_STALE_MS has gone.
    sql.exec("CREATE TABLE IF NOT EXISTS waiting (job TEXT PRIMARY KEY, pool TEXT NOT NULL, since INTEGER NOT NULL, seen_at INTEGER NOT NULL)");
    // Each placed job's memory, so a host's used_mib is reconciled from the jobs its heartbeat says it runs.
    if (!sql.exec<{ name: string }>("PRAGMA table_info(waiting)").toArray().some(column => column.name === "mib")) sql.exec("ALTER TABLE waiting ADD COLUMN mib INTEGER NOT NULL DEFAULT 0");
    sql.exec("CREATE TABLE IF NOT EXISTS placements (job TEXT PRIMARY KEY, host TEXT NOT NULL, mib INTEGER NOT NULL, at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS host_credentials (hash TEXT PRIMARY KEY, host TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS host_attestations (signature TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS host_attestations_at ON host_attestations (at)");
    sql.exec("CREATE INDEX IF NOT EXISTS host_credentials_expires ON host_credentials (expires_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS host_credentials_host ON host_credentials (host, expires_at)");
    if (!sql.exec<{ name: string }>("PRAGMA table_info(host_credentials)").toArray().some(column => column.name === "pool")) sql.exec("ALTER TABLE host_credentials ADD COLUMN pool TEXT");
    // Every saved host snapshot (host-snapshots.ts): what superseding and the expiry sweep (alarm) go by.
    sql.exec(`CREATE TABLE IF NOT EXISTS host_snapshot_records (key TEXT PRIMARY KEY, tenant TEXT NOT NULL, payer TEXT NOT NULL, name TEXT NOT NULL,
      size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`);
    sql.exec("CREATE INDEX IF NOT EXISTS host_snapshot_records_name ON host_snapshot_records (payer, name)");
    sql.exec("CREATE INDEX IF NOT EXISTS host_snapshot_records_expiry ON host_snapshot_records (expires_at)");
    guardAlarms(this, ctx, "JobHostRegistry", { test: env.TEST_MODE === "1" });
    // The snapshots each host holds (its cache, as its last hello or heartbeat said): placement prefers a holder.
    sql.exec("CREATE TABLE IF NOT EXISTS host_snapshots (host TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY (host, snapshot))");
    sql.exec("CREATE INDEX IF NOT EXISTS host_snapshots_snapshot ON host_snapshots (snapshot)");
  }
  private revoked(name: string) { return !!this.ctx.storage.sql.exec<{ revoked: number }>("SELECT revoked FROM hosts WHERE name = ?", name).toArray()[0]?.revoked; }

  /**
   * Claim a signed STS request, once: false when it was claimed already (a replay). Claimed before STS is asked, so two
   * concurrent replays cannot both pass; given back (`unclaim`) when STS refuses it, so a forged request leaves nothing.
   */
  claim(signature: string): boolean {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM host_attestations WHERE at <= ?", Date.now() - ATTESTATION_MEMORY_MS);
    if (sql.exec("SELECT 1 FROM host_attestations WHERE signature = ?", signature).toArray().length) return false;
    sql.exec("INSERT INTO host_attestations (signature, at) VALUES (?, ?)", signature, Date.now());
    return true;
  }
  unclaim(signature: string) { this.ctx.storage.sql.exec("DELETE FROM host_attestations WHERE signature = ?", signature); }

  /**
   * A credential for `host`, which an attestor proved (enrollHost, in the Worker). A host keeps at most its two newest
   * credentials (the one it uses, and the next while it renews); older ones stop working.
   */
  issue(host: string, pool: HostPool): { ok: true; host: string; credential: string; expiresAt: number } | { ok: false; code: string; error: string } {
    if (!HOST_NAME.test(host)) return { ok: false, code: "INVALID_HOST", error: "Invalid host id" };
    if (this.revoked(host)) return { ok: false, code: "HOST_REVOKED", error: "This host is revoked" };
    const sql = this.ctx.storage.sql;
    const lifetime = this.env.TEST_MODE === "1" && Number(this.env.JOB_HOST_CREDENTIAL_SECONDS) >= 1 ? Number(this.env.JOB_HOST_CREDENTIAL_SECONDS) * 1000 : HOST_CREDENTIAL_MS;
    const credential = `${host}.${randomBytes(32).toString("base64url")}`, expiresAt = Date.now() + lifetime;
    sql.exec("DELETE FROM host_credentials WHERE expires_at <= ?", Date.now());
    sql.exec("INSERT INTO host_credentials (hash, host, expires_at, pool) VALUES (?, ?, ?, ?)", digest(credential), host, expiresAt, pool);
    sql.exec("DELETE FROM host_credentials WHERE host = ? AND hash NOT IN (SELECT hash FROM host_credentials WHERE host = ? ORDER BY expires_at DESC LIMIT 2)", host, host);
    return { ok: true, host, credential, expiresAt };
  }

  /** A credential, checked for `name`: its host, not expired, the host not revoked. */
  verify(name: string, credential: unknown): { ok: true; expiresAt: number; pool: HostPool } | { ok: false } {
    if (typeof credential !== "string" || !credential.startsWith(`${name}.`)) return { ok: false };
    const row = this.ctx.storage.sql.exec<{ host: string; expires_at: number; pool: string | null }>("SELECT host, expires_at, pool FROM host_credentials WHERE hash = ?", digest(credential)).toArray()[0];
    if (!row || row.host !== name || row.expires_at <= Date.now() || this.revoked(name)) return { ok: false };
    // A credential issued before pools (no pool) is a test host's: it renews within the hour into one that says.
    return { ok: true, expiresAt: row.expires_at, pool: row.pool === "build" ? "build" : "test" };
  }

  /** Revoke a host: its credentials go, it takes no job, and its socket is closed (JobHost.revoke). `allow` undoes it. */
  async revoke(name: string) {
    this.ctx.storage.sql.exec("INSERT INTO hosts (name, slots, free, seen_at, revoked) VALUES (?, 0, 0, 0, 1) ON CONFLICT(name) DO UPDATE SET revoked = 1, free = 0", name);
    this.ctx.storage.sql.exec("DELETE FROM host_credentials WHERE host = ?", name);
    await this.env.JOB_HOSTS?.getByName(name).revoke();
    return { revoked: name };
  }
  allow(name: string) { this.ctx.storage.sql.exec("UPDATE hosts SET revoked = 0, draining = 0 WHERE name = ?", name); return { allowed: name }; }

  /**
   * A host's hello (slots, vCPUs, memory) or heartbeat (free slots alone). `pool` is its credential's, which the attested
   * role decides (enrollHost), never the host's own word. A build host runs one job: one that says otherwise is refused.
   */
  seen(name: string, slots: number | undefined, free: number, pool?: HostPool, machine?: { vcpus?: unknown; memoryMiB?: unknown }, running?: unknown, cached?: unknown) {
    // A code in the message: an error's class does not survive Durable Object RPC (JobHost matches on it).
    if (this.revoked(name)) throw new Error(`${HOST_REVOKED}: this host is revoked`);
    // What a host reports is checked: whole numbers, free within its slots (a host cannot claim more than it has).
    const whole = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1024;
    if (!whole(free) || (slots !== undefined && (!whole(slots) || free > slots))) throw new Error("Invalid host capacity");
    if (pool !== undefined && !HOST_POOLS.includes(pool)) throw new Error("Invalid host pool");
    if (pool === "build" && slots !== undefined && slots !== 1) throw new Error("Invalid host capacity: a build host runs one job");
    if (machine && slots !== undefined) {
      // What a host says it has, checked against its pool's host. Not refused: the memory a host reports may be what is
      // left after its sandboxes' reserved pool, unverified on a real host yet. Placement packs it by its pool's shape
      // (HOST_POOL_PRICES), not by this.
      const size = HOST_POOL_PRICES[pool ?? "test"];
      if (Number(machine.vcpus) < size.vcpus) console.warn(JSON.stringify({ type: "jobhost_smaller_than_pool", host: name, pool: pool ?? "test", vcpus: Number(machine.vcpus) || null, memoryMiB: Number(machine.memoryMiB) || null }));
    }
    if (slots === undefined) {
      const known = this.ctx.storage.sql.exec<{ slots: number }>("SELECT slots FROM hosts WHERE name = ?", name).toArray()[0];
      if (!known || free > known.slots) throw new Error("Invalid host capacity");
    }
    // Its slots and pool as it says (its pool is its credential's); what it runs is the registry's own count, below.
    this.ctx.storage.sql.exec(`INSERT INTO hosts (name, slots, free, seen_at, pool) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET slots = COALESCE(?, slots), seen_at = excluded.seen_at, pool = COALESCE(?, pool)`,
      name, slots ?? free, slots ?? free, Date.now(), pool ?? "test", slots ?? null, pool ?? null);
    if (Array.isArray(running) && running.length <= 1024 && running.every(id => typeof id === "string")) {
      // The jobs it runs are its placed jobs that it lists (or were placed too recently to show up in a heartbeat), and
      // any it lists that no placement knows (from before the registry forgot them; their memory unknown): a job
      // object that died before it released its placement stops counting.
      const sql = this.ctx.storage.sql, now = Date.now(), ids = JSON.stringify(running);
      sql.exec("DELETE FROM placements WHERE host = ? AND at <= ? AND job NOT IN (SELECT value FROM json_each(?))", name, now - PLACEMENT_GRACE_MS, ids);
      sql.exec("INSERT OR IGNORE INTO placements (job, host, mib, at) SELECT value, ?, 0, ? FROM json_each(?)", name, now, ids);
    }
    // What it holds, replaced whole by each report that says (a host from before snapshots says nothing, and holds none).
    if (cached !== undefined) {
      if (!Array.isArray(cached) || cached.length > CACHED_REPORT_MAX || !cached.every(id => typeof id === "string" && id.length <= 256)) throw new Error("Invalid host snapshot list");
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM host_snapshots WHERE host = ?", name);
      sql.exec("INSERT OR IGNORE INTO host_snapshots (host, snapshot) SELECT ?, value FROM json_each(?)", name, JSON.stringify(cached));
    }
    this.recount(name);
  }
  /**
   * A host's free slots and used memory, from its placements alone (the one source: place and release add and drop
   * them, a heartbeat reconciles them), so neither a heartbeat nor a release can count a job twice or undo a placement.
   */
  private recount(name: string) {
    this.ctx.storage.sql.exec(`UPDATE hosts SET
        free = MAX(0, slots - (SELECT COUNT(*) FROM placements WHERE host = ?)),
        used_mib = (SELECT COALESCE(SUM(mib), 0) FROM placements WHERE host = ?)
      WHERE name = ?`, name, name, name);
    this.ctx.storage.sql.exec("UPDATE hosts SET idle_since = CASE WHEN free < slots THEN NULL ELSE COALESCE(idle_since, ?) END WHERE name = ?", Date.now(), name);
  }
  /** The job is about to be sent: its placement counts though no heartbeat lists it yet (a slow start does not drop it). */
  touch(job: string) { this.ctx.storage.sql.exec("UPDATE placements SET at = ? WHERE job = ?", Date.now(), job); }
  /**
   * A fresh, allowed, undrained host of `pool` with a free slot and room for `memoryMiB` within its pool's sandbox
   * memory, which are taken; undefined: none. A VM that would not fit is never sent to boot (and charged for a failed
   * boot). Among those, one that holds `snapshot` (the job starts from it) first: it skips the download.
   */
  place(pool: HostPool, memoryMiB: number, job: string, snapshot?: string): string | undefined {
    const room = HOST_POOL_PRICES[pool].memoryGiB * 1024 - memoryMiB;
    if (room < 0) return undefined;
    const row = this.ctx.storage.sql.exec<{ name: string }>(`SELECT name FROM hosts WHERE seen_at > ? AND free > 0 AND revoked = 0 AND draining = 0 AND pool = ? AND used_mib <= ?
      ORDER BY EXISTS (SELECT 1 FROM host_snapshots WHERE host_snapshots.host = hosts.name AND host_snapshots.snapshot = ?) DESC, free DESC, name LIMIT 1`,
      Date.now() - HOST_STALE_MS, pool, room, snapshot ?? null).toArray()[0];
    if (!row) return undefined;
    // A job placed again (a run made again) moves: its old host is recounted without it.
    const before = this.ctx.storage.sql.exec<{ host: string }>("SELECT host FROM placements WHERE job = ?", job).toArray()[0]?.host;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO placements (job, host, mib, at) VALUES (?, ?, ?, ?)", job, row.name, memoryMiB, Date.now());
    if (before && before !== row.name) this.recount(before);
    this.recount(row.name);
    return row.name;
  }
  /**
   * A job's turn at a host (HostJob, while it waits): a host when one is free and no job of its pool has waited longer,
   * else undefined, and the job counts as waiting (the demand the scaler reads) until it calls again or gives up.
   */
  want(job: string, pool: HostPool, memoryMiB = 0, snapshot?: string): string | undefined {
    const sql = this.ctx.storage.sql, now = Date.now();
    sql.exec("DELETE FROM waiting WHERE seen_at <= ?", now - WAITER_STALE_MS);
    sql.exec("INSERT INTO waiting (job, pool, since, seen_at, mib) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job) DO UPDATE SET seen_at = excluded.seen_at, mib = excluded.mib", job, pool, now, now, memoryMiB);
    // In turn: the oldest waiter that fits a live host now. One too big for any host's room at the moment (it waits for
    // a host to empty, or a new one) does not hold back smaller jobs that fit.
    const room = sql.exec<{ room: number | null }>("SELECT MAX(? - used_mib) AS room FROM hosts WHERE seen_at > ? AND free > 0 AND revoked = 0 AND draining = 0 AND pool = ?",
      HOST_POOL_PRICES[pool].memoryGiB * 1024, now - HOST_STALE_MS, pool).one().room;
    if (room === null) return undefined;
    const first = sql.exec<{ job: string }>("SELECT job FROM waiting WHERE pool = ? AND mib <= ? ORDER BY since, job LIMIT 1", pool, room).toArray()[0];
    if (first?.job !== job) return undefined;
    const host = this.place(pool, memoryMiB, job, snapshot);
    if (host) sql.exec("DELETE FROM waiting WHERE job = ?", job);
    return host;
  }
  /** A waiting job that stopped waiting (it gave up, or was stopped). */
  unwant(job: string) { this.ctx.storage.sql.exec("DELETE FROM waiting WHERE job = ?", job); }
  release(name: string, _memoryMiB: number, job: string) {
    this.ctx.storage.sql.exec("DELETE FROM placements WHERE job = ? AND host = ?", job, name);
    this.recount(name);
  }
  /**
   * A host snapshot saved (HostJob, once its upload completed): recorded, and the payer's earlier snapshot of the same
   * name deleted (superseded), its R2 object first. The sweep is armed for the soonest expiry.
   */
  async snapshotSaved(record: { key: string; tenant: string; payer: string; name: string; size: number; sha256: string; createdAt: number; expiresAt: number }) {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT OR REPLACE INTO host_snapshot_records (key, tenant, payer, name, size, sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      record.key, record.tenant, record.payer, record.name, record.size, record.sha256, record.createdAt, record.expiresAt);
    const superseded = sql.exec<{ key: string }>("SELECT key FROM host_snapshot_records WHERE payer = ? AND name = ? AND key != ?", record.payer, record.name, record.key).toArray().map(row => row.key);
    if (superseded.length) await this.deleteSnapshots(superseded, "superseded");
    await this.armSweep();
    return { superseded };
  }
  /** A snapshot's record, while it lasts: what a job starting from it checks its handle against. */
  snapshotRecord(key: string) {
    const row = this.ctx.storage.sql.exec<{ size: number; sha256: string; expires_at: number }>("SELECT size, sha256, expires_at FROM host_snapshot_records WHERE key = ?", key).toArray()[0];
    return row && row.expires_at > Date.now() ? { size: Number(row.size), sha256: row.sha256, expiresAt: Number(row.expires_at) } : undefined;
  }
  /** R2 objects first, then their records: a delete that fails leaves the record for the next sweep. */
  private async deleteSnapshots(keys: string[], why: "superseded" | "expired") {
    if (!this.env.BUCKET) return;
    await this.env.BUCKET.delete(keys);
    for (const key of keys) this.ctx.storage.sql.exec("DELETE FROM host_snapshot_records WHERE key = ?", key);
    console.log(JSON.stringify({ type: "host_snapshots_deleted", why, count: keys.length }));
  }
  private async armSweep() {
    const next = this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM host_snapshot_records").one().at;
    const current = await this.ctx.storage.getAlarm();
    if (next !== null && (current === null || Number(next) < current)) await this.ctx.storage.setAlarm(Number(next));
  }
  /** The expiry sweep: snapshots past their handle's expiry are deleted, a bounded batch a time, then the next one armed. */
  async alarm() {
    const expired = this.ctx.storage.sql.exec<{ key: string }>("SELECT key FROM host_snapshot_records WHERE expires_at <= ? ORDER BY expires_at LIMIT 1000", Date.now()).toArray().map(row => row.key);
    try { if (expired.length) await this.deleteSnapshots(expired, "expired"); }
    catch (error) {
      // R2 refused: tried again in a minute, the records kept.
      console.error(JSON.stringify({ type: "host_snapshot_sweep_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    const next = this.ctx.storage.sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM host_snapshot_records").one().at;
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(Number(next), Date.now() + 1_000));
  }
  list() { return this.ctx.storage.sql.exec("SELECT name, pool, slots, free, seen_at AS seenAt, revoked, draining, idle_since AS idleSince FROM hosts ORDER BY name").toArray(); }
  /** Drain a host (the scaler, before it ends it): no new job is placed on it. Undefined: no such host. */
  drain(name: string) {
    const changed = this.ctx.storage.sql.exec("UPDATE hosts SET draining = 1 WHERE name = ?", name).rowsWritten;
    return changed ? { draining: name } : undefined;
  }
  /** Undrain it (jobs wait again, or an operator's `allow`): it takes jobs again. */
  undrain(name: string) {
    const changed = this.ctx.storage.sql.exec("UPDATE hosts SET draining = 0 WHERE name = ?", name).rowsWritten;
    return changed ? { draining: false, host: name } : undefined;
  }

  /**
   * What the scaler sizes the pools by (infra/job-hosts/scaler): per pool, its live hosts and slots, the jobs running
   * and waiting (and how long the oldest has), and each live host's state: busy, idle since when, draining. A host is
   * its EC2 instance id (job-host-attest.ts), which is how the scaler finds it in its group.
   */
  demand() {
    const sql = this.ctx.storage.sql, now = Date.now();
    sql.exec("DELETE FROM waiting WHERE seen_at <= ?", now - WAITER_STALE_MS);
    // Hosts not heard from in a day are forgotten (their instances are long gone); a revoked one stays revoked.
    sql.exec("DELETE FROM hosts WHERE seen_at < ? AND revoked = 0", now - HOST_FORGET_MS);
    sql.exec("DELETE FROM host_snapshots WHERE host NOT IN (SELECT name FROM hosts)");
    // Every host it knows, with when it was last heard from: the scaler ends a terminating host's hook only once it has
    // been gone a while, not on one missed heartbeat. Capacity counts only the live ones.
    const known = sql.exec<{ name: string; pool: string; slots: number; free: number; draining: number; idle_since: number | null; seen_at: number; used_mib: number }>(
      "SELECT name, pool, slots, free, draining, idle_since, seen_at, used_mib FROM hosts WHERE revoked = 0 ORDER BY name").toArray();
    const hosts = known.filter(host => host.seen_at > now - HOST_STALE_MS);
    return {
      at: now,
      pools: Object.fromEntries(HOST_POOLS.map(pool => {
        const mine = hosts.filter(host => host.pool === pool), memoryMiB = HOST_POOL_PRICES[pool].memoryGiB * 1024;
        const waiting = sql.exec<{ n: number; oldest: number | null; mib: number | null }>("SELECT count(*) AS n, MIN(since) AS oldest, SUM(mib) AS mib FROM waiting WHERE pool = ?", pool).one();
        return [pool, {
          // Memory as placement counts it: each host's sandbox memory, and what is left of it.
          memoryMiB,
          hosts: mine.map(host => ({ host: host.name, slots: host.slots, running: host.slots - host.free, draining: !!host.draining, idleSince: host.idle_since, lastSeenAt: host.seen_at,
            freeMiB: Math.max(0, memoryMiB - host.used_mib) })),
          gone: known.filter(host => host.pool === pool && host.seen_at <= now - HOST_STALE_MS).map(host => ({ host: host.name, lastSeenAt: host.seen_at })),
          slots: mine.filter(host => !host.draining).reduce((sum, host) => sum + host.slots, 0),
          running: mine.reduce((sum, host) => sum + host.slots - host.free, 0),
          waiting: Number(waiting.n), waitingMiB: Number(waiting.mib ?? 0), oldestWaitMs: waiting.oldest === null ? 0 : now - Number(waiting.oldest),
        }];
      })),
    };
  }
}

const registry = (env: JobHostsEnv) => env.JOB_HOST_REGISTRY!.getByName("hosts");

/** What a host's attestation must be signed for: this runtime, by its public URL (the aws attestor needs one). */
export function jobHostAudience(env: { AGENT_PUBLIC_URL?: string }) {
  return env.AGENT_PUBLIC_URL ? `camelrun-job-host:${env.AGENT_PUBLIC_URL.replace(/\/+$/, "")}` : undefined;
}

/** A real attestation is about 1-2 KB; a body larger than this is refused unread. */
const ENROLL_BODY_BYTES = 16 * 1024;

/**
 * POST /v1/internal/job-hosts/enroll, unauthenticated: an attestation in, a credential for the host it proves out. The
 * attestor's work (the shape checks, STS) runs here in the Worker; the registry only claims the signed request (once)
 * and issues the credential, so a flood of forged requests never holds the one registry object. The caller learns only
 * a fixed refusal; why is logged.
 */
export async function enrollHost(request: Request, env: JobHostsEnv): Promise<Response> {
  const refuse = (status = 403) => Response.json({ error: "Enrollment refused", code: "HOST_REFUSED" }, { status });
  const log = (kind: unknown, reason: string) => console.error(JSON.stringify({ type: "jobhost_enroll_refused", kind: typeof kind === "string" ? kind.slice(0, 16) : null, reason: reason.slice(0, 200) }));
  if (env.JOB_HOST_ENROLL_LIMITER) {
    const address = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!(await env.JOB_HOST_ENROLL_LIMITER.limit({ key: address })).success) return Response.json({ error: "Too many enrollments", code: "RATE_LIMITED" }, { status: 429 });
  }
  if (Number(request.headers.get("content-length") ?? NaN) > ENROLL_BODY_BYTES) return refuse(413);
  // Read with a bound: a body sent without Content-Length (chunked) stops at the cap too, never buffered whole.
  let input: { attestation?: Record<string, unknown> } | undefined;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = request.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ENROLL_BODY_BYTES) { await reader.cancel().catch(() => {}); return refuse(413); }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    input = JSON.parse(new TextDecoder().decode(body));
  } catch { return refuse(400); }
  const attestation = input?.attestation, kind = attestation?.kind;
  const attestors = (env.JOB_HOST_ATTESTORS ?? "").split(",").map(name => name.trim()).filter(Boolean);
  const hosts = registry(env);
  let host: string, pool: HostPool;
  try {
    if (kind === "aws" && attestors.includes("aws")) {
      const roles = hostRoles(env.JOB_HOST_ROLE_ARNS), audience = jobHostAudience(env);
      // Fail closed without its allowlist, its audience, or (outside tests) the enrollment rate limit.
      if (!roles || !audience) throw new AttestationError("The aws attestor needs JOB_HOST_ROLE_ARNS (pool=arn entries) and AGENT_PUBLIC_URL");
      if (!env.JOB_HOST_ENROLL_LIMITER && env.TEST_MODE !== "1") throw new AttestationError("The aws attestor needs JOB_HOST_ENROLL_LIMITER");
      const checked = checkAwsAttestation(attestation as never, audience);
      if (!await hosts.claim(checked.signature)) throw new AttestationError("This attestation was used already");
      try {
        // Tests send the checked request to a fake STS; anywhere else it goes to the STS endpoint it was signed for.
        const target = env.TEST_MODE === "1" && env.JOB_HOST_STS_TEST_URL ? env.JOB_HOST_STS_TEST_URL : checked.url;
        const response = await fetch(target, { method: "POST", headers: checked.headers, body: checked.body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
        if (response.status !== 200) throw new AttestationError(`STS answered ${response.status}`);
        const caller = awsCaller(await response.text(), roles.map(entry => entry.arn));
        // The pool is the attested role's (each pool has its own role), never what the host says.
        host = caller.host; pool = roles.find(entry => entry.arn === caller.allowed)!.pool;
      } catch (error) {
        // STS refused it (or could not be asked): the claim goes, so a forged request leaves nothing behind.
        await hosts.unclaim(checked.signature);
        throw error;
      }
    } else if (kind === "test" && attestors.includes("test") && env.TEST_MODE === "1" && env.JOB_HOST_TEST_SECRET) {
      if (typeof attestation?.secret !== "string" || !sameText(attestation.secret, env.JOB_HOST_TEST_SECRET)) throw new AttestationError("Wrong test secret");
      host = String(attestation.host);
      pool = attestation?.pool === "build" ? "build" : "test";
    } else throw new AttestationError("No attestor here takes this attestation");
  } catch (error) {
    log(kind, error instanceof AttestationError ? error.message : `attestation failed: ${error instanceof Error ? error.name : "unknown"}`);
    return refuse();
  }
  try {
    const issued = await hosts.issue(host, pool);
    if (!issued.ok) { log(kind, issued.error); return refuse(); }
    return Response.json({ host: issued.host, credential: issued.credential, expiresAt: issued.expiresAt });
  } catch (error) {
    console.error(JSON.stringify({ type: "jobhost_enroll_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    return Response.json({ error: "Enrollment failed", code: "UNAVAILABLE" }, { status: 503 });
  }
}

/**
 * The scaler's routes (infra/job-hosts/scaler), with its own credential (JOB_HOST_SCALER_TOKEN, a bearer token checked
 * in constant time): GET /v1/internal/job-hosts/demand reads what each pool needs, POST
 * /v1/internal/job-hosts/<host>/drain stops placing jobs on a host it is about to end, and DELETE on it undoes that (a
 * drain is never one-way: the scaler undrains when jobs wait, an operator's allow does too). Nothing else: it reads no job,
 * payer or secret. Without the token configured, these paths are unknown.
 */
export async function scalerRoutes(request: Request, env: JobHostsEnv): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const match = /^\/v1\/internal\/job-hosts\/(?:demand|([^/]+)\/drain)$/.exec(path);
  if (!match || !env.JOB_HOST_SCALER_TOKEN || !env.JOB_HOST_REGISTRY) return undefined;
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (env.JOB_HOST_SCALER_TOKEN.length < 32) {
    // A misconfiguration, refused closed, and said so (the scaler only sees 401s).
    console.error(JSON.stringify({ type: "jobhost_scaler_token_too_short" }));
    return Response.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!sameText(given, env.JOB_HOST_SCALER_TOKEN)) return Response.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  const hosts = registry(env);
  if (!match[1] && request.method === "GET") return Response.json(await hosts.demand());
  if (match[1] && (request.method === "POST" || request.method === "DELETE")) {
    let host = "";
    try { host = decodeURIComponent(match[1]); } catch { /* a malformed escape: refused below */ }
    if (!HOST_NAME.test(host)) return Response.json({ error: "Invalid host id", code: "INVALID_REQUEST" }, { status: 400 });
    const done = request.method === "POST" ? await hosts.drain(host) : await hosts.undrain(host);
    return done ? Response.json(done) : Response.json({ error: "Unknown host", code: "NOT_FOUND" }, { status: 404 });
  }
  return Response.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
}

/**
 * The operators' routes (an admin account, ADMIN_TENANTS, with a full-scope key): GET /v1/job-hosts lists the hosts,
 * DELETE /v1/job-hosts/:host revokes one (its credentials, its socket, its jobs in flight), POST
 * /v1/job-hosts/:host/allow lets a revoked host enroll again.
 */
export async function jobHostRoutes(request: Request, env: JobHostsEnv & { ADMIN_TENANTS?: string }, auth: { tenantId: string; scopes: string[] }): Promise<Response | undefined> {
  const match = /^\/v1\/job-hosts(?:\/([^/]+)(\/allow)?)?$/.exec(new URL(request.url).pathname);
  if (!match || !env.JOB_HOST_REGISTRY) return undefined;
  const admins = (env.ADMIN_TENANTS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!admins.includes(auth.tenantId) || !auth.scopes.includes("*")) return Response.json({ error: "Admin account required", code: "FORBIDDEN" }, { status: 403 });
  const [, raw, allow] = match, hosts = registry(env);
  let host: string | undefined;
  try { host = raw === undefined ? undefined : decodeURIComponent(raw); } catch { host = ""; }
  if (host !== undefined && !HOST_NAME.test(host)) return Response.json({ error: "Invalid host id", code: "INVALID_REQUEST" }, { status: 400 });
  if (!host && request.method === "GET") return Response.json({ hosts: await hosts.list() });
  if (host && !allow && request.method === "DELETE") return Response.json(await hosts.revoke(host));
  if (host && allow && request.method === "POST") return Response.json(await hosts.allow(host));
  return Response.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
}

/**
 * A job's snapshot routes, for its host (host-snapshots.ts), on the stateless Worker: the job's object checks the token
 * and says which key it may read or write, and the bytes go between the host and R2 here, never through that object.
 * - GET /v1/internal/job-hosts/snapshots/<job>: the snapshot the job starts from, R2's body passed straight through;
 * - PUT …/<job>/parts/<n>: one part (its Content-Length at most the job's part size) straight into the R2 upload;
 * - POST …/<job>/complete: `{ size, sha256 }`, the upload completed and recorded.
 * Every answer is no-store. Limited per client address with JOB_HOST_SYNC_LIMITER where it is bound.
 */
export async function snapshotRoutes(request: Request, env: JobHostsEnv, job: string, rest: string): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  const refuse = (status: number, error: string) => Response.json({ error }, { status, headers });
  if (env.JOB_HOST_SYNC_LIMITER && !(await env.JOB_HOST_SYNC_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" })).success) return refuse(429, "Too many requests");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(job) || !env.HOST_JOBS || !env.BUCKET) return refuse(404, "Not found");
  const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const object = env.HOST_JOBS.getByName(jobObjectName(job));
  if (rest === "" && request.method === "GET") {
    const source = await object.snapshotSource(token);
    if (!source.ok) return refuse(source.status, source.status === 401 ? "Unauthorized" : "This job starts from no snapshot");
    const stored = await (env.BUCKET as R2Bucket).get(source.key);
    if (!stored) return refuse(404, "The snapshot is gone");
    return new Response(stored.body, { headers: { ...headers, "content-type": "application/gzip", "content-length": String(stored.size) } });
  }
  const part = /^\/parts\/(\d{1,5})$/.exec(rest);
  if (part && request.method === "PUT") {
    const n = Number(part[1]), length = Number(request.headers.get("content-length") ?? NaN);
    const target = await object.snapshotPartTarget(token, n, length);
    if (!target.ok) return refuse(target.status, target.error);
    if (!request.body) return refuse(400, "No body");
    let written: R2UploadedPart;
    try { written = await env.BUCKET.resumeMultipartUpload(target.key, target.uploadId).uploadPart(n, request.body); }
    catch (error) { return refuse(502, `The part was not stored: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`); }
    if (!(await object.snapshotPartWritten(token, n, written.etag, length)).ok) return refuse(409, "The upload ended");
    return Response.json({ part: n, etag: written.etag }, { headers });
  }
  if (rest === "/complete" && request.method === "POST") {
    if (Number(request.headers.get("content-length") ?? 0) > 1024) return refuse(413, "Too large");
    let body: { size?: unknown; sha256?: unknown };
    try { body = await request.json(); } catch { return refuse(400, "A completion is JSON"); }
    try {
      const done = await object.snapshotComplete(token, body?.size, body?.sha256);
      return done.ok ? Response.json({ ok: true }, { headers }) : refuse(done.status, done.error);
    } catch (error) { return refuse(502, `The snapshot was not completed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`); }
  }
  return refuse(404, "Not found");
}

/** One host's connection: jobs out, results in. */
export class JobHost extends DurableObject<JobHostsEnv> {
  private socket?: WebSocket;
  /** The pool its credential says (the attested role's). */
  private pool?: HostPool;
  /** When the host last said anything, and when each job's VM started (the host's `started`): the span a job is charged. */
  private lastSeen = 0;
  private readonly startedAt = new Map<string, number>();
  private gone?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, (result: WireResult) => void>();
  async fetch(request: Request) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const name = new URL(request.url).searchParams.get("host") ?? "";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return new Response("Invalid host name", { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    this.attach(server, name);
    return new Response(null, { status: 101, webSocket: client });
  }
  /** Bumped by each revoke: a credential check that began before it does not attach its socket. */
  private generation = 0;
  private attach(socket: WebSocket, name: string) {
    const assembler = new Frames();
    let state: "new" | "checking" | "authed" = "new";
    const queued: string[] = [];
    const close = (code: number, reason: string) => { try { socket.close(code, reason); } catch { /* closed */ } };
    const deadline = setTimeout(() => { if (state !== "authed") close(1008, "Unauthorized"); }, AUTH_DEADLINE_MS);
    const handle = (text: string) => {
      const message = assembler.add(text) as HostMessage | undefined;
      if (message) void this.receive(name, message).catch(error => {
        // A host that reports nonsense (its capacity, a frame), or is revoked, is cut off.
        console.error(JSON.stringify({ type: "jobhost_message_refused", host: name, error: error instanceof Error ? error.message.slice(0, 100) : "unknown" }));
        const revoked = error instanceof Error && error.message.startsWith(HOST_REVOKED);
        close(revoked ? 1008 : 1007, revoked ? "Revoked" : "Invalid message");
      });
    };
    socket.addEventListener("message", event => {
      try {
        const text = typeof event.data === "string" ? event.data : "";
        if (state === "checking") { if (queued.length < 8) queued.push(text); else close(1008, "Unauthorized"); return; }
        if (state === "new") {
          // The host's first message is its credential, checked by the registry; until then what it sends waits.
          state = "checking";
          const credential = (JSON.parse(text) as { credential?: unknown }).credential;
          // A revoke that lands while the registry checks (after its check, before this) must still win.
          const generation = this.generation;
          void registry(this.env).verify(name, credential).then(checked => {
            if (!checked.ok || generation !== this.generation) { close(1008, checked.ok ? "Revoked" : "Unauthorized"); return; }
            // Closed meanwhile (its auth deadline, or the host went): never the socket jobs go to.
            if (socket.readyState !== WebSocket.OPEN) return;
            state = "authed";
            clearTimeout(deadline);
            // A host that reconnects replaces its old socket; jobs in flight on it keep their pending results.
            if (this.socket && this.socket !== socket) try { this.socket.close(1000, "Replaced"); } catch { /* already closed */ }
            this.socket = socket;
            this.pool = checked.pool;
            this.lastSeen = Date.now();
            if (this.gone) { clearTimeout(this.gone); this.gone = undefined; }
            // The credential's end is the socket's: the host enrolls again and reconnects before then.
            const expiry = setTimeout(() => close(1008, "Credential expired"), Math.max(0, checked.expiresAt - Date.now()));
            socket.addEventListener("close", () => clearTimeout(expiry));
            for (const waiting of queued.splice(0)) handle(waiting);
          }, () => close(1011, "Unavailable"));
          return;
        }
        handle(text);
      } catch (error) {
        console.error(JSON.stringify({ type: "jobhost_message_invalid", host: name, error: error instanceof Error ? error.name : "unknown" }));
        close(1007, "Invalid message");
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      // A host that does not come back within HOST_STALE_MS has gone: its jobs end now, charged until it was last heard
      // from, rather than at their deadline.
      this.gone ??= setTimeout(() => {
        this.gone = undefined;
        if (this.socket) return;
        for (const [id, done] of this.pending) { this.pending.delete(id); done({ ok: false, code: "container_failed", message: "The job host went away" }); }
      }, HOST_STALE_MS);
    });
  }
  /** Revoked: the socket closes, and jobs waiting on this host end failed rather than at their deadline. */
  revoke() {
    this.generation++;
    try { this.socket?.close(1008, "Revoked"); } catch { /* closed */ }
    this.socket = undefined;
    for (const [id, done] of this.pending) { this.pending.delete(id); done({ ok: false, code: "container_failed", message: "The job host was revoked" }); }
  }
  private async receive(name: string, message: HostMessage) {
    this.lastSeen = Date.now();
    if (message.type === "hello") {
      // Its free slots as it reports them: a reconnecting host's jobs in flight keep theirs. Its pool is its credential's.
      await registry(this.env).seen(name, message.slots, message.free, this.pool ?? "test", { vcpus: message.vcpus, memoryMiB: message.memoryMiB }, undefined, message.cached);
      this.send({ type: "registered", host: name });
    } else if (message.type === "heartbeat") await registry(this.env).seen(name, undefined, message.free, this.pool ?? "test", undefined, message.running, message.cached);
    else if (message.type === "started") { if (this.pending.has(message.id)) this.startedAt.set(message.id, Date.now()); }
    else if (message.type === "result") { const done = this.pending.get(message.id); this.pending.delete(message.id); done?.(message.result); }
  }
  private send(message: unknown) {
    if (!this.socket) return false;
    for (const frame of frames(message)) this.socket.send(frame);
    return true;
  }
  /**
   * Run one job on this host and answer its result, with the span its VM ran (`ranFrom` the host's `started`, `ranUntil`
   * its result, or when the host was last heard from if it went away): what the job is charged. No `ranFrom`: its VM
   * never started, and nothing is charged. The socket gone, or the deadline passed, answers a failure.
   */
  async dispatch(id: string, spec: WireJob, deadlineMs: number): Promise<WireResult & { ranFrom?: number; ranUntil?: number }> {
    if (this.cancelled.delete(id)) return { ok: false, code: "stopped", message: "The job was stopped" };
    const result = await new Promise<WireResult>(resolve => {
      // Past its deadline the job is given up: the host is told to stop it (its VM, its slot, any sync still running).
      const timer = setTimeout(() => { this.pending.delete(id); this.send({ type: "cancel", id }); resolve({ ok: false, code: "container_failed", message: "The job host did not answer in time" }); }, deadlineMs);
      this.pending.set(id, result => { clearTimeout(timer); resolve(result); });
      if (!this.send({ type: "job", id, spec })) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, code: "start_failed", message: "The job host is not connected" }); }
    });
    const ranFrom = this.startedAt.get(id);
    this.startedAt.delete(id);
    return { ...result, ...(ranFrom !== undefined ? { ranFrom, ranUntil: Math.max(ranFrom, this.socket ? Date.now() : this.lastSeen) } : {}) };
  }
  /**
   * Stop a job on this host. One not sent yet (its dispatch is on its way here) is remembered, and its dispatch then
   * answers `stopped` without sending it: a cancel that overtakes its job never leaves the job to run.
   */
  cancel(id: string, inFlight = false) {
    if (!this.pending.has(id)) {
      // Remembered only for a job whose dispatch is on its way (its HostJob says so): never for one already answered,
      // whose id a later run may use again.
      if (!inFlight) return false;
      this.cancelled.set(id, Date.now());
      for (const [old, at] of this.cancelled) if (Date.now() - at > 2 * 60_000) this.cancelled.delete(old);
      return true;
    }
    return this.send({ type: "cancel", id });
  }
  private readonly cancelled = new Map<string, number>();
}

const stream = (wire: WireStream): JobStream => ({ bytes: fromBase64(wire.data), size: wire.size, truncated: wire.truncated });

/** One job on a host: admission, a slot, placement, the meter, the result. */
export class HostJob extends DurableObject<JobHostsEnv> {
  private active?: { host: string; id: string; stopped: boolean; sent?: boolean; answered?: boolean };
  constructor(ctx: DurableObjectState, env: JobHostsEnv) {
    super(ctx, env);
    guardAlarms(this, ctx, "HostJob", { test: env.TEST_MODE === "1" });
  }
  private meter(idleMs: number) {
    return new ComputerMeter({ store: this.ctx.storage, billing: meterBilling(this.env, HOSTS_PROVIDER), idleMs, schedule: at => this.ctx.storage.setAlarm(at),
      price: (instance, seconds) => hostSessionCost(instance, seconds, this.env) });
  }
  async run(value: unknown): Promise<JobResult> {
    const spec = jobSpec(value, { beyondContainers: true });
    const at = Date.now();
    const timings = () => ({ startedAt: at, endedAt: Date.now(), startMs: 0, syncMs: 0, commandMs: 0, collectMs: 0, totalMs: Date.now() - at });
    const fail = (code: Extract<JobResult, { ok: false }>["code"], message: string, costUsd?: number): JobResult => ({ ok: false, id: spec.id, code, message, timings: timings(), ...(costUsd !== undefined ? { costUsd } : {}) });
    // Running, or still waiting for a host (a workflow that restarted asks again): the earlier run lands it.
    if (this.active || this.waiting) return fail("job_running", `Job ${spec.id} is running`);
    // Stoppable from here until it is dispatched (this.waiting, kept until this.active is set): it ends `stopped`, its
    // host's slot and its computer slot given back, nothing charged.
    const waiting = this.waiting = { job: spec.id, stopped: false };
    try {
    // Hosts run the workspace image, and start only from their own snapshots (host-snapshots.ts): anything else is
    // refused, never run without it (driver.ts routes those to Cloudflare Containers).
    const snapshots = hostSnapshotPlan(spec, this.env);
    if ("refused" in snapshots) return fail("start_failed", snapshots.refused);
    // The snapshot it starts from must still exist, as its handle says: not superseded, swept or another tenant's.
    if (snapshots.load) {
      const record = await registry(this.env).snapshotRecord(snapshots.load.key);
      if (!record) return fail("start_failed", `Snapshot ${spec.snapshot!.name} no longer exists (a newer save of that name replaced it, it expired, or it is not this tenant's); take a new one`);
      if (record.sha256 !== snapshots.load.sha256 || record.size !== snapshots.load.size) return fail("start_failed", `Snapshot ${spec.snapshot!.name} does not match the snapshot saved under its id`);
    }
    const lifetimeMs = jobLifetimeMs(spec.timeoutSeconds), meter = this.meter(lifetimeMs), machine = `job:${spec.id}`;
    // The VM the host boots is the one priced: its shape (the job's limits, else its instance type's), and the pool that
    // shape goes to. A pricing setting that does not parse refuses the job before anything starts.
    // Its rate is fixed here, once: a setting changed (or broken) while it runs cannot change or strand its charge.
    // A build job gets its host's whole sandbox (it is charged the whole host): the shape its pre-started VM has.
    const asked = hostShape(spec), pool = hostPool(asked), shape = pool === "build" ? buildSandboxShape(asked) : asked;
    let rate: number;
    try { rate = hostSecondRate(pool, shape, this.env); }
    catch (error) { return fail("admission_refused", error instanceof Error ? error.message.slice(0, 500) : "Pricing is misconfigured"); }
    try { await meter.admit(spec.payer); }
    catch (error) { return fail("admission_refused", error instanceof Error ? error.message.slice(0, 500) : "Refused"); }
    if (waiting.stopped) return fail("stopped", "The job was stopped");
    let files: WireFile[], sync: WireJob["sync"];
    try { ({ files, sync } = await this.files(spec)); }
    catch (error) { return fail("sync_failed", error instanceof Error ? error.message.slice(0, 500) : "The job's files could not be read"); }
    if (waiting.stopped) return fail("stopped", "The job was stopped");
    // A host of its pool, in turn: it waits (counted as demand, which the scaler grows the pool by) until one is free.
    const stopped = async (host?: string, slot = false) => {
      if (host) await registry(this.env).release(host, shape.memoryMiB, spec.id).catch(() => {});
      if (slot) await withSql(this.env, sql => releaseComputer(sql, spec.payer.tenant, machine)).catch(() => {});
      this.waiting = undefined;
      return fail("stopped", "The job was stopped");
    };
    const host = await this.waitForHost(waiting, pool, shape.memoryMiB, snapshots.load?.cacheId);
    if (host === "stopped") return stopped();
    if (!host) { this.waiting = undefined; return fail("start_failed", `No ${pool} job host was free within ${Math.round(this.waitMs() / 1000)} s`); }
    if (waiting.stopped) return stopped(host);
    // The computer slot from here: a job waiting for a host holds none.
    try {
      const limit = (await keyServices(this.env)).accounts.tenants.computerLimit(spec.payer.tenant);
      await transaction(this.env, async sql => reserveComputer(sql, spec.payer.tenant, spec.payer.agent, machine, Date.now() + lifetimeMs, Date.now(), await limit));
    } catch (error) {
      await registry(this.env).release(host, shape.memoryMiB, spec.id).catch(() => {});
      this.waiting = undefined;
      return fail("admission_refused", error instanceof Error ? error.message.slice(0, 500) : "Refused");
    }
    if (waiting.stopped) return stopped(host, true);
    const release = () => withSql(this.env, sql => releaseComputer(sql, spec.payer.tenant, machine));
    const active: { host: string; id: string; stopped: boolean; sent?: boolean; answered?: boolean } = this.active = { host, id: spec.id, stopped: false };
    this.waiting = undefined;
    let wire: WireResult & { ranFrom?: number; ranUntil?: number } = { ok: false, code: "container_failed", message: "No result" }, costUsd = 0;
    // A session is open from dispatch, at the rate fixed at admission, under the job's own name (a run made again is the
    // same charge): if this object dies mid-job, its alarm charges it, at most to the job's lifetime. Once the result is
    // in, the session is trimmed to the span its VM ran.
    try { await meter.started(spec.payer, hostInstance(pool, shape), lifetimeMs, 0, `job:${spec.id}`, { rate }); }
    catch (error) {
      await release().catch(() => {});
      await registry(this.env).release(host, shape.memoryMiB, spec.id).catch(() => {});
      this.active = undefined;
      return fail("start_failed", error instanceof Error ? error.message.slice(0, 300) : "The job could not be metered");
    }
    // A stop between taking the host and sending the job: not sent; its slots go back, and it is charged nothing.
    if (active.stopped) {
      await meter.startedAt(Date.now()).then(() => meter.stopped()).catch(() => {});
      await release().catch(() => {});
      await registry(this.env).release(host, shape.memoryMiB, spec.id).catch(() => {});
      this.active = undefined;
      return fail("stopped", "The job was stopped");
    }
    await registry(this.env).touch(spec.id).catch(() => {});
    // Its snapshot routes (host-snapshots.ts): a token for this job's load and save only, kept here hashed, for the
    // job's lifetime from its dispatch. The host carries it; the VM never sees it.
    let snapshot: WireJob["snapshot"], save: WireJob["save"];
    if (snapshots.load || snapshots.save) {
      const token = randomBytes(32).toString("base64url");
      new HostSnapshotStore(this.ctx.storage.sql).put(token, Date.now() + lifetimeMs, snapshots.load, snapshots.save?.key);
      this.snapshotPlan = snapshots;
      ({ snapshot, save } = snapshotWire(snapshots, spec.id, token, this.env));
    }
    const dispatchedAt = Date.now();
    active.sent = true;
    try {
      // A dispatch that throws (the host object unreachable, the RPC refused) is the job's result, never a throw out of
      // run(): a throw would leave the workflow's row to be run again, and fail again, on every restart.
      wire = await this.env.JOB_HOSTS!.getByName(host).dispatch(spec.id, {
        command: spec.command, timeoutSeconds: spec.timeoutSeconds, outputs: spec.outputs, internet: !!spec.internet, files, ...(sync ? { sync } : {}),
        ...(snapshot ? { snapshot } : {}), ...(save ? { save } : {}),
        limits: { cpus: shape.vcpus, memoryMiB: shape.memoryMiB, diskMiB: shape.diskMiB, ...(spec.limits?.pids ? { pids: spec.limits.pids } : {}) },
        ...(spec.secretEnv ? { secretEnv: spec.secretEnv } : {}),
      }, lifetimeMs).catch((error: unknown): WireResult => ({ ok: false, code: "container_failed", message: `The job could not be sent to its host: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}` }));
      active.answered = true;
    } finally {
      // Charged for the span its VM ran: from its host's `started` report (or, for a result that says it ran, what its
      // timings say: a `started` lost on a reconnect never makes a job that ran free), to its result, or until its host
      // was last heard from if it went away. A VM that never started (no report, no result that ran) is not charged.
      const span = chargedSpan(wire, dispatchedAt, Date.now());
      await meter.startedAt(span.from).then(() => meter.stopped(undefined, span.until))
        .catch(error => console.error(JSON.stringify({ type: "host_job_charge_failed", job: spec.id, error: error instanceof Error ? error.name : "unknown" })));
      costUsd = meter.spentUsd();
      await release().catch(() => {});
      await registry(this.env).release(host, shape.memoryMiB, spec.id).catch(() => {});
      this.active = undefined;
    }
    if (!wire.ok) return fail(wire.code, wire.message, costUsd);
    return {
      // The saved snapshot's handle (its id carries the archive's digest, which a job from it checks), or why there is none.
      ...snapshotResult(snapshots, new HostSnapshotStore(this.ctx.storage.sql).saved(), wire),
      ok: true, id: spec.id, instance: spec.instance, exitCode: wire.exitCode, timedOut: wire.timedOut,
      stdout: stream(wire.stdout), stderr: stream(wire.stderr), missing: wire.missing,
      outputs: Object.fromEntries(Object.entries(wire.outputs).map(([name, output]) => [name, stream(output)])),
      pids: wire.pids === "enforced" ? "ulimit" : "unenforced",
      timings: { ...wire.timings, startedAt: at, endedAt: Date.now() }, costUsd,
    };
    } finally {
      // Whatever ended it (a result, a refusal, a throw), it no longer waits: a later run or stop sees that.
      if (this.waiting === waiting) this.waiting = undefined;
      // Its host-side sync ends with it: the token serves nothing more.
      try { new HostSyncStore(this.ctx.storage.sql).clear(); } catch { /* none */ }
      // So does its snapshot token; an upload its host started and never completed is aborted (R2 keeps no parts).
      this.snapshotPlan = undefined;
      try {
        const store = new HostSnapshotStore(this.ctx.storage.sql), left = store.unfinished();
        store.clear();
        if (left && this.env.BUCKET) {
          await this.env.BUCKET.resumeMultipartUpload(left.key, left.uploadId).abort();
          console.log(JSON.stringify({ type: "host_snapshot_upload_aborted", job: spec.id }));
        }
      } catch (error) { console.error(JSON.stringify({ type: "host_snapshot_abort_failed", job: spec.id, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" })); }
    }
  }
  /**
   * Its files as they cross to the host: inline ones, or a volume snapshot's. A tree up to HOST_SYNC_BYTES crosses
   * inline; a larger one (within the job sync limits) the host fetches itself, file by file (host-side sync): the job
   * gets a manifest and a token for this job's files only, valid for its lifetime, kept here hashed.
   */
  private async files(spec: JobSpec): Promise<{ files: WireFile[]; sync?: WireJob["sync"] }> {
    const out: WireFile[] = [];
    let bytes = 0;
    const add = (path: string, data: Uint8Array) => {
      bytes += data.byteLength;
      if (bytes > HOST_SYNC_BYTES || out.length >= JOB_LIMITS.syncFiles) throw new Error(`A job's inline files on a host are at most ${HOST_SYNC_BYTES / 2 ** 20} MiB`);
      out.push({ path, data: toBase64(data) });
    };
    if (spec.files) { for (const [path, data] of Object.entries(spec.files)) add(path, data); return { files: out }; }
    if (!spec.volume) return { files: out };
    if (!this.env.VOLUMES) throw new Error("Volume storage is not bound here");
    const { files: entries } = await this.env.VOLUMES.getByName(`${spec.volume.tenant}:${spec.volume.volume}`).readSet("/", spec.volume.snapshot);
    if (entries.length > JOB_LIMITS.syncFiles) throw new Error(`A job syncs at most ${JOB_LIMITS.syncFiles} files`);
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total > JOB_LIMITS.syncBytes) throw new Error(`A job syncs at most ${JOB_LIMITS.syncBytes} bytes`);
    const large = entries.find(entry => entry.size > JOB_LIMITS.syncFileBytes);
    if (large) throw new Error(`${large.path} is larger than a job syncs (${JOB_LIMITS.syncFileBytes} bytes)`);
    if (total <= HOST_SYNC_BYTES) { for await (const file of volumeFiles(this.env, spec.volume)) add(file.path, file.bytes); return { files: out }; }
    const origin = this.env.AGENT_PUBLIC_URL?.replace(/\/+$/, "");
    if (!origin) throw new Error("Host-side sync needs AGENT_PUBLIC_URL");
    const token = randomBytes(32).toString("base64url");
    // Its deadline: the job's lifetime from now, after the longest it may wait for a host. The sync must end by then,
    // and the token serves nothing after it.
    const expiresAt = Date.now() + this.waitMs() + jobLifetimeMs(spec.timeoutSeconds);
    const manifest = entries.map(entry => ({ path: jobPath(entry.path, "file path"), size: entry.size, sha256: entry.sha256 ?? entry.key.split("/").at(-1)!, key: entry.key }));
    new HostSyncStore(this.ctx.storage.sql).put(token, expiresAt, manifest);
    const files = manifest.map(({ key: _key, ...file }) => file);
    return { files: out, sync: { url: `${origin}/v1/internal/job-hosts/sync/${encodeURIComponent(spec.id)}`, token, files, until: expiresAt } };
  }
  /**
   * GET /sync/<index>, from the job's host (host-side sync): one file of its manifest, streamed from storage, for the
   * job's token. Nothing else is served, and nothing once the job has ended or its token expired.
   */
  async fetch(request: Request): Promise<Response> {
    const match = /^\/sync\/(\d{1,6})$/.exec(new URL(request.url).pathname);
    if (!match || request.method !== "GET") return new Response("Not found", { status: 404 });
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    const file = new HostSyncStore(this.ctx.storage.sql).file(token, Number(match[1]));
    if (!file.ok) return new Response(file.status === 401 ? "Unauthorized" : "Not found", { status: file.status, headers: { "cache-control": "no-store" } });
    if (!this.env.BUCKET) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    const object = await this.env.BUCKET.get(file.key) as { body?: ReadableStream } | null;
    if (!object?.body) return new Response("File object missing", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(object.body, { headers: { "content-type": "application/octet-stream", "content-length": String(file.size), "cache-control": "no-store" } });
  }


  /** The running job's snapshot plan: what a completed save is recorded as. */
  private snapshotPlan?: ReturnType<typeof hostSnapshotPlan>;
  /** The upload being started (the first part's createMultipartUpload), so two parts at once start one. */
  private starting?: Promise<string>;

  /** Snapshot load (the Worker's route streams it from R2): the key this job's token may read, or the refusal's status. */
  snapshotSource(token: string) { return new HostSnapshotStore(this.ctx.storage.sql).load(token); }
  /**
   * Snapshot save, part `n` of `length` bytes: where the Worker's route writes it (the key and the R2 multipart upload,
   * started here on the first part), or why not.
   */
  async snapshotPartTarget(token: string, n: number, length: number): Promise<{ ok: true; key: string; uploadId: string } | { ok: false; status: number; error: string }> {
    const store = new HostSnapshotStore(this.ctx.storage.sql), save = store.save(token);
    if (!save.ok) return { ok: false, status: save.status, error: save.status === 401 ? "Unauthorized" : "This job saves no snapshot" };
    if (save.done) return { ok: false, status: 409, error: "The snapshot is already complete" };
    const refused = checkPart(n, length, snapshotPartBytes(this.env), store.writtenBesides(n));
    if (refused) return { ok: false, status: 400, error: refused };
    if (!this.env.BUCKET) return { ok: false, status: 503, error: "No bucket" };
    let uploadId = save.uploadId;
    if (!uploadId) {
      this.starting ??= this.env.BUCKET.createMultipartUpload(save.key, { httpMetadata: { contentType: "application/gzip" } }).then(upload => { store.started(upload.uploadId); return upload.uploadId; });
      try { uploadId = await this.starting; } finally { this.starting = undefined; }
    }
    return { ok: true, key: save.key, uploadId };
  }
  /** A part the Worker's route wrote: its etag, for the completion. */
  snapshotPartWritten(token: string, n: number, etag: string, size: number) {
    const store = new HostSnapshotStore(this.ctx.storage.sql), save = store.save(token);
    if (!save.ok || !save.uploadId) return { ok: false };
    store.part(n, etag, size);
    return { ok: true };
  }
  /**
   * The save's completion: its parts all there and adding up to the size the host says, the R2 upload completed, and
   * the snapshot recorded in the registry (which deletes the payer's earlier one of that name).
   */
  async snapshotComplete(token: string, size: unknown, sha256: unknown): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const store = new HostSnapshotStore(this.ctx.storage.sql), save = store.save(token), plan = this.snapshotPlan;
    if (!save.ok) return { ok: false, status: save.status, error: save.status === 401 ? "Unauthorized" : "This job saves no snapshot" };
    if (save.done) return { ok: true };
    if (!save.uploadId || !this.env.BUCKET || !plan || "refused" in plan || !plan.save) return { ok: false, status: 409, error: "No upload in progress" };
    const parts = store.parts(), refused = checkComplete(parts, snapshotPartBytes(this.env), size, sha256);
    if (refused) return { ok: false, status: 400, error: refused };
    const object = await this.env.BUCKET.resumeMultipartUpload(save.key, save.uploadId).complete(parts.map(part => ({ partNumber: part.n, etag: part.etag })));
    if (object.size !== size) return { ok: false, status: 400, error: "The stored snapshot's size is not what the host says" };
    const createdAt = Date.now(), saved = { size: size as number, sha256: sha256 as string, createdAt, expiresAt: createdAt + snapshotTtlMs(this.env) };
    store.completed(saved);
    await registry(this.env).snapshotSaved({ key: save.key, tenant: plan.save.tenant, payer: plan.save.payer, name: plan.save.name, ...saved });
    return { ok: true };
  }

  private waiting?: { job: string; stopped: boolean };
  private waitMs() {
    const seconds = Number(this.env.JOB_HOST_WAIT_SECONDS ?? NaN);
    return Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600 ? seconds * 1000 : HOST_WAIT_MS;
  }
  /** A host for `job`, its turn in its pool's queue; undefined when none came in time, "stopped" when stopped meanwhile. */
  private async waitForHost(waiting: { job: string; stopped: boolean }, pool: HostPool, memoryMiB: number, snapshot?: string): Promise<string | undefined | "stopped"> {
    const hosts = registry(this.env), until = Date.now() + this.waitMs(), job = waiting.job;
    try {
      for (let pause = 250; ; pause = Math.min(3_000, pause * 2)) {
        if (waiting.stopped) return "stopped";
        const host = await hosts.want(job, pool, memoryMiB, snapshot);
        // A stop that landed while it asked: the host it got goes back.
        if (host && waiting.stopped) { await hosts.release(host, memoryMiB, job).catch(() => {}); return "stopped"; }
        if (host) return host;
        if (Date.now() + pause > until) return undefined;
        await new Promise(resolve => setTimeout(resolve, pause));
      }
    } finally {
      await hosts.unwant(job).catch(() => {});
    }
  }
  async stop(): Promise<{ stopped: boolean }> {
    if (this.waiting) { this.waiting.stopped = true; return { stopped: true }; }
    if (!this.active) return { stopped: false };
    // Not sent yet: run() sees this before it dispatches. Sent: its host stops it (JobHost.cancel, which also holds a
    // cancel that overtakes the job itself).
    this.active.stopped = true;
    if (!this.active.sent) return { stopped: true };
    if (this.active.answered) return { stopped: false };
    return { stopped: await this.env.JOB_HOSTS!.getByName(this.active.host).cancel(this.active.id, true) };
  }
  /** Charges a failed settle left, retried (computers/meter.ts). */
  async alarm() { await this.meter(60_000).alarm(false); }
}
