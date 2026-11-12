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
import { AttestationError, awsCaller, checkAwsAttestation, type Attestation } from "../../../../shared/job-host-attest.ts";
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

/** The provider our hosts' time is recorded under (usage rows, receipts), with the job's shape as its model. */
export const HOSTS_PROVIDER = "camelrun-hosts";
/** A host not heard from in this long takes no new job. */
const HOST_STALE_MS = 30_000;
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

export type JobHostsEnv = KeyEnv & WebhookEnv & VolumeSyncEnv & {
  /** Which attestors enroll hosts: "aws" (needs JOB_HOST_ROLE_ARNS), "test" (needs TEST_MODE and JOB_HOST_TEST_SECRET). */
  JOB_HOST_ATTESTORS?: string;
  /** Comma-separated IAM role ARNs a host's instance role must be (aws attestor). */
  JOB_HOST_ROLE_ARNS?: string;
  JOB_HOST_TEST_SECRET?: string;
  /** TEST_MODE only: a credential's lifetime in seconds (to test its expiry), and where STS requests go (a fake). */
  JOB_HOST_CREDENTIAL_SECONDS?: string;
  JOB_HOST_STS_TEST_URL?: string;
  JOB_HOSTS?: DurableObjectNamespace<JobHost>;
  HOST_JOBS?: DurableObjectNamespace<HostJob>;
  JOB_HOST_REGISTRY?: DurableObjectNamespace<JobHostRegistry>;
  TEST_MODE?: string;
};
export class HostRefused extends Error { readonly status = 403; }

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const sameText = (a: string, b: string) => { const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b); return x.length === y.length && timingSafeEqual(x, y); };

/** The hosts, their capacity, their credentials and who is revoked. One object, named "hosts". */
export class JobHostRegistry extends DurableObject<JobHostsEnv> {
  constructor(ctx: DurableObjectState, env: JobHostsEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS hosts (name TEXT PRIMARY KEY, slots INTEGER NOT NULL, free INTEGER NOT NULL, seen_at INTEGER NOT NULL)");
    if (!sql.exec<{ name: string }>("PRAGMA table_info(hosts)").toArray().some(column => column.name === "revoked")) sql.exec("ALTER TABLE hosts ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0");
    sql.exec("CREATE TABLE IF NOT EXISTS host_credentials (hash TEXT PRIMARY KEY, host TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS host_attestations (signature TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }
  private revoked(name: string) { return !!this.ctx.storage.sql.exec<{ revoked: number }>("SELECT revoked FROM hosts WHERE name = ?", name).toArray()[0]?.revoked; }

  /** Who the attestation proves (an attestor's check), then a credential for that host. */
  async enroll(attestation: Attestation, audience: string): Promise<{ host: string; credential: string; expiresAt: number }> {
    const attestors = (this.env.JOB_HOST_ATTESTORS ?? "").split(",").map(name => name.trim()).filter(Boolean);
    let host: string;
    try {
      if (attestation?.kind === "aws" && attestors.includes("aws")) host = await this.aws(attestation, audience);
      else if (attestation?.kind === "test" && attestors.includes("test") && this.env.TEST_MODE === "1" && this.env.JOB_HOST_TEST_SECRET) {
        if (typeof attestation.secret !== "string" || !sameText(attestation.secret, this.env.JOB_HOST_TEST_SECRET)) throw new AttestationError("Wrong test secret");
        host = String(attestation.host);
      } else throw new AttestationError("No attestor here takes this attestation");
    } catch (error) {
      console.error(JSON.stringify({ type: "jobhost_enroll_refused", kind: (attestation as { kind?: string })?.kind ?? null, error: error instanceof AttestationError ? error.message : "attestation failed" }));
      throw new HostRefused(error instanceof AttestationError ? error.message : "The attestation could not be checked");
    }
    if (!HOST_NAME.test(host)) throw new HostRefused("Invalid host id");
    if (this.revoked(host)) throw new HostRefused("This host is revoked");
    const lifetime = this.env.TEST_MODE === "1" && Number(this.env.JOB_HOST_CREDENTIAL_SECONDS) >= 1 ? Number(this.env.JOB_HOST_CREDENTIAL_SECONDS) * 1000 : HOST_CREDENTIAL_MS;
    const credential = `${host}.${randomBytes(32).toString("base64url")}`, expiresAt = Date.now() + lifetime;
    this.ctx.storage.sql.exec("DELETE FROM host_credentials WHERE expires_at <= ?", Date.now());
    this.ctx.storage.sql.exec("INSERT INTO host_credentials (hash, host, expires_at) VALUES (?, ?, ?)", digest(credential), host, expiresAt);
    return { host, credential, expiresAt };
  }

  /** The aws attestor: the request checked, sent to STS once, and its caller on the allowlist (shared/job-host-attest.ts). */
  private async aws(attestation: Extract<Attestation, { kind: "aws" }>, audience: string) {
    const roles = (this.env.JOB_HOST_ROLE_ARNS ?? "").split(",").map(role => role.trim()).filter(Boolean);
    if (!roles.length) throw new AttestationError("No host role is allowed here");
    const checked = checkAwsAttestation(attestation, audience);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM host_attestations WHERE at <= ?", Date.now() - ATTESTATION_MEMORY_MS);
    if (sql.exec("SELECT 1 FROM host_attestations WHERE signature = ?", checked.signature).toArray().length) throw new AttestationError("This attestation was used already");
    sql.exec("INSERT INTO host_attestations (signature, at) VALUES (?, ?)", checked.signature, Date.now());
    // Tests send the checked request to a fake STS; anywhere else it goes to the STS endpoint it was signed for.
    const target = this.env.TEST_MODE === "1" && this.env.JOB_HOST_STS_TEST_URL ? this.env.JOB_HOST_STS_TEST_URL : checked.url;
    const response = await fetch(target, { method: "POST", headers: checked.headers, body: checked.body, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) throw new AttestationError(`STS answered ${response.status}`);
    return awsCaller(await response.text(), roles).host;
  }

  /** A credential, checked for `name`: its host, not expired, the host not revoked. */
  verify(name: string, credential: unknown): { ok: true; expiresAt: number } | { ok: false } {
    if (typeof credential !== "string" || !credential.startsWith(`${name}.`)) return { ok: false };
    const row = this.ctx.storage.sql.exec<{ host: string; expires_at: number }>("SELECT host, expires_at FROM host_credentials WHERE hash = ?", digest(credential)).toArray()[0];
    if (!row || row.host !== name || row.expires_at <= Date.now() || this.revoked(name)) return { ok: false };
    return { ok: true, expiresAt: row.expires_at };
  }

  /** Revoke a host: its credentials go, it takes no job, and its socket is closed (JobHost.revoke). `allow` undoes it. */
  async revoke(name: string) {
    this.ctx.storage.sql.exec("INSERT INTO hosts (name, slots, free, seen_at, revoked) VALUES (?, 0, 0, 0, 1) ON CONFLICT(name) DO UPDATE SET revoked = 1, free = 0", name);
    this.ctx.storage.sql.exec("DELETE FROM host_credentials WHERE host = ?", name);
    await this.env.JOB_HOSTS?.getByName(name).revoke();
    return { revoked: name };
  }
  allow(name: string) { this.ctx.storage.sql.exec("UPDATE hosts SET revoked = 0 WHERE name = ?", name); return { allowed: name }; }

  seen(name: string, slots: number | undefined, free: number) {
    if (this.revoked(name)) throw new HostRefused("This host is revoked");
    // What a host reports is checked: whole numbers, free within its slots (a host cannot claim more than it has).
    const whole = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1024;
    if (!whole(free) || (slots !== undefined && (!whole(slots) || free > slots))) throw new Error("Invalid host capacity");
    if (slots === undefined) {
      const known = this.ctx.storage.sql.exec<{ slots: number }>("SELECT slots FROM hosts WHERE name = ?", name).toArray()[0];
      if (!known || free > known.slots) throw new Error("Invalid host capacity");
    }
    this.ctx.storage.sql.exec(`INSERT INTO hosts (name, slots, free, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET slots = COALESCE(?, slots), free = excluded.free, seen_at = excluded.seen_at`, name, slots ?? free, free, Date.now(), slots ?? null);
  }
  /** A fresh, allowed host with a free slot, which is taken; undefined: none. */
  place(): string | undefined {
    const row = this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM hosts WHERE seen_at > ? AND free > 0 AND revoked = 0 ORDER BY free DESC, name LIMIT 1", Date.now() - HOST_STALE_MS).toArray()[0];
    if (!row) return undefined;
    this.ctx.storage.sql.exec("UPDATE hosts SET free = free - 1 WHERE name = ?", row.name);
    return row.name;
  }
  release(name: string) { this.ctx.storage.sql.exec("UPDATE hosts SET free = MIN(slots, free + 1) WHERE name = ? AND revoked = 0", name); }
  list() { return this.ctx.storage.sql.exec("SELECT name, slots, free, seen_at AS seenAt, revoked FROM hosts ORDER BY name").toArray(); }
}

const registry = (env: JobHostsEnv) => env.JOB_HOST_REGISTRY!.getByName("hosts");

/** What a host's attestation must be signed for: this runtime (its public URL, else the request's origin). */
export function jobHostAudience(request: Request, env: { AGENT_PUBLIC_URL?: string }) {
  return `camelrun-job-host:${(env.AGENT_PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, "")}`;
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
  const [, host, allow] = match, hosts = registry(env);
  if (host !== undefined && !HOST_NAME.test(decodeURIComponent(host))) return Response.json({ error: "Invalid host id", code: "INVALID_REQUEST" }, { status: 400 });
  if (!host && request.method === "GET") return Response.json({ hosts: await hosts.list() });
  if (host && !allow && request.method === "DELETE") return Response.json(await hosts.revoke(decodeURIComponent(host)));
  if (host && allow && request.method === "POST") return Response.json(await hosts.allow(decodeURIComponent(host)));
  return Response.json({ error: "Not found", code: "NOT_FOUND" }, { status: 404 });
}

/** One host's connection: jobs out, results in. */
export class JobHost extends DurableObject<JobHostsEnv> {
  private socket?: WebSocket;
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
        close(error instanceof HostRefused ? 1008 : 1007, error instanceof HostRefused ? "Revoked" : "Invalid message");
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
          void registry(this.env).verify(name, credential).then(checked => {
            if (!checked.ok) { close(1008, "Unauthorized"); return; }
            state = "authed";
            clearTimeout(deadline);
            // A host that reconnects replaces its old socket; jobs in flight on it keep their pending results.
            if (this.socket && this.socket !== socket) try { this.socket.close(1000, "Replaced"); } catch { /* already closed */ }
            this.socket = socket;
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
    socket.addEventListener("close", () => { if (this.socket === socket) this.socket = undefined; });
  }
  /** Revoked: the socket closes, and jobs waiting on this host end failed rather than at their deadline. */
  revoke() {
    try { this.socket?.close(1008, "Revoked"); } catch { /* closed */ }
    this.socket = undefined;
    for (const [id, done] of this.pending) { this.pending.delete(id); done({ ok: false, code: "container_failed", message: "The job host was revoked" }); }
  }
  private async receive(name: string, message: HostMessage) {
    if (message.type === "hello") {
      // Its free slots as it reports them: a reconnecting host's jobs in flight keep theirs.
      await registry(this.env).seen(name, message.slots, message.free);
      this.send({ type: "registered", host: name });
    } else if (message.type === "heartbeat") await registry(this.env).seen(name, undefined, message.free);
    else if (message.type === "result") { const done = this.pending.get(message.id); this.pending.delete(message.id); done?.(message.result); }
  }
  private send(message: unknown) {
    if (!this.socket) return false;
    for (const frame of frames(message)) this.socket.send(frame);
    return true;
  }
  /** Run one job on this host and answer its result; the socket gone or the deadline passed answers a failure. */
  async dispatch(id: string, spec: WireJob, deadlineMs: number): Promise<WireResult> {
    return new Promise<WireResult>(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, code: "container_failed", message: "The job host did not answer in time" }); }, deadlineMs);
      this.pending.set(id, result => { clearTimeout(timer); resolve(result); });
      if (!this.send({ type: "job", id, spec })) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, code: "start_failed", message: "The job host is not connected" }); }
    });
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
    return new ComputerMeter({ store: this.ctx.storage, billing: meterBilling(this.env, HOSTS_PROVIDER), idleMs, schedule: at => this.ctx.storage.setAlarm(at) });
  }
  async run(value: unknown): Promise<JobResult> {
    const spec = jobSpec(value);
    const at = Date.now();
    const timings = () => ({ startedAt: at, endedAt: Date.now(), startMs: 0, syncMs: 0, commandMs: 0, collectMs: 0, totalMs: Date.now() - at });
    const fail = (code: Extract<JobResult, { ok: false }>["code"], message: string, costUsd?: number): JobResult => ({ ok: false, id: spec.id, code, message, timings: timings(), ...(costUsd !== undefined ? { costUsd } : {}) });
    if (this.active) return fail("job_running", `Job ${spec.id} is running`);
    const lifetimeMs = jobLifetimeMs(spec.timeoutSeconds), meter = this.meter(lifetimeMs), machine = `job:${spec.id}`;
    try {
      await meter.admit(spec.payer);
      const limit = (await keyServices(this.env)).accounts.tenants.computerLimit(spec.payer.tenant);
      await transaction(this.env, async sql => reserveComputer(sql, spec.payer.tenant, spec.payer.agent, machine, Date.now() + lifetimeMs, Date.now(), await limit));
    } catch (error) { return fail("admission_refused", error instanceof Error ? error.message.slice(0, 500) : "Refused"); }
    const release = () => withSql(this.env, sql => releaseComputer(sql, spec.payer.tenant, machine));
    let files: WireFile[];
    try { files = await this.files(spec); }
    catch (error) { await release(); return fail("sync_failed", error instanceof Error ? error.message.slice(0, 500) : "The job's files could not be read"); }
    const host = await registry(this.env).place();
    if (!host) { await release(); return fail("start_failed", "No job host has a free slot"); }
    this.active = { host, id: spec.id };
    let wire: WireResult, costUsd = 0;
    try {
      // Metered from dispatch to result, under the job's own session name: a run made again is the same charge.
      await meter.started(spec.payer, spec.instance, lifetimeMs, 0, `job:${spec.id}`);
      // A dispatch that throws (the host object unreachable, the RPC refused) is the job's result, never a throw out of
      // run(): a throw would leave the workflow's row to be run again, and fail again, on every restart.
      wire = await this.env.JOB_HOSTS!.getByName(host).dispatch(spec.id, {
        command: spec.command, timeoutSeconds: spec.timeoutSeconds, outputs: spec.outputs, limits: spec.limits ?? {}, internet: !!spec.internet, files,
        ...(spec.secretEnv ? { secretEnv: spec.secretEnv } : {}),
      }, lifetimeMs).catch((error: unknown): WireResult => ({ ok: false, code: "container_failed", message: `The job could not be sent to its host: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}` }));
    } finally {
      await meter.stopped().catch(error => console.error(JSON.stringify({ type: "host_job_charge_failed", job: spec.id, error: error instanceof Error ? error.name : "unknown" })));
      costUsd = meter.spentUsd();
      await release().catch(() => {});
      await registry(this.env).release(host).catch(() => {});
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
  async stop(): Promise<{ stopped: boolean }> {
    if (!this.active) return { stopped: false };
    return { stopped: await this.env.JOB_HOSTS!.getByName(this.active.host).cancel(this.active.id) };
  }
  /** Charges a failed settle left, retried (computers/meter.ts). */
  async alarm() { await this.meter(60_000).alarm(false); }
}
