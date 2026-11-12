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
//   charged once), and answers the JobResult.
// Off by default: jobDriver() picks these only where the bindings and JOB_HOST_ATTESTORS are set (test configs today).
import { DurableObject } from "cloudflare:workers";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { releaseComputer, reserveComputer } from "../../../../src/core/computer-limit.ts";
import { AttestationError, awsCaller, checkAwsAttestation } from "../../../../shared/job-host-attest.ts";
import { Frames, frames, fromBase64, toBase64, type HostMessage, type WireFile, type WireJob, type WireResult, type WireStream } from "../../../../shared/job-host-protocol.ts";
import { guardAlarms } from "../alarm-guard.ts";
import { ComputerMeter } from "../computers/meter.ts";
import { meterBilling } from "../computers/meter-billing.ts";
import type { KeyEnv } from "../security-services.ts";
import { keyServices } from "../security-services.ts";
import { transaction, withSql } from "../postgres.ts";
import type { WebhookEnv } from "../webhooks.ts";
import { volumeFiles, type VolumeSyncEnv } from "./camel-sync.ts";
import { jobLifetimeMs, jobSpec, JOB_LIMITS, type JobResult, type JobSpec, type JobStream } from "./job.ts";
import { needsContainer } from "./driver.ts";
import { HOST_POOL_PRICES, HOST_POOLS, hostInstance, hostPool, hostRoles, hostSecondRate, hostSessionCost, hostShape, chargedSpan, type HostPool, type HostPriceEnv, type HostShape } from "./host-pricing.ts";

/** The provider our hosts' time is recorded under (usage rows, receipts), with the job's shape as its model. */
export const HOSTS_PROVIDER = "camelrun-hosts";
/** A host not heard from in this long takes no new job. */
const HOST_STALE_MS = 30_000;
/** A waiting job not heard from in this long has stopped waiting (its object was evicted, say). */
const WAITER_STALE_MS = 20_000;
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

export type JobHostsEnv = KeyEnv & WebhookEnv & VolumeSyncEnv & HostPriceEnv & {
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
    sql.exec("CREATE TABLE IF NOT EXISTS host_credentials (hash TEXT PRIMARY KEY, host TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS host_attestations (signature TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS host_attestations_at ON host_attestations (at)");
    sql.exec("CREATE INDEX IF NOT EXISTS host_credentials_expires ON host_credentials (expires_at)");
    sql.exec("CREATE INDEX IF NOT EXISTS host_credentials_host ON host_credentials (host, expires_at)");
    if (!sql.exec<{ name: string }>("PRAGMA table_info(host_credentials)").toArray().some(column => column.name === "pool")) sql.exec("ALTER TABLE host_credentials ADD COLUMN pool TEXT");
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
  allow(name: string) { this.ctx.storage.sql.exec("UPDATE hosts SET revoked = 0 WHERE name = ?", name); return { allowed: name }; }

  /**
   * A host's hello (slots, vCPUs, memory) or heartbeat (free slots alone). `pool` is its credential's, which the attested
   * role decides (enrollHost), never the host's own word. A build host runs one job: one that says otherwise is refused.
   */
  seen(name: string, slots: number | undefined, free: number, pool?: HostPool, machine?: { vcpus?: unknown; memoryMiB?: unknown }) {
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
    // A host with every slot free runs nothing: whatever memory its row still counts (a job object that died before it
    // released its placement) is let go.
    if (slots !== undefined ? free === slots : free === this.ctx.storage.sql.exec<{ slots: number }>("SELECT slots FROM hosts WHERE name = ?", name).toArray()[0]?.slots)
      this.ctx.storage.sql.exec("UPDATE hosts SET used_mib = 0 WHERE name = ?", name);
    this.ctx.storage.sql.exec(`INSERT INTO hosts (name, slots, free, seen_at, pool) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET slots = COALESCE(?, slots), free = excluded.free, seen_at = excluded.seen_at, pool = COALESCE(?, pool)`,
      name, slots ?? free, free, Date.now(), pool ?? "test", slots ?? null, pool ?? null);
    this.ctx.storage.sql.exec("UPDATE hosts SET idle_since = CASE WHEN free < slots THEN NULL ELSE COALESCE(idle_since, ?) END WHERE name = ?", Date.now(), name);
  }
  /**
   * A fresh, allowed, undrained host of `pool` with a free slot and room for `memoryMiB` within its pool's sandbox
   * memory, which are taken; undefined: none. A VM that would not fit is never sent to boot (and charged for a failed
   * boot).
   */
  place(pool: HostPool = "test", memoryMiB = 0): string | undefined {
    const room = HOST_POOL_PRICES[pool].memoryGiB * 1024 - memoryMiB;
    if (room < 0) return undefined;
    const row = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM hosts WHERE seen_at > ? AND free > 0 AND revoked = 0 AND draining = 0 AND pool = ? AND used_mib <= ? ORDER BY free DESC, name LIMIT 1", Date.now() - HOST_STALE_MS, pool, room).toArray()[0];
    if (!row) return undefined;
    this.ctx.storage.sql.exec("UPDATE hosts SET free = free - 1, used_mib = used_mib + ?, idle_since = NULL WHERE name = ?", memoryMiB, row.name);
    return row.name;
  }
  /**
   * A job's turn at a host (HostJob, while it waits): a host when one is free and no job of its pool has waited longer,
   * else undefined, and the job counts as waiting (the demand the scaler reads) until it calls again or gives up.
   */
  want(job: string, pool: HostPool, memoryMiB = 0): string | undefined {
    const sql = this.ctx.storage.sql, now = Date.now();
    sql.exec("DELETE FROM waiting WHERE seen_at <= ?", now - WAITER_STALE_MS);
    sql.exec("INSERT INTO waiting (job, pool, since, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(job) DO UPDATE SET seen_at = excluded.seen_at", job, pool, now, now);
    const first = sql.exec<{ job: string }>("SELECT job FROM waiting WHERE pool = ? ORDER BY since, job LIMIT 1", pool).toArray()[0];
    if (first?.job !== job) return undefined;
    const host = this.place(pool, memoryMiB);
    if (host) sql.exec("DELETE FROM waiting WHERE job = ?", job);
    return host;
  }
  /** A waiting job that stopped waiting (it gave up, or was stopped). */
  unwant(job: string) { this.ctx.storage.sql.exec("DELETE FROM waiting WHERE job = ?", job); }
  release(name: string, memoryMiB = 0) {
    this.ctx.storage.sql.exec("UPDATE hosts SET free = MIN(slots, free + 1), used_mib = MAX(0, used_mib - ?) WHERE name = ? AND revoked = 0", memoryMiB, name);
    this.ctx.storage.sql.exec("UPDATE hosts SET idle_since = ? WHERE name = ? AND free = slots AND idle_since IS NULL", Date.now(), name);
  }
  list() { return this.ctx.storage.sql.exec("SELECT name, pool, slots, free, seen_at AS seenAt, revoked, draining, idle_since AS idleSince FROM hosts ORDER BY name").toArray(); }
  /** Drain a host (the scaler, before it ends it): no new job is placed on it. */
  drain(name: string) { this.ctx.storage.sql.exec("UPDATE hosts SET draining = 1 WHERE name = ?", name); return { draining: name }; }

  /**
   * What the scaler sizes the pools by (infra/job-hosts/scaler): per pool, its live hosts and slots, the jobs running
   * and waiting (and how long the oldest has), and each live host's state: busy, idle since when, draining. A host is
   * its EC2 instance id (job-host-attest.ts), which is how the scaler finds it in its group.
   */
  demand() {
    const sql = this.ctx.storage.sql, now = Date.now();
    sql.exec("DELETE FROM waiting WHERE seen_at <= ?", now - WAITER_STALE_MS);
    const hosts = sql.exec<{ name: string; pool: string; slots: number; free: number; draining: number; idle_since: number | null }>(
      "SELECT name, pool, slots, free, draining, idle_since FROM hosts WHERE seen_at > ? AND revoked = 0 ORDER BY name", now - HOST_STALE_MS).toArray();
    return {
      at: now,
      pools: Object.fromEntries(HOST_POOLS.map(pool => {
        const mine = hosts.filter(host => host.pool === pool), waiting = sql.exec<{ n: number; oldest: number | null }>("SELECT count(*) AS n, MIN(since) AS oldest FROM waiting WHERE pool = ?", pool).one();
        return [pool, {
          hosts: mine.map(host => ({ host: host.name, slots: host.slots, running: host.slots - host.free, draining: !!host.draining, idleSince: host.idle_since })),
          slots: mine.filter(host => !host.draining).reduce((sum, host) => sum + host.slots, 0),
          running: mine.reduce((sum, host) => sum + host.slots - host.free, 0),
          waiting: Number(waiting.n), oldestWaitMs: waiting.oldest === null ? 0 : now - Number(waiting.oldest),
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
 * /v1/internal/job-hosts/<host>/drain stops placing jobs on a host it is about to end. Nothing else: it reads no job,
 * payer or secret. Without the token configured, these paths are unknown.
 */
export async function scalerRoutes(request: Request, env: JobHostsEnv): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  const match = /^\/v1\/internal\/job-hosts\/(?:demand|([^/]+)\/drain)$/.exec(path);
  if (!match || !env.JOB_HOST_SCALER_TOKEN || !env.JOB_HOST_REGISTRY) return undefined;
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (env.JOB_HOST_SCALER_TOKEN.length < 32 || !sameText(given, env.JOB_HOST_SCALER_TOKEN)) return Response.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  const hosts = registry(env);
  if (!match[1] && request.method === "GET") return Response.json(await hosts.demand());
  if (match[1] && request.method === "POST") {
    let host = "";
    try { host = decodeURIComponent(match[1]); } catch { /* a malformed escape: refused below */ }
    if (!HOST_NAME.test(host)) return Response.json({ error: "Invalid host id", code: "INVALID_REQUEST" }, { status: 400 });
    return Response.json(await hosts.drain(host));
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
      await registry(this.env).seen(name, message.slots, message.free, this.pool ?? "test", { vcpus: message.vcpus, memoryMiB: message.memoryMiB });
      this.send({ type: "registered", host: name });
    } else if (message.type === "heartbeat") await registry(this.env).seen(name, undefined, message.free, this.pool ?? "test");
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
    const result = await new Promise<WireResult>(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, code: "container_failed", message: "The job host did not answer in time" }); }, deadlineMs);
      this.pending.set(id, result => { clearTimeout(timer); resolve(result); });
      if (!this.send({ type: "job", id, spec })) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, code: "start_failed", message: "The job host is not connected" }); }
    });
    const ranFrom = this.startedAt.get(id);
    this.startedAt.delete(id);
    return { ...result, ...(ranFrom !== undefined ? { ranFrom, ranUntil: Math.max(ranFrom, this.socket ? Date.now() : this.lastSeen) } : {}) };
  }
  cancel(id: string) { return this.send({ type: "cancel", id }); }
}

const stream = (wire: WireStream): JobStream => ({ bytes: fromBase64(wire.data), size: wire.size, truncated: wire.truncated });

/** One job on a host: admission, a slot, placement, the meter, the result. */
export class HostJob extends DurableObject<JobHostsEnv> {
  private active?: { host: string; id: string };
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
    if (this.active) return fail("job_running", `Job ${spec.id} is running`);
    // Snapshots and other images are Cloudflare containers' alone so far (driver.ts needsContainer): refused, never
    // run without them.
    if (needsContainer(spec)) return fail("start_failed", "Job hosts run the workspace image only, without snapshots, so far: run this job on Cloudflare Containers (JOB_PROVIDER=auto routes it there)");
    const lifetimeMs = jobLifetimeMs(spec.timeoutSeconds), meter = this.meter(lifetimeMs), machine = `job:${spec.id}`;
    // The VM the host boots is the one priced: its shape (the job's limits, else its instance type's), and the pool that
    // shape goes to. A pricing setting that does not parse refuses the job before anything starts.
    // Its rate is fixed here, once: a setting changed (or broken) while it runs cannot change or strand its charge.
    const shape = hostShape(spec), pool = hostPool(shape);
    let rate: number;
    try { rate = hostSecondRate(pool, shape, this.env); }
    catch (error) { return fail("admission_refused", error instanceof Error ? error.message.slice(0, 500) : "Pricing is misconfigured"); }
    try { await meter.admit(spec.payer); }
    catch (error) { return fail("admission_refused", error instanceof Error ? error.message.slice(0, 500) : "Refused"); }
    let files: WireFile[];
    try { files = await this.files(spec); }
    catch (error) { return fail("sync_failed", error instanceof Error ? error.message.slice(0, 500) : "The job's files could not be read"); }
    // A host of its pool, in turn: it waits (counted as demand, which the scaler grows the pool by) until one is free.
    const host = await this.waitForHost(spec.id, pool, shape.memoryMiB);
    if (host === "stopped") return fail("stopped", "The job was stopped");
    if (!host) return fail("start_failed", `No ${pool} job host was free within ${Math.round(this.waitMs() / 1000)} s`);
    // The computer slot from here: a job waiting for a host holds none.
    try {
      const limit = (await keyServices(this.env)).accounts.tenants.computerLimit(spec.payer.tenant);
      await transaction(this.env, async sql => reserveComputer(sql, spec.payer.tenant, spec.payer.agent, machine, Date.now() + lifetimeMs, Date.now(), await limit));
    } catch (error) {
      await registry(this.env).release(host, shape.memoryMiB).catch(() => {});
      return fail("admission_refused", error instanceof Error ? error.message.slice(0, 500) : "Refused");
    }
    const release = () => withSql(this.env, sql => releaseComputer(sql, spec.payer.tenant, machine));
    this.active = { host, id: spec.id };
    let wire: WireResult & { ranFrom?: number; ranUntil?: number } = { ok: false, code: "container_failed", message: "No result" }, costUsd = 0;
    // A session is open from dispatch, at the rate fixed at admission, under the job's own name (a run made again is the
    // same charge): if this object dies mid-job, its alarm charges it, at most to the job's lifetime. Once the result is
    // in, the session is trimmed to the span its VM ran.
    try { await meter.started(spec.payer, hostInstance(pool, shape), lifetimeMs, 0, `job:${spec.id}`, { rate }); }
    catch (error) {
      await release().catch(() => {});
      await registry(this.env).release(host, shape.memoryMiB).catch(() => {});
      this.active = undefined;
      return fail("start_failed", error instanceof Error ? error.message.slice(0, 300) : "The job could not be metered");
    }
    const dispatchedAt = Date.now();
    try {
      // A dispatch that throws (the host object unreachable, the RPC refused) is the job's result, never a throw out of
      // run(): a throw would leave the workflow's row to be run again, and fail again, on every restart.
      wire = await this.env.JOB_HOSTS!.getByName(host).dispatch(spec.id, {
        command: spec.command, timeoutSeconds: spec.timeoutSeconds, outputs: spec.outputs, internet: !!spec.internet, files,
        limits: { cpus: shape.vcpus, memoryMiB: shape.memoryMiB, diskMiB: shape.diskMiB, ...(spec.limits?.pids ? { pids: spec.limits.pids } : {}) },
        ...(spec.secretEnv ? { secretEnv: spec.secretEnv } : {}),
      }, lifetimeMs).catch((error: unknown): WireResult => ({ ok: false, code: "container_failed", message: `The job could not be sent to its host: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}` }));
    } finally {
      // Charged for the span its VM ran: from its host's `started` report (or, for a result that says it ran, what its
      // timings say: a `started` lost on a reconnect never makes a job that ran free), to its result, or until its host
      // was last heard from if it went away. A VM that never started (no report, no result that ran) is not charged.
      const span = chargedSpan(wire, dispatchedAt, Date.now());
      await meter.startedAt(span.from).then(() => meter.stopped(undefined, span.until))
        .catch(error => console.error(JSON.stringify({ type: "host_job_charge_failed", job: spec.id, error: error instanceof Error ? error.name : "unknown" })));
      costUsd = meter.spentUsd();
      await release().catch(() => {});
      await registry(this.env).release(host, shape.memoryMiB).catch(() => {});
      this.active = undefined;
    }
    if (!wire.ok) return fail(wire.code, wire.message, costUsd);
    return {
      ok: true, id: spec.id, instance: spec.instance, exitCode: wire.exitCode, timedOut: wire.timedOut,
      stdout: stream(wire.stdout), stderr: stream(wire.stderr), missing: wire.missing,
      outputs: Object.fromEntries(Object.entries(wire.outputs).map(([name, output]) => [name, stream(output)])),
      pids: wire.pids === "enforced" ? "ulimit" : "unenforced",
      timings: { ...wire.timings, startedAt: at, endedAt: Date.now() }, costUsd,
    };
  }
  /** Its files as they cross to the host: inline ones, or a volume snapshot's, up to HOST_SYNC_BYTES. */
  private async files(spec: JobSpec): Promise<WireFile[]> {
    const out: WireFile[] = [];
    let bytes = 0;
    const add = (path: string, data: Uint8Array) => {
      bytes += data.byteLength;
      if (bytes > HOST_SYNC_BYTES || out.length >= JOB_LIMITS.syncFiles) throw new Error(`A job's files on a host are at most ${HOST_SYNC_BYTES / 2 ** 20} MiB for now`);
      out.push({ path, data: toBase64(data) });
    };
    if (spec.files) for (const [path, data] of Object.entries(spec.files)) add(path, data);
    else if (spec.volume) for await (const file of volumeFiles(this.env, spec.volume)) add(file.path, file.bytes);
    return out;
  }
  private waiting?: { job: string; stopped: boolean };
  private waitMs() {
    const seconds = Number(this.env.JOB_HOST_WAIT_SECONDS ?? NaN);
    return Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600 ? seconds * 1000 : HOST_WAIT_MS;
  }
  /** A host for `job`, its turn in its pool's queue; undefined when none came in time, "stopped" when stopped meanwhile. */
  private async waitForHost(job: string, pool: HostPool, memoryMiB: number): Promise<string | undefined | "stopped"> {
    const hosts = registry(this.env), until = Date.now() + this.waitMs(), waiting = this.waiting = { job, stopped: false };
    try {
      for (let pause = 250; ; pause = Math.min(3_000, pause * 2)) {
        if (waiting.stopped) return "stopped";
        const host = await hosts.want(job, pool, memoryMiB);
        if (host) return host;
        if (Date.now() + pause > until) return undefined;
        await new Promise(resolve => setTimeout(resolve, pause));
      }
    } finally {
      this.waiting = undefined;
      await hosts.unwant(job).catch(() => {});
    }
  }
  async stop(): Promise<{ stopped: boolean }> {
    if (this.waiting) { this.waiting.stopped = true; return { stopped: true }; }
    if (!this.active) return { stopped: false };
    return { stopped: await this.env.JOB_HOSTS!.getByName(this.active.host).cancel(this.active.id) };
  }
  /** Charges a failed settle left, retried (computers/meter.ts). */
  async alarm() { await this.meter(60_000).alarm(false); }
}
