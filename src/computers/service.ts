import { createHash, randomUUID } from "node:crypto";
import type { Accounts } from "../accounts.ts";
import { transaction, type Db, type DbClient, type Sql } from "../db.ts";
import { HttpError } from "../http.ts";
import type { Outbound } from "../outbound.ts";
import type { ToolDefinition } from "../protocol.ts";
import { Workspaces } from "../workspaces.ts";
import type { ToolContext } from "../volume-tools.ts";
import type { ComputerMount } from "../computer-env.ts";
import type { ComputerTransfers } from "./transfers.ts";
import { fileCommand, MANAGED, ManagedComputers, managedTools, storable } from "./managed.ts";
import { fileReceipts, driver, isBrowserProvider, PROVIDERS, type Credentials, type DriverFactory, type ComputerDriver, type Provider, type Reference } from "./providers.ts";
import { reserveComputer, releaseComputer, computerToolError } from "../core/computer-limit.ts";
import { computerOwner, shareComputer, SHARED_COMPUTER_CONTROL, SHARED_COMPUTER_STOPPED } from "../core/computer-share.ts";
import { connectionForkable, FORK_LIMITS, forkableProvider, forkedFrom, forkRows, forkUnsupported, noSession, notForkable, snapshotFailed, snapshotRef, type ForkedFrom, type SnapshotRef } from "../core/computer-fork.ts";

const id = () => `cmp_${randomUUID().replaceAll("-", "")}`;
/** A fork snapshot's sealed reference: the snapshot, and what drops it (the provider account's credentials, or the managed key). */
type SnapshotSecret = { ref: SnapshotRef; managed: boolean; platform?: boolean; provider: string; credentials?: Credentials };
const parameters = (properties = {}, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string", minLength: 1, maxLength: 32000 };
const tool = (name: string, description: string, props = {}, required: string[] = []): ToolDefinition => ({ name, description, timeoutMs: 180000, exposure: "both", parameters: parameters(props, required) });
const COMMON = [tool("computer_start", "Start your attached computer or return its current session. Files and processes survive across turns until its fixed expiry. A new session after expiry starts empty. A shell computer mounts its home directory at /computer for the file tools; save results to a volume with cp before stopping."), tool("computer_status", "Read your computer's session and fixed expiry; does not start one."), tool("computer_stop", "Stop your attached computer and discard its session files. Call this when the task is finished and no follow-up needs it, after copying results to a volume with cp.")];
const SHELL = [tool("computer_exec", "Call computer_start first. Run a shell command in your attached remote Linux computer, never on the camelRun host. Inspect exitCode. Redirect output for background processes. Files survive between calls until expiry.", { command: text, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 } }, ["command"]), tool("computer_write_file", "Write a UTF-8 file in your remote computer. This is separate from camelRun workspace files.", { path: text, content: { type: "string", maxLength: 16000 } }, ["path", "content"]), tool("computer_read_file", "Read up to 24000 characters from a UTF-8 file in your remote computer.", { path: text }, ["path"])];
const BROWSER = [tool("browser_navigate", "Navigate your attached remote browser to an HTTP(S) URL.", { url: text }, ["url"]), tool("browser_read", "Read the current remote page's title, URL and visible text."), tool("browser_click", "Click a CSS selector in the remote page.", { selector: text }, ["selector"]), tool("browser_fill", "Fill a CSS-selected input in the remote page.", { selector: text, text: { type: "string", maxLength: 16000 } }, ["selector", "text"]), tool("browser_evaluate", "Run JavaScript in the remote web page and return a JSON result. No host shell or filesystem access.", { expression: text }, ["expression"])];
export const COMPUTER_TOOLS = new Set([...COMMON, ...SHELL, ...BROWSER].map(t => t.name));
const publicConnection = (r: any) => ({ id: r.id, agent: r.agent, provider: r.provider, managed: !!r.managed, subagents: r.subagents, leaseSeconds: r.lease_seconds, dailySeconds: r.daily_seconds, createdAt: r.created_at, billing: r.managed ? "credits" : "provider_account", session: publicLease(r.lease), forkable: connectionForkable(r), ...forkedFrom(r) ? { forkedFrom: forkedFrom(r) } : {} });
const publicLease = (r: any) => r ? ({ id: r.id, provider: r.provider, workspaceId: r.workspace, state: r.state, recoveryRequired: r.state === "uncertain" || r.state === "closing" && !!r.error, createdAt: r.created_at, expiresAt: r.expires_at, closedAt: r.closed_at, ...(r.error ? { error: r.error } : {}) }) : null;

export class Computers {
  readonly options: { tenantComputerLimit?: (tenant: string) => number | undefined; db: Db; accounts: Pick<Accounts, "seal" | "unseal"> & ManagedComputers["options"]["accounts"]; outbound: Outbound; transfers?: ComputerTransfers; driver?: DriverFactory; now?: () => number } & Partial<Pick<ManagedComputers["options"], "enabled" | "runtime" | "endUsers" | "credit" | "payer" | "machines" | "sleep" | "provider" | "microvm" | "priceAtCost" | "boatUrl">>;
  readonly managed: ManagedComputers;
  constructor(options: Computers["options"]) {
    this.options = options;
    this.managed = new ManagedComputers({ tenantComputerLimit: options.tenantComputerLimit, db: options.db, accounts: options.accounts, outbound: options.outbound, enabled: !!options.enabled, runtime: options.runtime ?? "", endUsers: options.endUsers, credit: options.credit, payer: options.payer, provider: options.provider, microvm: options.microvm, priceAtCost: options.priceAtCost, machines: options.machines, sleep: options.sleep, boatUrl: options.boatUrl, now: () => this.now() });
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private async lock<T>(tenant: string, agent: string, fn: (sql: DbClient) => Promise<T>) {
    const sql = await this.options.db.connect();
    try {
      await sql.query("select pg_advisory_lock(hashtextextended($1, 0))", [`computer:${tenant}:${agent}`]);
      // Deliberately no retrying SQL transaction around an external mutation.
      return await fn(sql);
    } finally {
      try { await sql.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`computer:${tenant}:${agent}`]); } finally { sql.release(); }
    }
  }
  async revision(tenant: string, agent: string) {
    agent = await computerOwner(this.options.db, tenant, agent);
    const mount = await this.filesystem(tenant, agent);
    return `${(await this.options.db.query("select id from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rows[0]?.id ?? ""}:${mount?.id ?? ""}`;
  }
  /**
   * An account deletion: every connection, then every fork snapshot of the account, whatever starts from it. A snapshot
   * not deleted yet fails the step so the deletion tries again (a drop that keeps failing is given up and logged).
   */
  async removeTenant(tenant: string) {
    for (const c of await this.list(tenant)) await this.remove(tenant, c.id);
    let left = 0;
    for (const row of await forkRows.ofTenant(this.options.db, tenant)) if (!(await this.drop(row, true))) left++;
    left += await forkRows.takingOf(this.options.db, tenant);
    if (left) throw new Error(`${left} computer snapshots are not deleted yet`);
  }
  async list(tenant: string) {
    const { rows } = await this.options.db.query("select c.*, row_to_json(l) as lease from computer_connections c left join lateral (select * from computer_leases where connection=c.id order by sequence desc limit 1) l on true where c.tenant = $1 and c.agent not like 'removed:%' order by c.created_at", [tenant]);
    return Promise.all(rows.map(async r => r.managed ? { ...publicConnection(r), session: await this.managed.session(r.id) } : publicConnection(r)));
  }
  /** Connect an agent to a provider with its credentials, or, with none, to a managed computer. */
  async create(tenant: string, input: { agent: string; provider: Provider; credentials?: Credentials; leaseSeconds?: number; dailySeconds?: number; subagents?: boolean; forkable?: boolean }) {
    if (input.subagents !== undefined && typeof input.subagents !== "boolean") throw new HttpError(400, "subagents must be true or false");
    if (input.forkable !== undefined && typeof input.forkable !== "boolean") throw new HttpError(400, "forkable must be true or false");
    if (!PROVIDERS.includes(input.provider)) throw new HttpError(400, "Unknown computer provider");
    if (input.credentials === undefined && (input.provider === "boat" || input.provider === "lambda")) {
      if (!this.options.enabled) throw new HttpError(403, "Managed computers are not available on this runtime");
      const { leaseSeconds = MANAGED.idleSeconds, dailySeconds = MANAGED.dailySeconds } = input;
      if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > MANAGED.maxSeconds || !Number.isInteger(dailySeconds) || dailySeconds < leaseSeconds || dailySeconds > 86400) throw new HttpError(400, "Invalid computer time limits");
      return this.insertConnection(tenant, { ...input, provider: this.managed.provider, credentials: {}, leaseSeconds, dailySeconds, managed: true });
    }
    return this.createWithCredentials(tenant, { leaseSeconds: 900, dailySeconds: 3600, ...input, credentials: input.credentials as Credentials });
  }
  private async createWithCredentials(tenant: string, input: { agent: string; provider: Provider; credentials: Credentials; leaseSeconds: number; dailySeconds: number; subagents?: boolean; forkable?: boolean }) {
    if (input.provider === "lambda") throw new HttpError(400, "Lambda computers use the runtime AWS credentials");
    const expected = input.provider === "modal" ? ["tokenId", "tokenSecret"] : input.provider === "tunnel" ? ["apiKey", "url"] : ["apiKey"];
    if (!input.credentials || expected.some(k => typeof input.credentials[k] !== "string" || !input.credentials[k].trim()) || Object.keys(input.credentials).some(k => ![...expected, ...(input.provider === "browserbase" ? ["projectId"] : [])].includes(k)) || Object.values(input.credentials).some(v => typeof v !== "string" || v.length > 16000)) throw new HttpError(400, `Credentials require ${expected.join(", ")}`);
    if (input.provider === "tunnel") {
      let url: URL;
      try { url = new URL(input.credentials.url); } catch { throw new HttpError(400, "Invalid tunnel URL"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new HttpError(400, "Tunnel URL must be an HTTPS origin");
      // Public reachability and DNS rebinding are checked again on every request by Outbound.
    }
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 60 || input.leaseSeconds > 900 || !Number.isInteger(input.dailySeconds) || input.dailySeconds < input.leaseSeconds || input.dailySeconds > 86400) throw new HttpError(400, "Invalid computer time limits");
    return this.insertConnection(tenant, { ...input, managed: false });
  }
  private async insertConnection(tenant: string, input: { agent: string; provider: Provider; credentials: Credentials; leaseSeconds: number; dailySeconds: number; managed: boolean; subagents?: boolean; forkable?: boolean }) {
    return this.lock(tenant, input.agent, async sql => {
      if (!(await sql.query("select 1 from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3)", [tenant, input.agent, this.now()])).rowCount) throw new HttpError(404, "Unknown agent");
      if ((await sql.query("select 1 from computer_connections where tenant=$1 and agent=$2", [tenant, input.agent])).rowCount) throw new HttpError(409, "This agent already has a computer connection");
      const connection = id();
      const row = (await sql.query("insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at,managed,subagents,forkable) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *", [connection, tenant, input.agent, input.provider, this.options.accounts.seal(`computer:${connection}`, JSON.stringify(input.credentials)), input.leaseSeconds, input.dailySeconds, this.now(), input.managed, input.subagents ?? true, input.forkable ?? null])).rows[0];
      return publicConnection(row);
    });
  }
  /**
   * Copy the parent's attachment in the transaction that creates its child: a new machine, never the parent's session.
   * `computer` is the delegate or spawn_agent call's choice: "none" attaches nothing; `{ seed }` (a fork snapshot this call
   * took, `forkSnapshot`) attaches a connection whose sessions start from that snapshot, whatever the parent's `subagents`.
   * The seed is locked (FOR SHARE) until the child's transaction ends, so a drop cannot take it meanwhile.
   */
  async inherit(tenant: string, parent: string, child: string, sql: Sql, computer?: "none" | "share" | { seed: string }) {
    if (computer === "none") return;
    if (computer === "share") {
      const owner = await computerOwner(sql, tenant, parent);
      if ((await sql.query("select 1 from computer_connections where tenant=$1 and agent=$2", [tenant, owner])).rowCount) await shareComputer(sql, tenant, parent, child);
      return;
    }
    parent = await computerOwner(sql, tenant, parent);
    const seed = computer?.seed ? await forkRows.attachable(sql, computer.seed, tenant) : undefined;
    if (computer?.seed && !seed) throw new HttpError(409, "The fork's snapshot is gone; fork again");
    const c = (await sql.query(seed ? "select * from computer_connections where tenant=$1 and id=$2 and agent not like 'removed:%' for share" : "select * from computer_connections where tenant=$1 and agent=$2 and subagents for share", [tenant, seed ? seed.connection : parent])).rows[0];
    if (!c) { if (seed) throw new HttpError(409, "The parent's computer connection was removed; nothing to fork"); return; }
    await this.attach(sql, tenant, child, c, seed);
  }
  /** A connection for `agent` with `c`'s provider and settings (credentials sealed for it), started from `seed` when forked. */
  private async attach(sql: Sql, tenant: string, agent: string, c: any, seed?: { id: string; agent: string; provider: string; created_at: string | number }) {
    const connection = id();
    // Credentials are sealed for each connection; the provider account is the same, the machine is new.
    const credentials = this.options.accounts.unseal(`computer:${c.id}`, c.credentials);
    const from: ForkedFrom | null = seed ? { agent: seed.agent, connection: c.id, snapshot: seed.id, provider: seed.provider, at: Number(seed.created_at) } : null;
    return (await sql.query("insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at,managed,subagents,seed,forked_from,forkable) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict (tenant,agent) do nothing returning *",
      [connection, tenant, agent, c.provider, this.options.accounts.seal(`computer:${connection}`, credentials), c.lease_seconds, c.daily_seconds, this.now(), c.managed, c.subagents, seed?.id ?? null, from && JSON.stringify(from), c.forkable ?? null])).rows[0];
  }
  /**
   * A fork snapshot of `parent`'s running computer for one call (`batch`): taken once, and the same for every child of
   * that call. Exact: the files as they are now. Answers the snapshot's id, for `inherit`. A provider that cannot snapshot
   * answers forkUnsupported (before anything else), a computer with no running session noSession. The call that wins
   * the batch's row takes the snapshot with no database connection held; its siblings wait for that row.
   */
  async forkSnapshot(tenant: string, parent: string, batch: string, retried = false): Promise<{ id: string; connection: string; provider: string; at: number }> {
    let c;
    try { c = await this.connection(tenant, parent); }
    catch (error) { if ((error as HttpError).status === 404) throw new HttpError(409, 'This agent has no computer to fork. Use computer: "fresh" or "none".', "NO_SESSION"); throw error; }
    const answer = (row: { id: string; provider: string; created_at: string | number }) => ({ id: row.id, connection: c.id, provider: row.provider, at: Number(row.created_at) });
    if (isBrowserProvider(c.provider) || (!c.managed && !forkableProvider(c.provider))) throw forkUnsupported(c.provider);
    if (!connectionForkable(c)) throw notForkable(c.provider);
    const snapshot = `cms_${randomUUID().replaceAll("-", "")}`, name = `camelrun-${snapshot}`;
    const claimed = await forkRows.claim(this.options.db, { id: snapshot, tenant, connection: c.id, agent: parent, batch, provider: c.managed ? this.managed.provider : c.provider, created_at: this.now() });
    if (!claimed.won) {
      if (claimed.row.state === "ready") return answer(claimed.row);
      const ready = await forkRows.waitReady(work => work(this.options.db), claimed.row.id, () => this.now(), ms => new Promise(resolve => setTimeout(resolve, ms)));
      if (ready) return answer(ready);
      // The call that won failed: try once more as the winner, so this call meets the same check (NO_SESSION, ...) itself.
      if (!retried) return this.forkSnapshot(tenant, parent, batch, true);
      throw new HttpError(502, "The computer's disk could not be snapshotted, so nothing was forked. Try again; if it keeps failing, use a fresh computer.");
    }
    let secret: SnapshotSecret | undefined;
    try {
      if (c.managed) {
        const taken = await this.managed.snapshot(c, name);
        secret = { ref: taken.ref, managed: true, platform: taken.platform, provider: taken.provider };
      } else {
        const credentials = JSON.parse(this.options.accounts.unseal(`computer:${c.id}`, c.credentials)) as Credentials;
        const lease = await this.latest(c.id);
        if (!lease || lease.state !== "active" || !lease.reference || Number(lease.expires_at) <= this.now()) throw noSession();
        const ref = await this.useProvider(c, async p => {
          if (!p.snapshot) throw forkUnsupported(c.provider);
          try { return await p.snapshot(JSON.parse(this.options.accounts.unseal(`computer-lease:${lease.id}`, lease.reference)), name); }
          catch (error) { throw snapshotFailed(c.provider, error); }
        });
        secret = { ref, managed: false, provider: c.provider, credentials };
      }
      const sealed = JSON.stringify(this.options.accounts.seal(`computer-snapshot:${snapshot}`, JSON.stringify(secret)));
      // A row cleared meanwhile (taken for longer than its claim): its snapshot has no row, so it is deleted now.
      if (!(await forkRows.ready(this.options.db, snapshot, sealed))) throw new HttpError(502, "The computer's disk took too long to snapshot, so nothing was forked. Try again.");
      console.error(JSON.stringify({ type: "computer_snapshot", tenant, agent: parent, snapshot, provider: secret.provider, ...secret.ref.sizeBytes !== undefined ? { bytes: secret.ref.sizeBytes } : {} }));
      return answer({ id: snapshot, provider: secret.provider, created_at: claimed.row.created_at });
    } catch (error) {
      await forkRows.abandon(this.options.db, snapshot).catch(() => {});
      // A snapshot the provider took has no row now: delete it, best effort.
      if (secret) await this.dropTaken(tenant, secret).catch(() => console.error(JSON.stringify({ type: "computer_snapshot_drop_failed", tenant, snapshot })));
      throw error;
    }
  }
  private async dropTaken(tenant: string, secret: SnapshotSecret) {
    if (secret.managed) return this.managed.dropSnapshot(tenant, { platform: !!secret.platform, provider: secret.provider }, secret.ref);
    const p = await (this.options.driver ?? driver)(secret.provider as Provider, secret.credentials ?? {}, this.options.outbound, { boatUrl: this.options.boatUrl });
    try { await p.dropSnapshot?.(secret.ref); } finally { await p.dispose?.(); }
  }
  /**
   * Fork `source`'s computer (an agent, or a connection id) into other agents of the tenant: one snapshot, and for each
   * agent a connection that starts from it, all in one transaction. Each must have no computer connection of its own yet.
   */
  async forkInto(tenant: string, source: { agent?: string; connection?: string }, agents: string[]) {
    const from = source.connection
      ? (await this.options.db.query("select agent from computer_connections where tenant=$1 and id=$2 and agent not like 'removed:%'", [tenant, source.connection])).rows[0]?.agent as string | undefined
      : source.agent;
    if (!from) throw new HttpError(404, "Unknown computer connection");
    if (!(await this.options.db.query("select 1 from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3)", [tenant, from, this.now()])).rowCount) throw new HttpError(404, "Unknown agent");
    const check = async (sql: Sql, agent: string) => {
      if (agent === from) throw new HttpError(400, "An agent cannot fork its computer into itself");
      if (!(await sql.query("select 1 from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3)", [tenant, agent, this.now()])).rowCount) throw new HttpError(404, `Unknown agent ${agent}`);
      if ((await sql.query("select 1 from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rowCount) throw new HttpError(409, `Agent ${agent} already has a computer connection; remove it first`);
    };
    for (const agent of agents) await check(this.options.db, agent);
    const snapshot = await this.forkSnapshot(tenant, from, `api:${randomUUID()}`);
    const forks = await transaction(this.options.db, async sql => {
      const seed = await forkRows.attachable(sql, snapshot.id, tenant);
      const c = (await sql.query("select * from computer_connections where tenant=$1 and id=$2 and agent not like 'removed:%' for share", [tenant, snapshot.connection])).rows[0];
      if (!seed || !c) throw new HttpError(409, "The source's computer connection was removed; nothing to fork");
      const made = [];
      for (const agent of agents) {
        await check(sql, agent);
        const row = await this.attach(sql, tenant, agent, c, seed);
        if (!row) throw new HttpError(409, `Agent ${agent} already has a computer connection; remove it first`);
        made.push(publicConnection(row));
      }
      return made;
    }, { rerun: false }).catch(async error => { await this.dropIfUnused(snapshot.id); throw error; });
    return { snapshot: { id: snapshot.id, provider: snapshot.provider, createdAt: snapshot.at }, forks };
  }
  /** A child's computer when its work is done (a delegate call answered, failed or was stopped): its session stops, its connection stays. */
  async release(tenant: string, agent: string) {
    const c = (await this.options.db.query("select id from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rows[0];
    if (!c) return;
    try { await this.call(tenant, agent, "computer_stop", {}, `release-${randomUUID()}`); }
    catch { console.error(JSON.stringify({ type: "computer_release_failed", tenant, agent })); }
  }
  /** The snapshot a forked connection's sessions start from. */
  private async seedOf(c: any): Promise<SnapshotRef | undefined> {
    if (!c.seed) return undefined;
    const row = await forkRows.get(this.options.db, c.seed);
    if (!row || row.dropped_at !== null || row.state !== "ready") throw new HttpError(409, "This computer was forked from a snapshot that is gone. Its owner can remove the connection and connect it again.");
    return snapshotRef((JSON.parse(this.options.accounts.unseal(`computer-snapshot:${row.id}`, JSON.parse(row.reference))) as SnapshotSecret).ref);
  }
  /** Drop a snapshot nothing attached to (a fork route whose attach failed). */
  private async dropIfUnused(id: string) {
    const row = await forkRows.get(this.options.db, id);
    if (row && row.dropped_at === null && row.state === "ready") await this.drop(row);
  }
  /**
   * Delete a fork snapshot no connection starts from any more (`force`: whatever starts from it, for account deletion).
   * The row is locked while the provider deletes it, and checked again under the lock. A failure backs off and is
   * tried again by the sweep; past the last attempt it is given up and logged. Answers whether it is gone.
   */
  private async drop(row: { id: string; tenant: string }, force = false) {
    try {
      return await transaction(this.options.db, async sql => {
        const current = await forkRows.lockForDrop(sql, row.id, force);
        if (!current) return false;
        const secret = JSON.parse(this.options.accounts.unseal(`computer-snapshot:${current.id}`, JSON.parse(current.reference))) as SnapshotSecret, ref = snapshotRef(secret.ref);
        if (secret.managed) await this.managed.dropSnapshot(current.tenant, { platform: !!secret.platform, provider: secret.provider }, ref);
        else {
          const p = await (this.options.driver ?? driver)(secret.provider as Provider, secret.credentials ?? {}, this.options.outbound, { boatUrl: this.options.boatUrl });
          try { await p.dropSnapshot?.(ref); } finally { await p.dispose?.(); }
        }
        await forkRows.dropped(sql, current.id, this.now());
        return true;
      }, { rerun: false });
    } catch (error) {
      const gaveUp = await forkRows.failed(this.options.db, row.id, (error as Error).message ?? "drop failed", this.now()).catch(() => false);
      console.error(JSON.stringify({ type: gaveUp ? "computer_snapshot_abandoned" : "computer_snapshot_drop_failed", tenant: row.tenant, snapshot: row.id }));
      return false;
    }
  }
  /** Detach on deletion or expiry, keeping the ordinary metering history and cleanup retries. */
  async removeAgent(tenant: string, agent: string) {
    const rows = (await this.options.db.query("select id from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rows;
    for (const row of rows) await this.remove(tenant, row.id);
  }
  private provider(connection: any) { return (this.options.driver ?? driver)(connection.provider, JSON.parse(this.options.accounts.unseal(`computer:${connection.id}`, connection.credentials)), this.options.outbound, { boatUrl: this.options.boatUrl }); }
  private async useProvider<T>(connection: any, fn: (value: ComputerDriver) => Promise<T>) {
    const value = await this.provider(connection);
    try { return await fn(value); } finally { await value.dispose?.(); }
  }
  private async connection(tenant: string, agent: string, sql: any = this.options.db) {
    agent = await computerOwner(sql, tenant, agent);
    const row = (await sql.query("select c.* from computer_connections c join agents a on a.id=c.agent and a.tenant=c.tenant where c.tenant=$1 and c.agent=$2 and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at>$3)", [tenant, agent, this.now()])).rows[0];
    if (!row) throw new HttpError(404, "No computer connected to this agent");
    return row;
  }
  private async latest(connection: string, sql: any = this.options.db) { return (await sql.query("select * from computer_leases where connection=$1 order by sequence desc limit 1", [connection])).rows[0]; }
  async tools(tenant: string, agent: string) {
    agent = await computerOwner(this.options.db, tenant, agent);
    const c = (await this.options.db.query("select provider,managed from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rows[0];
    if (c?.managed) return this.options.enabled ? managedTools(COMMON, SHELL, tool, text) : [];
    return c ? [...COMMON, ...(isBrowserProvider(c.provider) ? BROWSER : SHELL)] : [];
  }
  async status(tenant: string, agent: string) { const c = await this.connection(tenant, agent), session = c.managed ? await this.managed.session(c.id) : publicLease(await this.latest(c.id)); return { connection: { ...publicConnection(c), session }, session }; }
  private async stop(connection: any, lease: any, sql: any) {
    if (!lease || lease.state === "closed") return;
    await sql.query("update computer_leases set state='closing',cleanup_at=$2 where id=$1", [lease.id, this.now()]);
    if (!lease.reference) {
      // A provider may have accepted a create whose response was lost. Never create another
      // automatically; keep the uncertain record visible for provider-side reconciliation.
      await sql.query("update computer_leases set state='uncertain',error=$2 where id=$1", [lease.id, "Creation outcome unknown; check the provider before removing this connection"]);
      throw new HttpError(409, "Computer creation outcome unknown. Stopping cannot clear this. Its owner must check the provider account and confirm cleanup in the Computers console; tell the user.");
    }
    const reference: Reference = JSON.parse(this.options.accounts.unseal(`computer-lease:${lease.id}`, lease.reference));
    try { await this.useProvider(connection, p => p.close(reference)); }
    catch { await sql.query("update computer_leases set error='Cleanup failed; retrying' where id=$1", [lease.id]); throw new HttpError(502, "Computer cleanup failed; it will be retried"); }
    await sql.query("update computer_leases set state='closed',closed_at=$2,reference=null,error=null where id=$1", [lease.id, this.now()]);
    await releaseComputer(sql, connection.tenant, connection.id);
  }
  async remove(tenant: string, connectionId: string) {
    const c = (await this.options.db.query("select * from computer_connections where tenant=$1 and id=$2", [tenant, connectionId])).rows[0];
    if (!c) throw new HttpError(404, "Unknown computer connection");
    if (c.managed) await this.managed.remove(c.id);
    const removed = await this.lock(tenant, c.agent, async sql => {
      for (const lease of (await sql.query("select * from computer_leases where connection=$1 and state<>'closed'", [c.id])).rows) await this.stop(c, lease, sql);
      // Keep metering history, but erase credentials and detach tools. Historical leases retain no provider credentials.
      await sql.query("update computer_connections set agent=$2,credentials=$3 where id=$1", [c.id, `removed:${c.id}`, this.options.accounts.seal(`computer:${c.id}`, "{}")]);
      return { removed: true };
    });
    // The last connection started from a fork snapshot takes it with it, once its call's siblings had time to attach (else the sweep does).
    const orphan = c.seed ? await forkRows.orphaned(this.options.db, c.seed, this.now() - FORK_LIMITS.dropGraceMs) : undefined;
    if (orphan) await this.drop(orphan);
    return removed;
  }
  async confirmCleanup(tenant: string, agent: string) {
    return this.lock(tenant, agent, async sql => {
      const c = await this.connection(tenant, agent, sql);
      if (c.agent !== agent) throw new HttpError(409, SHARED_COMPUTER_CONTROL);
      const lease = await this.latest(c.id, sql);
      if (!lease || !["uncertain", "closing"].includes(lease.state)) throw new HttpError(409, "Only a failed creation or cleanup can be confirmed manually");
      await sql.query("update computer_leases set state='closed',closed_at=$2,reference=null,error=null where id=$1", [lease.id, this.now()]);
      await releaseComputer(sql, tenant, c.id);
      return { confirmed: true };
    });
  }
  async call(tenant: string, agent: string, name: string, args: Record<string, any>, requestKey: string, files?: Pick<ToolContext, "mounts" | "onWrite">, receiptsOnly = false) {
    if (!COMPUTER_TOOLS.has(name)) throw new HttpError(400, "Unknown computer tool");
    const connection = await this.connection(tenant, agent);
    const shared = connection.agent !== agent;
    if (shared && ["computer_start", "computer_stop"].includes(name)) throw new HttpError(409, SHARED_COMPUTER_CONTROL);
    if (shared) requestKey = `${agent}:${requestKey}`;
    if (connection.managed) {
      if (!SHELL.concat(COMMON).some(t => t.name === name)) throw new HttpError(400, "Tool not supported by this computer");
      const input = JSON.stringify([name, args]);
      if (input.length > 40000) throw new HttpError(400, "Computer tool input too large");
      return this.managed.call(connection, tenant, connection.agent, name, args, requestKey, createHash("sha256").update(input).digest("hex"), files, receiptsOnly, name === "computer_start" ? await this.seedOf(connection) : undefined, shared);
    }
    return this.lock(tenant, agent, async sql => {
      const c = await this.connection(tenant, agent, sql);
      if (!(isBrowserProvider(c.provider) ? [...COMMON, ...BROWSER] : [...COMMON, ...SHELL]).some(t => t.name === name)) throw new HttpError(400, "Tool not supported by this computer");
      const hash = createHash("sha256").update(JSON.stringify([name, args])).digest("hex");
      const old = (await sql.query("select * from computer_operations where connection=$1 and key=$2", [c.id, requestKey])).rows[0];
      if (old) {
        if (old.input_hash !== hash) throw new HttpError(409, "Retried computer operation changed");
        if (old.state !== "completed") throw new HttpError(409, "Previous operation has an uncertain outcome; inspect status before retrying");
        return old.result;
      }
      if (name !== "computer_status") await sql.query("insert into computer_operations(connection,key,input_hash,state,tenant) values($1,$2,$3,'pending',$4)", [c.id, requestKey, hash, tenant]);
      const execute = async () => {
      let lease = await this.latest(c.id, sql);
      if (name === "computer_status") return publicLease(lease);
      if (name === "computer_stop") { await this.stop(c, lease, sql); return { stopped: true }; }
      if (shared && (!lease || lease.state !== "active" || lease.expires_at <= this.now())) throw new HttpError(409, SHARED_COMPUTER_STOPPED, "COMPUTER_STOPPED");
      if (lease && lease.state !== "closed" && lease.expires_at <= this.now()) { await this.stop(c, lease, sql); lease = undefined; }
      if (name === "computer_start") {
        if (lease && lease.state !== "closed") { if (lease.state !== "active") throw new HttpError(409, "This computer is waiting on an earlier operation, which may need its owner to confirm cleanup in the Computers console. Do not retry in this turn; tell the user."); return publicLease(lease); }
        const used = (await sql.query("select coalesce(sum(greatest(0,least(coalesce(closed_at,expires_at),expires_at)-greatest(created_at,$2))),0) as used from computer_leases where connection=$1 and expires_at > $2", [c.id, Math.floor(this.now()/86400000)*86400000])).rows[0].used;
        if (Number(used) + c.lease_seconds*1000 > c.daily_seconds*1000) throw new HttpError(429, "Computer daily time budget reached");
        // A forked connection's every new session starts from its seed, the parent's disk as it was at the fork.
        const from = await this.seedOf(c);
        await transaction(this.options.db, db => reserveComputer(db, tenant, c.agent, c.id, this.now() + c.lease_seconds * 1000, this.now(), this.options.tenantComputerLimit?.(tenant)));
        const session = id(), now = this.now(), workspace = await new Workspaces(this.options.db).current(tenant, "agent", agent, sql);
        lease = (await sql.query("insert into computer_leases(id,tenant,agent,connection,workspace,provider,state,created_at,expires_at) values($1,$2,$3,$4,$5,$6,'starting',$7,$8) returning *", [session, tenant, agent, c.id, workspace?.workspace ?? null, c.provider, now, now+c.lease_seconds*1000])).rows[0];
        let creator: ComputerDriver | undefined, allocated = false;
        try {
          const ref = await this.useProvider(c, p => { creator = p; return p.create(session, c.lease_seconds, async ref => { allocated = true; await sql.query("update computer_leases set reference=$2 where id=$1", [session, this.options.accounts.seal(`computer-lease:${session}`, JSON.stringify(ref))]); }, { ...from ? { from } : {}, forkable: connectionForkable(c) }); });
          await sql.query("update computer_leases set state='active',reference=$2 where id=$1", [session, this.options.accounts.seal(`computer-lease:${session}`, JSON.stringify(ref))]);
        } catch (error) {
          // A provider that refused the credentials made nothing: no machine to reconcile, and a fixed key can start again.
          if (!allocated && creator?.refused?.(error)) {
            await sql.query("update computer_leases set state='closed',closed_at=$2,error='Provider refused the credentials' where id=$1", [session, this.now()]);
            await releaseComputer(sql, tenant, c.id);
            throw new HttpError(502, "The computer provider refused its credentials, and nothing was created. Do not retry in this turn. Tell the user that its owner needs to reconnect the computer with a working key in the Computers console.");
          }
          await sql.query("update computer_leases set state='uncertain',error='Creation outcome unknown' where id=$1", [session]); throw new HttpError(502, "Computer could not be created, and the provider may have made a machine. Do not retry in this turn. Tell the user the computer is unavailable and that its owner may need to check the provider account and confirm cleanup in the Computers console.");
        }
        return publicLease({ ...lease, state: "active" });
      }
      if (!lease || lease.state !== "active") throw new HttpError(409, "Call computer_start before using the computer");
      const input = JSON.stringify([name, args]);
      if (input.length > 40000) throw new HttpError(400, "Computer tool input too large");
      const previous = (await sql.query("select * from computer_commands where lease=$1 and key=$2", [lease.id, requestKey])).rows[0];
      if (previous) { if (previous.input_hash !== hash) throw new HttpError(409, "Retried computer call changed"); if (previous.state !== "completed") throw new HttpError(409, "Previous command outcome unknown; inspect the computer before retrying"); return previous.result; }
      let command = args.command;
      command = fileCommand(name, args) ?? command;
      if (!isBrowserProvider(c.provider) && (typeof command !== "string" || !command || command.length > 32000)) throw new HttpError(400, "Invalid command");
      const timeout = args.timeoutSeconds ?? 60;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) throw new HttpError(400, "Command timeout must be 1–120 seconds");
      await sql.query("insert into computer_commands(lease,key,input_hash,state,created_at,tenant) values($1,$2,$3,'pending',$4,$5)", [lease.id, requestKey, hash, this.now(), tenant]);
      try {
        const ref = JSON.parse(this.options.accounts.unseal(`computer-lease:${lease.id}`, lease.reference));
        const seconds = Math.max(1, Math.min(timeout, Math.floor((lease.expires_at-this.now())/1000)));
        const value = await this.useProvider(c, p => {
          return p.call(ref, name, { ...args, command, timeoutSeconds: seconds, requestKey, remainingSeconds: Math.max(1, Math.floor((lease.expires_at-this.now())/1000)) });
        });
        const result = storable(receiptsOnly ? fileReceipts(value) : value);
        await sql.query("update computer_commands set state='completed',result=$3 where lease=$1 and key=$2", [lease.id, requestKey, JSON.stringify(result)]);
        return result;
      } catch (error) { await sql.query("update computer_commands set state='uncertain' where lease=$1 and key=$2", [lease.id, requestKey]); throw new HttpError(502, "Computer command failed; outcome may be uncertain"); }
      };
      try {
        const result = await execute();
        if (name !== "computer_status") await sql.query("update computer_operations set state='completed',result=$3 where connection=$1 and key=$2", [c.id, requestKey, JSON.stringify(result)]);
        return result;
      } catch (error) {
        if (name !== "computer_status") await sql.query("update computer_operations set state='uncertain' where connection=$1 and key=$2", [c.id, requestKey]);
        throw computerToolError(error);
      }
    });
  }
  /** A live filesystem handle. Every command still goes through metering and lease checks. */
  async filesystem(tenant: string, agent: string): Promise<ComputerMount | null | undefined> {
    let status;
    try { status = await this.status(tenant, agent); }
    catch (error) { if ((error as HttpError).status === 404) return undefined; throw error; }
    if (isBrowserProvider(status.connection.provider)) return undefined;
    const session = status.session;
    if (!session || session.state !== "active" || session.expiresAt <= this.now()) return null;
    const exec = (command: string, receiptsOnly = false) => this.call(tenant, agent, "computer_exec", { command, timeoutSeconds: 120 }, randomUUID(), undefined, receiptsOnly);
    return {
      id: session.id,
      exec,
      transfer: async (context, upload, args) => {
        if (!this.options.transfers) throw new Error("Computer transfers are not enabled");
        const remote = (value: string) => `.${value.startsWith("/") ? value : `/${value}`}`;
        return this.options.transfers.run(context, upload, upload ? { ...args, to: remote(args.to) } : { ...args, from: remote(args.from) },
          { call: (_ref, _name, call) => exec(`cd "$HOME" && ${call.command}`, true) }, { id: session.id }, 120, randomUUID());
      },
    };
  }
  async usage(tenant: string) {
    const { rows } = await this.options.db.query("select workspace,provider,count(*)::integer as sessions,sum(greatest(0,least(coalesce(closed_at,$2),expires_at)-created_at))/1000.0 as seconds from computer_leases where tenant=$1 group by workspace,provider", [tenant, this.now()]);
    return [...rows.map(row => ({ ...row, costUsd: 0 })), ...await this.managed.usage(tenant)];
  }
  async sweep() {
    const gone = (await this.options.db.query("select c.tenant,c.agent from computer_connections c left join agents a on a.id=c.agent and a.tenant=c.tenant where c.agent not like 'removed:%' and (a.id is null or a.revoked or a.purged_at is not null or a.expires_at<=$1) limit 100", [this.now()])).rows;
    for (const c of gone) {
      try { await this.removeAgent(c.tenant, c.agent); } catch { /* Keep credentials until cleanup succeeds; retry next sweep. */ }
    }
    await this.managed.pass().catch(() => console.error(JSON.stringify({ type: "computer_pass_failed" })));
    // Fork snapshots no connection starts from any more (a failed drop, or a fork whose children never attached).
    for (const row of await forkRows.unused(this.options.db, this.now() - FORK_LIMITS.dropGraceMs, this.now()).catch(() => [])) await this.drop(row);
    const rows = (await this.options.db.query("select l.*, c.credentials, c.id as connection_id from computer_leases l join computer_connections c on c.id=l.connection left join agents a on a.id=l.agent and a.tenant=l.tenant where (l.state='closing' or (l.state='uncertain' and l.reference is not null) or (l.state='starting' and l.created_at<=$1::bigint-180000) or (l.state='active' and (l.expires_at<=$1 or a.id is null or a.revoked or a.purged_at is not null or a.expires_at<=$1))) order by l.cleanup_at, l.expires_at limit 100", [this.now()])).rows;
    for (const row of rows) {
      try { await this.lock(row.tenant, row.agent, async sql => { const current = (await sql.query("select * from computer_leases where id=$1", [row.id])).rows[0]; if (current.state === "closed" || (current.state === "active" && current.expires_at > this.now() && row.state !== "active")) return; await this.stop({ ...row, id: row.connection_id }, current, sql); }); } catch { /* Durable closing state retries next sweep. No credentials in logs. */ }
    }
  }
}
