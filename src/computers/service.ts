import { createHash, randomUUID } from "node:crypto";
import type { Accounts } from "../accounts.ts";
import type { Db, DbClient } from "../db.ts";
import { HttpError } from "../http.ts";
import { MICROS } from "../pricing.ts";
import type { Outbound } from "../outbound.ts";
import type { ToolDefinition } from "../protocol.ts";
import { Workspaces } from "../workspaces.ts";
import type { ToolContext } from "../volume-tools.ts";
import { resolveKey } from "../capabilities/router.ts";
import type { ComputerTransfers } from "./transfers.ts";
import { machineSetup, signatures } from "./abuse.ts";
import { LeaseMeter } from "./metering.ts";
import { driver, isBrowserProvider, PROVIDERS, type Credentials, type DriverFactory, type ComputerDriver, type Provider, type Reference, type Unavailable } from "./providers.ts";

const id = () => `cmp_${randomUUID().replaceAll("-", "")}`;
const parameters = (properties = {}, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string", minLength: 1, maxLength: 32000 };
const tool = (name: string, description: string, props = {}, required: string[] = []): ToolDefinition => ({ name, description, timeoutMs: 180000, exposure: "both", parameters: parameters(props, required) });
const COMMON = [tool("computer_start", "Start your attached computer or return its current session. Files and processes survive across turns until its fixed expiry. A new session after expiry starts empty."), tool("computer_status", "Read your computer's session and fixed expiry; does not start one."), tool("computer_stop", "Stop your attached computer and discard its session files. Call this when the task is finished and no follow-up needs it, after copying results out with computer_download.")];
const SHELL = [tool("computer_exec", "Call computer_start first. Run a shell command in your attached remote Linux computer, never on the camelRun host. Inspect exitCode. Redirect output for background processes. Files survive between calls until expiry.", { command: text, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 } }, ["command"]), tool("computer_write_file", "Write a UTF-8 file in your remote computer. This is separate from camelRun workspace files.", { path: text, content: { type: "string", maxLength: 16000 } }, ["path", "content"]), tool("computer_read_file", "Read up to 24000 characters from a UTF-8 file in your remote computer.", { path: text }, ["path"])];
SHELL.push(tool("computer_upload", "Copy a workspace file to your remote computer without reading its contents into context. Returns path, size in bytes and sha256.", { from: text, to: text }, ["from", "to"]), tool("computer_download", "Copy a remote computer file to your workspace or a mount without reading its contents into context. Returns path, size in bytes and sha256. Your workspace and mounts are not on the computer, so cp or redirects there do not reach them; only this tool saves there. If it refuses, tell the user where the file is.", { from: text, to: text }, ["from", "to"]));
const BROWSER = [tool("browser_navigate", "Navigate your attached remote browser to an HTTP(S) URL.", { url: text }, ["url"]), tool("browser_read", "Read the current remote page's title, URL and visible text."), tool("browser_click", "Click a CSS selector in the remote page.", { selector: text }, ["selector"]), tool("browser_fill", "Fill a CSS-selected input in the remote page.", { selector: text, text: { type: "string", maxLength: 16000 } }, ["selector", "text"]), tool("browser_evaluate", "Run JavaScript in the remote web page and return a JSON result. No host shell or filesystem access.", { expression: text }, ["expression"])];
/** A managed computer's limits: how long its command may run, how long it stays after its latest command unless the connection says, and at most. */
const MANAGED = { provider: "boat" as const, commandSeconds: 1800, defaultCommandSeconds: 600, idleSeconds: 7200, maxSeconds: 86400, dailySeconds: 86400 };
/** Its tools say what a managed computer is for; the rest are a provider connection's. */
const MANAGED_COMMON = COMMON.map(t => t.name === "computer_start" ? tool("computer_start", "Start your attached computer or return its current session. Its files stay until it is released: 2 hours after your latest command, or 24 hours after it started. A new session after that starts empty.")
  : t.name === "computer_status" ? tool("computer_status", "Read your computer's session and when it will be released; does not start one.") : t);
const MANAGED_SHELL = SHELL.map(t => t.name !== "computer_exec" ? t : { ...tool("computer_exec", `Call computer_start first. Run a shell command in your attached remote Linux computer, never on the camelRun host. Inspect exitCode. This computer is for short-lived work, so a background process doesn't keep running after its command ends. Run work in the foreground and wait for it, with timeoutSeconds long enough for it (default ${MANAGED.defaultCommandSeconds}, at most ${MANAGED.commandSeconds}). Files stay until the computer is released.`, { command: text, timeoutSeconds: { type: "integer", minimum: 1, maximum: MANAGED.commandSeconds } }, ["command"]), timeoutMs: (MANAGED.commandSeconds + 60) * 1000 });
/** How long after its machine is made a lease must have been told, before the machine counts as a leak. */
const RECONCILE_AFTER_MS = 10 * 60_000;
/** Waits before trying a provider that made nothing again, by attempt: short enough to hold a start's connection. */
const START_RETRIES: Record<string, number[]> = { out_of_capacity: [5000, 10000], no_ready_machine: [5000, 10000] };
/** The most to wait for a start the provider says it will take after this long. */
const START_WAIT_MS = 15000;
/** What an agent is told when a managed computer could not start; nothing was created or charged. */
const unavailableMessage = ({ code, retryAfterMs }: Unavailable) => {
  const nothing = "Nothing was created or charged.";
  if (code === "rate_limited") return `Too many computers were started just now. ${nothing} Call computer_start again${retryAfterMs ? ` in about ${Math.ceil(retryAfterMs / 1000)} seconds` : " in a few minutes"}; if it keeps failing, tell the user computers are busy.`;
  if (code === "limit_reached" || code === "member_limit_reached") return `Too many computers are running right now. ${nothing} Call computer_start again in a few minutes; if it keeps failing, tell the user computers are busy.`;
  if (code === "billing_required") return `Computers are unavailable right now. ${nothing} Do not retry in this turn. Tell the user computers are unavailable and that the runtime's operator needs to look at it.`;
  return `The computer provider has no machines free right now. ${nothing} Call computer_start again in a couple of minutes; if it keeps failing, tell the user computers are unavailable for now.`;
};
type AfterLock = (() => Promise<void>)[];
class StartUnavailable extends Error {
  readonly unavailable: Unavailable;
  constructor(unavailable: Unavailable) { super(unavailable.code); this.unavailable = unavailable; }
}
/** A managed computer's command, to run once the agent's lock is let go: it may take half an hour, and holds no connection meanwhile. */
class Later {
  readonly run: () => Promise<any>;
  constructor(run: () => Promise<any>) { this.run = run; }
}
export const COMPUTER_TOOLS = new Set([...COMMON, ...SHELL, ...BROWSER].map(t => t.name));
const publicConnection = (r: any) => ({ id: r.id, agent: r.agent, provider: r.provider, managed: !!r.managed, leaseSeconds: r.lease_seconds, dailySeconds: r.daily_seconds, createdAt: r.created_at, billing: r.managed ? "credits" : "provider_account", session: publicLease(r.lease) });
const publicLease = (r: any) => r ? ({ id: r.id, provider: r.provider, workspaceId: r.workspace, state: r.state, recoveryRequired: r.state === "uncertain" || r.state === "closing" && !!r.error, createdAt: r.created_at, expiresAt: r.expires_at, closedAt: r.closed_at, ...(r.error ? { error: r.error } : {}) }) : null;

export class Computers {
  readonly options: { db: Db; accounts: Pick<Accounts, "seal" | "unseal" | "tenants" | "providerKey"> & LeaseMeter["options"]["accounts"]; outbound: Outbound; transfers?: ComputerTransfers; driver?: DriverFactory; now?: () => number; endUsers?: LeaseMeter["options"]["endUsers"]; payer?: LeaseMeter["options"]["payer"];
    /** Whether agents may have managed computers (AGENT_MANAGED_COMPUTERS). */
    managed?: boolean;
    sleep?(ms: number): Promise<void> };
  private readonly meter: LeaseMeter;
  constructor(options: Computers["options"]) {
    this.options = options;
    this.meter = new LeaseMeter({ db: options.db, accounts: options.accounts, get endUsers() { return options.endUsers; }, payer: agent => options.payer?.(agent), now: () => this.now() });
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  /** `after`: what to do once this lock is let go, as it takes other connections, which many at once on a node would otherwise all wait for. */
  private async lock<T>(tenant: string, agent: string, fn: (sql: DbClient, after: AfterLock) => Promise<T>) {
    const sql = await this.options.db.connect(), after: AfterLock = [];
    try {
      await sql.query("select pg_advisory_lock(hashtextextended($1, 0))", [`computer:${tenant}:${agent}`]);
      // Deliberately no retrying SQL transaction around an external mutation.
      return await fn(sql, after);
    } finally {
      try { await sql.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`computer:${tenant}:${agent}`]); } finally { sql.release(); }
      for (const job of after) await job().catch(() => console.error(JSON.stringify({ type: "computer_meter_failed" })));
    }
  }
  async revision(tenant: string, agent: string) { return (await this.options.db.query("select id from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rows[0]?.id ?? ""; }
  async removeTenant(tenant: string) { for (const c of await this.list(tenant)) await this.remove(tenant, c.id); }
  async list(tenant: string) { return (await this.options.db.query("select c.*, row_to_json(l) as lease from computer_connections c left join lateral (select * from computer_leases where connection=c.id order by sequence desc limit 1) l on true where c.tenant = $1 and c.agent not like 'removed:%' order by c.created_at", [tenant])).rows.map(publicConnection); }
  /** Connect an agent to a provider with its credentials, or, with none, to a managed computer. */
  async create(tenant: string, input: { agent: string; provider: Provider; credentials?: Credentials; leaseSeconds?: number; dailySeconds?: number }) {
    if (!PROVIDERS.includes(input.provider)) throw new HttpError(400, "Unknown computer provider");
    if (input.credentials === undefined && input.provider === MANAGED.provider) return this.createManaged(tenant, { ...input, provider: MANAGED.provider });
    return this.createWithCredentials(tenant, { leaseSeconds: 900, dailySeconds: 3600, ...input, credentials: input.credentials as Credentials });
  }
  private async createManaged(tenant: string, input: { agent: string; provider: Provider; leaseSeconds?: number; dailySeconds?: number }) {
    if (!this.options.managed) throw new HttpError(403, "Managed computers are not available on this runtime");
    const { leaseSeconds = MANAGED.idleSeconds, dailySeconds = MANAGED.dailySeconds } = input;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > MANAGED.maxSeconds || !Number.isInteger(dailySeconds) || dailySeconds < leaseSeconds || dailySeconds > 86400) throw new HttpError(400, "Invalid computer time limits");
    return this.insertConnection(tenant, { ...input, credentials: {}, leaseSeconds, dailySeconds, managed: true });
  }
  private async createWithCredentials(tenant: string, input: { agent: string; provider: Provider; credentials: Credentials; leaseSeconds: number; dailySeconds: number }) {
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
  private async insertConnection(tenant: string, input: { agent: string; provider: Provider; credentials: Credentials; leaseSeconds: number; dailySeconds: number; managed: boolean }) {
    return this.lock(tenant, input.agent, async sql => {
      if (!(await sql.query("select 1 from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3)", [tenant, input.agent, this.now()])).rowCount) throw new HttpError(404, "Unknown agent");
      if ((await sql.query("select 1 from computer_connections where tenant=$1 and agent=$2", [tenant, input.agent])).rowCount) throw new HttpError(409, "This agent already has a computer connection");
      const connection = id();
      const row = (await sql.query("insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at,managed) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *", [connection, tenant, input.agent, input.provider, this.options.accounts.seal(`computer:${connection}`, JSON.stringify(input.credentials)), input.leaseSeconds, input.dailySeconds, this.now(), input.managed])).rows[0];
      return publicConnection(row);
    });
  }
  private async provider(connection: any, lease?: any) {
    const credentials = connection.managed ? { apiKey: await this.managedKey(connection.tenant, lease) } : JSON.parse(this.options.accounts.unseal(`computer:${connection.id}`, connection.credentials));
    return (this.options.driver ?? driver)(connection.provider, credentials, this.options.outbound, connection.managed ? { managed: true, tenant: connection.tenant, setup: machineSetup() } : { managed: false });
  }
  /** The key a managed lease's machine was made with: the platform's for one on the platform's key, whatever the tenant has since, else the admin's for the tenant. */
  private async managedKey(tenant: string, lease: any) {
    const { accounts } = this.options;
    const key = lease?.platform ? accounts.tenants.platformKey(MANAGED.provider) : (await accounts.providerKey(tenant, MANAGED.provider))?.key;
    if (!key) throw new Error("No key for this computer");
    return key;
  }
  private async useProvider<T>(connection: any, fn: (value: ComputerDriver) => Promise<T>, lease?: any) {
    const value = await this.provider(connection, lease);
    try { return await fn(value); } finally { await value.dispose?.(); }
  }
  private async connection(tenant: string, agent: string, sql: any = this.options.db) {
    const row = (await sql.query("select c.* from computer_connections c join agents a on a.id=c.agent and a.tenant=c.tenant where c.tenant=$1 and c.agent=$2 and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at>$3)", [tenant, agent, this.now()])).rows[0];
    if (!row) throw new HttpError(404, "No computer connected to this agent");
    return row;
  }
  private async latest(connection: string, sql: any = this.options.db) { return (await sql.query("select * from computer_leases where connection=$1 order by sequence desc limit 1", [connection])).rows[0]; }
  async tools(tenant: string, agent: string) {
    const c = (await this.options.db.query("select provider,managed from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rows[0];
    if (c?.managed) return this.options.managed ? [...MANAGED_COMMON, ...MANAGED_SHELL] : [];
    return c ? [...COMMON, ...(isBrowserProvider(c.provider) ? BROWSER : SHELL)] : [];
  }
  async status(tenant: string, agent: string) { const c = await this.connection(tenant, agent), session = publicLease(await this.latest(c.id)); return { connection: { ...publicConnection(c), session }, session }; }
  private async stop(connection: any, lease: any, sql: any, after: AfterLock) {
    if (!lease || lease.state === "closed") return;
    if (lease.platform) {
      const charged = await this.meter.accrue(lease.id, true, sql);
      // The next sweep settles it if this fails: the machine still has to go.
      after.push(async () => { if (charged) await this.options.accounts.usageCommitted(charged); await this.meter.settle(lease.id); });
    }
    await sql.query("update computer_leases set state='closing',cleanup_at=$2 where id=$1", [lease.id, this.now()]);
    if (!lease.reference) {
      // A provider may have accepted a create whose response was lost. Never create another
      // automatically; keep the uncertain record visible for provider-side reconciliation.
      await sql.query("update computer_leases set state='uncertain',error=$2 where id=$1", [lease.id, "Creation outcome unknown; check the provider before removing this connection"]);
      throw new HttpError(409, "Computer creation outcome unknown. Stopping cannot clear this. Its owner must check the provider account and confirm cleanup in the Computers console; tell the user.");
    }
    const reference: Reference = JSON.parse(this.options.accounts.unseal(`computer-lease:${lease.id}`, lease.reference));
    try { await this.useProvider(connection, p => p.close(reference), lease); }
    catch { await sql.query("update computer_leases set error='Cleanup failed; retrying' where id=$1", [lease.id]); throw new HttpError(502, "Computer cleanup failed; it will be retried"); }
    await sql.query("update computer_leases set state='closed',closed_at=$2,reference=null,error=null where id=$1", [lease.id, this.now()]);
  }
  async remove(tenant: string, connectionId: string) {
    const c = (await this.options.db.query("select * from computer_connections where tenant=$1 and id=$2", [tenant, connectionId])).rows[0];
    if (!c) throw new HttpError(404, "Unknown computer connection");
    return this.lock(tenant, c.agent, async (sql, after) => {
      for (const lease of (await sql.query("select * from computer_leases where connection=$1 and state<>'closed'", [c.id])).rows) await this.stop(c, lease, sql, after);
      // Keep metering history, but erase credentials and detach tools. Historical leases retain no provider credentials.
      await sql.query("update computer_connections set agent=$2,credentials=$3 where id=$1", [c.id, `removed:${c.id}`, this.options.accounts.seal(`computer:${c.id}`, "{}")]);
      return { removed: true };
    });
  }
  async confirmCleanup(tenant: string, agent: string) {
    return this.lock(tenant, agent, async sql => {
      const c = await this.connection(tenant, agent, sql), lease = await this.latest(c.id, sql);
      if (!lease || !["uncertain", "closing"].includes(lease.state)) throw new HttpError(409, "Only a failed creation or cleanup can be confirmed manually");
      await sql.query("update computer_leases set state='closed',closed_at=$2,reference=null,error=null where id=$1", [lease.id, this.now()]);
      return { confirmed: true };
    });
  }
  async call(tenant: string, agent: string, name: string, args: Record<string, any>, requestKey: string, files?: Pick<ToolContext, "mounts" | "onWrite">) {
    if (!COMPUTER_TOOLS.has(name)) throw new HttpError(400, "Unknown computer tool");
    const prepared = name === "computer_start" ? await this.prepareManagedStart(tenant, agent) : undefined;
    const outcome = await this.lock(tenant, agent, async (sql, after) => {
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
      if (name === "computer_stop") { await this.stop(c, lease, sql, after); return { stopped: true }; }
      if (lease && lease.state !== "closed" && lease.expires_at <= this.now()) { await this.stop(c, lease, sql, after); lease = undefined; }
      if (name === "computer_start") {
        if (lease && lease.state !== "closed") { if (lease.state !== "active") throw new HttpError(409, "This computer is waiting on an earlier operation, which may need its owner to confirm cleanup in the Computers console. Do not retry in this turn; tell the user."); return publicLease(lease); }
        const used = (await sql.query("select coalesce(sum(greatest(0,least(coalesce(closed_at,expires_at),expires_at)-greatest(created_at,$2))),0) as used from computer_leases where connection=$1 and expires_at > $2", [c.id, Math.floor(this.now()/86400000)*86400000])).rows[0].used;
        if (Number(used) + c.lease_seconds*1000 > c.daily_seconds*1000) throw new HttpError(429, "Computer daily time budget reached");
        const session = id(), now = this.now(), workspace = await new Workspaces(this.options.db).current(tenant, "agent", agent, sql);
        if (c.managed && !prepared) throw new HttpError(409, "This computer's session just changed; call computer_start again");
        const platform = prepared?.platform ?? false, price = prepared?.price ?? null, held = prepared?.held;
        if (prepared) prepared.used = true;
        lease = (await sql.query("insert into computer_leases(id,tenant,agent,connection,workspace,provider,state,created_at,expires_at,platform,price_hour,hold,end_user,bucket) values($1,$2,$3,$4,$5,$6,'starting',$7,$8,$9,$10,$11,$12,$13) returning *", [session, tenant, agent, c.id, workspace?.workspace ?? null, c.provider, now, now+c.lease_seconds*1000, platform, price, held?.id ?? null, held?.endUser ?? null, held?.bucket ?? null])).rows[0];
        let creator: ComputerDriver | undefined, allocated = false;
        const startedAt = Date.now();
        try {
          const ref = await this.useProvider(c, async p => {
            creator = p;
            for (let attempt = 0; ; attempt++) {
              try { return await p.create(session, c.lease_seconds, async ref => { allocated = true; await sql.query("update computer_leases set reference=$2 where id=$1", [session, this.options.accounts.seal(`computer-lease:${session}`, JSON.stringify(ref))]); }); }
              catch (error) {
                const unavailable = c.managed && !allocated ? p.unavailable?.(error) : undefined;
                if (!unavailable) throw error;
                // Each refusal is logged, for the rate of them.
                console.error(JSON.stringify({ type: "computer_unavailable", tenant, agent, lease: session, provider: c.provider, code: unavailable.code, attempt, ...unavailable.retryAfterMs !== undefined ? { retryAfterMs: unavailable.retryAfterMs } : {} }));
                const wait = unavailable.retryAfterMs !== undefined ? (attempt === 0 && unavailable.retryAfterMs <= START_WAIT_MS ? unavailable.retryAfterMs : undefined) : START_RETRIES[unavailable.code]?.[attempt];
                if (wait === undefined) throw new StartUnavailable(unavailable);
                await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(wait);
              }
            }
          }, lease);
          // A lease on the platform's keys is charged from here: never for a machine that did not start.
          await sql.query("update computer_leases set state='active',reference=$2,metered_until=case when platform then $3::bigint end where id=$1", [session, this.options.accounts.seal(`computer-lease:${session}`, JSON.stringify(ref)), this.now()]);
        } catch (error) {
          if (error instanceof StartUnavailable) {
            await sql.query("update computer_leases set state='closed',closed_at=$2,error=$3 where id=$1", [session, this.now(), `Provider unavailable: ${error.unavailable.code}`]);
            after.push(() => this.meter.settle(session));
            throw new HttpError(error.unavailable.code === "rate_limited" ? 429 : 503, unavailableMessage(error.unavailable), "COMPUTER_UNAVAILABLE", { reason: error.unavailable.code });
          }
          // A provider that refused the credentials made nothing: no machine to reconcile, and a fixed key can start again.
          if (!allocated && creator?.refused?.(error)) {
            await sql.query("update computer_leases set state='closed',closed_at=$2,error='Provider refused the credentials' where id=$1", [session, this.now()]);
            throw new HttpError(502, "The computer provider refused its credentials, and nothing was created. Do not retry in this turn. Tell the user that its owner needs to reconnect the computer with a working key in the Computers console.");
          }
          await sql.query("update computer_leases set state='uncertain',error='Creation outcome unknown' where id=$1", [session]); throw new HttpError(502, "Computer could not be created, and the provider may have made a machine. Do not retry in this turn. Tell the user the computer is unavailable and that its owner may need to check the provider account and confirm cleanup in the Computers console.");
        }
        // How long a start holds its lock: what decides whether creating a machine should move out of it.
        if (c.managed) console.error(JSON.stringify({ type: "computer_started", tenant, agent, lease: session, ms: Date.now() - startedAt }));
        return publicLease({ ...lease, state: "active" });
      }
      if (!lease || lease.state !== "active") throw new HttpError(409, "Call computer_start before using the computer");
      const input = JSON.stringify([name, args]);
      if (input.length > 40000) throw new HttpError(400, "Computer tool input too large");
      const previous = (await sql.query("select * from computer_commands where lease=$1 and key=$2", [lease.id, requestKey])).rows[0];
      if (previous) { if (previous.input_hash !== hash) throw new HttpError(409, "Retried computer call changed"); if (previous.state !== "completed") throw new HttpError(409, "Previous command outcome unknown; inspect the computer before retrying"); return previous.result; }
      const transfer = name === "computer_upload" || name === "computer_download";
      let command = transfer ? "true" : args.command;
      if (name === "computer_read_file" || name === "computer_write_file") {
        if (typeof args.path !== "string" || !args.path || args.path.length > 1024 || (name === "computer_write_file" && (typeof args.content !== "string" || args.content.length > 16000))) throw new HttpError(400, "Invalid file input");
        const data = Buffer.from(JSON.stringify(args)).toString("base64");
        command = `python3 -c 'import json,base64,pathlib; d=json.loads(base64.b64decode("${data}")); p=pathlib.Path(d["path"]); ${name === "computer_write_file" ? 'p.parent.mkdir(parents=True,exist_ok=True); p.write_text(d["content"]); print("written")' : 'print(p.open().read(24000))'}'`;
      }
      if (!isBrowserProvider(c.provider) && (typeof command !== "string" || !command || command.length > 32000)) throw new HttpError(400, "Invalid command");
      const timeout = transfer ? 120 : args.timeoutSeconds ?? (c.managed ? MANAGED.defaultCommandSeconds : 60);
      const longest = c.managed ? MANAGED.commandSeconds : 120;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > longest) throw new HttpError(400, `Command timeout must be 1–${longest} seconds`);
      await sql.query("insert into computer_commands(lease,key,input_hash,state,created_at,tenant) values($1,$2,$3,'pending',$4,$5)", [lease.id, requestKey, hash, this.now(), tenant]);
      const active = lease;
      if (c.managed) {
        const found = signatures([args.command, args.content].filter(part => typeof part === "string").join("\n"));
        if (found.length) console.error(JSON.stringify({ type: "computer_signature", tenant, agent, lease: active.id, tool: name, signatures: found }));
      }
      const runCommand = async (db: any) => {
      try {
        const ref = JSON.parse(this.options.accounts.unseal(`computer-lease:${active.id}`, active.reference));
        const value = await this.useProvider(c, async p => {
          const expiresAt = c.managed ? await this.keepManaged(c, active, p, ref, db) : active.expires_at;
          const seconds = Math.max(1, Math.min(timeout, Math.floor((expiresAt-this.now())/1000)));
          if (transfer) {
            if (!this.options.transfers) throw new HttpError(400, "Computer transfers are not enabled");
            return this.options.transfers.run({ tenant, agent, mounts: files?.mounts ?? [], onWrite: files?.onWrite }, name === "computer_upload", args, p, ref, seconds, requestKey);
          }
          return p.call(ref, name, { ...args, command, timeoutSeconds: seconds, requestKey, remainingSeconds: Math.max(1, Math.floor((expiresAt-this.now())/1000)) });
        }, active);
        const encoded = JSON.stringify(value ?? null, (_key, item) => typeof item === "string" ? item.replaceAll("\u0000", "\ufffd").toWellFormed() : item);
        const result = encoded.length > 64000 ? { truncated: true, text: encoded.slice(0,64000) } : JSON.parse(encoded);
        await db.query("update computer_commands set state='completed',result=$3 where lease=$1 and key=$2", [active.id, requestKey, JSON.stringify(result)]);
        return result;
      } catch (error) { await db.query("update computer_commands set state='uncertain' where lease=$1 and key=$2", [active.id, requestKey]); if (transfer && error instanceof HttpError) throw error; throw new HttpError(502, "Computer command failed; outcome may be uncertain"); }
      };
      return c.managed ? new Later(() => runCommand(this.options.db)) : runCommand(sql);
      };
      try {
        const result = await execute();
        if (result instanceof Later) return new Later(async () => {
          try {
            const value = await result.run();
            await this.options.db.query("update computer_operations set state='completed',result=$3 where connection=$1 and key=$2", [c.id, requestKey, JSON.stringify(value)]);
            return value;
          } catch (error) {
            await this.options.db.query("update computer_operations set state='uncertain' where connection=$1 and key=$2", [c.id, requestKey]);
            throw error;
          }
        });
        if (name !== "computer_status") await sql.query("update computer_operations set state='completed',result=$3 where connection=$1 and key=$2", [c.id, requestKey, JSON.stringify(result)]);
        return result;
      } catch (error) {
        if (name !== "computer_status") await sql.query("update computer_operations set state='uncertain' where connection=$1 and key=$2", [c.id, requestKey]);
        throw error;
      }
    }).finally(() => {
      // A start that found a session already there needs no hold of its own.
      if (prepared?.held && !prepared.used) return this.options.endUsers?.release(prepared.held.id).catch(() => {});
    });
    return outcome instanceof Later ? outcome.run() : outcome;
  }
  /**
   * What a managed computer's start needs before it takes the agent's lock (each takes a connection of its own): that it
   * may start, on which key, and its end user's hold. On the platform's key an account that has never bought credit may
   * not start one; spent credit refuses it here too (`resolveKey`).
   */
  private async prepareManagedStart(tenant: string, agent: string): Promise<{ platform: boolean; price: number | null; held?: Awaited<ReturnType<LeaseMeter["hold"]>>; used: boolean } | undefined> {
    const c = (await this.options.db.query("select id,managed,provider,lease_seconds from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rows[0];
    if (!c?.managed) return undefined;
    if (!this.options.managed) throw new HttpError(403, "Managed computers are not available on this runtime. Do not retry in this turn; tell the user.");
    if (await this.blocked(tenant)) throw new HttpError(403, "Computers are turned off for this account. Nothing was created or charged. Do not retry in this turn; tell the user.");
    const lease = await this.latest(c.id);
    if (lease && lease.state !== "closed" && lease.expires_at > this.now()) return undefined;
    const { accounts } = this.options;
    const credential = await resolveKey(accounts, tenant, MANAGED.provider);
    if (!credential) throw new HttpError(503, "Computers are unavailable on this runtime. Do not retry in this turn; tell the user.");
    if (!credential.platform) return { platform: false, price: null, used: false };
    if (await accounts.billing.onFreeCredit(tenant)) throw new HttpError(403, "Computers are available once this account has bought credit. Nothing was created or charged. Do not retry in this turn; tell the user.");
    const price = this.meter.price(c.provider);
    return { platform: true, price, held: await this.meter.hold(tenant, agent, price, c.lease_seconds), used: false };
  }
  /**
   * Keep a managed computer for its full idle time from now, up to its hard stop, when less than half of that is left:
   * its end user's hold, then the machine's own expiry, then ours. A hold or an extension refused leaves the expiry as it is. Answers the expiry.
   */
  private async keepManaged(c: any, lease: any, p: ComputerDriver, ref: Reference, db: any) {
    const expiresAt = Number(lease.expires_at), now = this.now(), idle = c.lease_seconds * 1000;
    const target = Math.min(Number(lease.created_at) + MANAGED.maxSeconds * 1000, now + idle);
    if (target - expiresAt < idle / 2) return expiresAt;
    try {
      if (!await this.meter.extendHold(lease, (target - expiresAt) / 1000)) { console.error(JSON.stringify({ type: "computer_hold_refused", tenant: c.tenant, lease: lease.id })); return expiresAt; }
      await p.extend?.(ref, Math.ceil((target - now) / 1000));
      await db.query("update computer_leases set expires_at=$2 where id=$1 and state='active' and expires_at<$2", [lease.id, target]);
      return target;
    } catch { console.error(JSON.stringify({ type: "computer_extend_failed", tenant: c.tenant, lease: lease.id })); return expiresAt; }
  }
  async usage(tenant: string) {
    return (await this.options.db.query(`select workspace,provider,count(*)::integer as sessions,sum(greatest(0,least(coalesce(closed_at,$2),expires_at)-created_at))/1000.0 as seconds,(sum(round(metered_seconds*coalesce(price_hour,0)/3600.0))/${MICROS})::float8 as "costUsd" from computer_leases where tenant=$1 group by workspace,provider`, [tenant, this.now()])).rows;
  }
  /** Stop a lease that is running, under its agent's lock. */
  private stopLease(lease: { id: string; tenant: string; agent: string; connection: string }) {
    return this.lock(lease.tenant, lease.agent, async (sql, after) => {
      const current = (await sql.query("select * from computer_leases where id=$1", [lease.id])).rows[0];
      if (current?.state !== "active") return;
      await this.stop((await sql.query("select * from computer_connections where id=$1", [lease.connection])).rows[0], current, sql, after);
    });
  }
  /** Stop every running managed computer, or one account's. Answers how many stopped and how many failed: a failed cleanup retries in the sweep, and is no longer charged. */
  private async stopManaged(tenant?: string) {
    const { rows } = await this.options.db.query("select l.id,l.tenant,l.agent,l.connection from computer_leases l join computer_connections c on c.id=l.connection where c.managed and l.state='active' and ($1::text is null or l.tenant=$1) limit 1000", [tenant ?? null]);
    let stopped = 0, failed = 0;
    for (const lease of rows) {
      try { await this.stopLease(lease); stopped++; }
      catch { failed++; }
      console.error(JSON.stringify({ type: "computer_kill_stop", tenant: lease.tenant, agent: lease.agent, lease: lease.id }));
    }
    return { stopped, failed };
  }
  /** The platform operator's stop: this account's running managed computers now, and with `block`, none new until `unblock`. Bring-your-own connections are the account's own, and aren't touched. */
  async stopTenant(tenant: string, by: string, block: boolean) {
    if (block) await this.options.db.query("insert into computer_blocks(tenant,blocked_by,created_at) values($1,$2,$3) on conflict (tenant) do nothing", [tenant, by, this.now()]);
    const result = await this.stopManaged(tenant);
    console.error(JSON.stringify({ type: "computer_tenant_stopped", tenant, by, block, ...result }));
    return { ...result, blocked: await this.blocked(tenant) };
  }
  async unblockTenant(tenant: string) {
    await this.options.db.query("delete from computer_blocks where tenant=$1", [tenant]);
    return { blocked: false };
  }
  private async blocked(tenant: string) { return !!(await this.options.db.query("select 1 from computer_blocks where tenant=$1", [tenant])).rowCount; }
  /**
   * Find what the platform's account is running that no lease accounts for: machines (by their labels) past a start's
   * time whose lease is gone, closed, or left uncertain by a lost answer, are deleted; a lease left uncertain whose
   * machine is not there is closed, so its agent can start again. Answers what it found. A provider's expiry bounds a
   * leak anyway: this is for the cost until then, and for seeing that it happens.
   */
  async reconcile() {
    const { accounts, db } = this.options;
    const key = accounts.tenants.platformKey(MANAGED.provider);
    if (!key) return { machines: 0, leaked: 0, cleared: 0 };
    const value = await (this.options.driver ?? driver)(MANAGED.provider, { apiKey: key }, this.options.outbound, { managed: true });
    try {
      const machines = await value.list?.() ?? [], settled = this.now() - RECONCILE_AFTER_MS;
      let leaked = 0;
      for (const machine of machines) {
        if (machine.createdAt > settled) continue;
        const lease = (await db.query("select state from computer_leases where id=$1", [machine.lease])).rows[0];
        if (lease && lease.state !== "closed" && lease.state !== "uncertain") continue;
        await value.close({ id: machine.id });
        leaked++;
        console.error(JSON.stringify({ type: "computer_leak", tenant: machine.tenant, lease: machine.lease, machine: machine.id, state: lease?.state ?? "none" }));
      }
      const cleared = (await db.query("update computer_leases l set state='closed',closed_at=$1,error=null from computer_connections c where c.id=l.connection and c.managed and l.platform and l.state='uncertain' and l.created_at<=$2", [this.now(), settled])).rowCount ?? 0;
      console.error(JSON.stringify({ type: "computer_reconcile", machines: machines.length, leaked, cleared }));
      return { machines: machines.length, leaked, cleared };
    } finally { await value.dispose?.(); }
  }
  async sweep() {
    if (!this.options.managed) await this.stopManaged();
    await this.meter.sweep(lease => this.stopLease(lease)).catch(() => console.error(JSON.stringify({ type: "computer_meter_failed" })));
    const rows = (await this.options.db.query("select l.*, c.credentials, c.managed, c.id as connection_id from computer_leases l join computer_connections c on c.id=l.connection left join agents a on a.id=l.agent and a.tenant=l.tenant where (l.state='closing' or (l.state='uncertain' and l.reference is not null) or (l.state='starting' and l.created_at<=$1::bigint-180000) or (l.state='active' and (l.expires_at<=$1 or a.id is null or a.revoked or a.purged_at is not null or a.expires_at<=$1))) order by l.cleanup_at, l.expires_at limit 100", [this.now()])).rows;
    for (const row of rows) {
      try { await this.lock(row.tenant, row.agent, async (sql, after) => { const current = (await sql.query("select * from computer_leases where id=$1", [row.id])).rows[0]; if (current.state === "closed" || (current.state === "active" && current.expires_at > this.now() && row.state !== "active")) return; await this.stop({ ...row, id: row.connection_id }, current, sql, after); }); } catch { /* Durable closing state retries next sweep. No credentials in logs. */ }
    }
  }
}
