import { createHash, randomUUID } from "node:crypto";
import type { Accounts } from "../accounts.ts";
import type { Db, DbClient } from "../db.ts";
import { HttpError } from "../http.ts";
import type { Outbound } from "../outbound.ts";
import type { ToolDefinition } from "../protocol.ts";
import { Workspaces } from "../workspaces.ts";
import { driver, PROVIDERS, type Credentials, type DriverFactory, type ComputerDriver, type Provider, type Reference } from "./providers.ts";

const id = () => `cmp_${randomUUID().replaceAll("-", "")}`;
const parameters = (properties = {}, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const text = { type: "string", minLength: 1, maxLength: 32000 };
const tool = (name: string, description: string, props = {}, required: string[] = []): ToolDefinition => ({ name, description, timeoutMs: 180000, exposure: "both", parameters: parameters(props, required) });
const COMMON = [tool("computer_start", "Start your attached computer or return its current session. Files and processes survive across turns until its fixed expiry. A new session after expiry starts empty."), tool("computer_status", "Read your computer's session and fixed expiry; does not start one."), tool("computer_stop", "Stop your attached computer and discard its session files.")];
const SHELL = [tool("computer_exec", "Run a shell command in your attached remote Linux computer, never on the camelRun host. Inspect exitCode. Redirect output for background processes. Files survive between calls until expiry.", { command: text, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 } }, ["command"]), tool("computer_write_file", "Write a UTF-8 file in your remote computer. This is separate from camelRun workspace files.", { path: text, content: { type: "string", maxLength: 16000 } }, ["path", "content"]), tool("computer_read_file", "Read up to 24000 characters from a UTF-8 file in your remote computer.", { path: text }, ["path"])];
const BROWSER = [tool("browser_navigate", "Navigate your attached remote browser to an HTTP(S) URL.", { url: text }, ["url"]), tool("browser_read", "Read the current remote page's title, URL and visible text."), tool("browser_click", "Click a CSS selector in the remote page.", { selector: text }, ["selector"]), tool("browser_fill", "Fill a CSS-selected input in the remote page.", { selector: text, text: { type: "string", maxLength: 16000 } }, ["selector", "text"]), tool("browser_evaluate", "Run JavaScript in the remote web page and return a JSON result. No host shell or filesystem access.", { expression: text }, ["expression"])];
export const COMPUTER_TOOLS = new Set([...COMMON, ...SHELL, ...BROWSER].map(t => t.name));
const publicConnection = (r: any) => ({ id: r.id, agent: r.agent, provider: r.provider, leaseSeconds: r.lease_seconds, dailySeconds: r.daily_seconds, createdAt: r.created_at, billing: "provider_account", session: publicLease(r.lease) });
const publicLease = (r: any) => r ? ({ id: r.id, provider: r.provider, workspaceId: r.workspace, state: r.state, recoveryRequired: r.state === "uncertain" || r.state === "closing" && !!r.error, createdAt: r.created_at, expiresAt: r.expires_at, closedAt: r.closed_at, ...(r.error ? { error: r.error } : {}) }) : null;

export class Computers {
  readonly options: { db: Db; accounts: Pick<Accounts, "seal" | "unseal">; outbound: Outbound; driver?: DriverFactory; now?: () => number };
  constructor(options: Computers["options"]) { this.options = options; }
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
  async revision(tenant: string, agent: string) { return (await this.options.db.query("select id from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rows[0]?.id ?? ""; }
  async removeTenant(tenant: string) { for (const c of await this.list(tenant)) await this.remove(tenant, c.id); }
  async list(tenant: string) { return (await this.options.db.query("select c.*, row_to_json(l) as lease from computer_connections c left join lateral (select * from computer_leases where connection=c.id order by sequence desc limit 1) l on true where c.tenant = $1 and c.agent not like 'removed:%' order by c.created_at", [tenant])).rows.map(publicConnection); }
  async create(tenant: string, input: { agent: string; provider: Provider; credentials: Credentials; leaseSeconds: number; dailySeconds: number }) {
    if (!PROVIDERS.includes(input.provider)) throw new HttpError(400, "Unknown computer provider");
    const expected = input.provider === "modal" ? ["tokenId", "tokenSecret"] : input.provider === "tunnel" ? ["apiKey", "url"] : ["apiKey"];
    if (!input.credentials || expected.some(k => typeof input.credentials[k] !== "string" || !input.credentials[k].trim()) || Object.keys(input.credentials).some(k => ![...expected, ...(input.provider === "browserbase" ? ["projectId"] : [])].includes(k)) || Object.values(input.credentials).some(v => typeof v !== "string" || v.length > 16000)) throw new HttpError(400, `Credentials require ${expected.join(", ")}`);
    if (input.provider === "tunnel") {
      let url: URL;
      try { url = new URL(input.credentials.url); } catch { throw new HttpError(400, "Invalid tunnel URL"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new HttpError(400, "Tunnel URL must be an HTTPS origin");
      // Public reachability and DNS rebinding are checked again on every request by Outbound.
    }
    if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 60 || input.leaseSeconds > 900 || !Number.isInteger(input.dailySeconds) || input.dailySeconds < input.leaseSeconds || input.dailySeconds > 86400) throw new HttpError(400, "Invalid computer time limits");
    return this.lock(tenant, input.agent, async sql => {
      if (!(await sql.query("select 1 from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3)", [tenant, input.agent, this.now()])).rowCount) throw new HttpError(404, "Unknown agent");
      if ((await sql.query("select 1 from computer_connections where tenant=$1 and agent=$2", [tenant, input.agent])).rowCount) throw new HttpError(409, "This agent already has a computer connection");
      const connection = id();
      const row = (await sql.query("insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning *", [connection, tenant, input.agent, input.provider, this.options.accounts.seal(`computer:${connection}`, JSON.stringify(input.credentials)), input.leaseSeconds, input.dailySeconds, this.now()])).rows[0];
      return publicConnection(row);
    });
  }
  private provider(connection: any) { return (this.options.driver ?? driver)(connection.provider, JSON.parse(this.options.accounts.unseal(`computer:${connection.id}`, connection.credentials)), this.options.outbound); }
  private async useProvider<T>(connection: any, fn: (value: ComputerDriver) => Promise<T>) {
    const value = await this.provider(connection);
    try { return await fn(value); } finally { await value.dispose?.(); }
  }
  private async connection(tenant: string, agent: string, sql: any = this.options.db) {
    const row = (await sql.query("select c.* from computer_connections c join agents a on a.id=c.agent and a.tenant=c.tenant where c.tenant=$1 and c.agent=$2 and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at>$3)", [tenant, agent, this.now()])).rows[0];
    if (!row) throw new HttpError(404, "No computer connected to this agent");
    return row;
  }
  private async latest(connection: string, sql: any = this.options.db) { return (await sql.query("select * from computer_leases where connection=$1 order by sequence desc limit 1", [connection])).rows[0]; }
  async tools(tenant: string, agent: string) {
    const c = (await this.options.db.query("select provider from computer_connections where tenant=$1 and agent=$2", [tenant, agent])).rows[0];
    return c ? [...COMMON, ...(c.provider === "browserbase" ? BROWSER : SHELL)] : [];
  }
  async status(tenant: string, agent: string) { const c = await this.connection(tenant, agent), session = publicLease(await this.latest(c.id)); return { connection: { ...publicConnection(c), session }, session }; }
  private async stop(connection: any, lease: any, sql: any) {
    if (!lease || lease.state === "closed") return;
    await sql.query("update computer_leases set state='closing',cleanup_at=$2 where id=$1", [lease.id, this.now()]);
    if (!lease.reference) {
      // A provider may have accepted a create whose response was lost. Never create another
      // automatically; keep the uncertain record visible for provider-side reconciliation.
      await sql.query("update computer_leases set state='uncertain',error=$2 where id=$1", [lease.id, "Creation outcome unknown; check the provider before removing this connection"]);
      throw new HttpError(409, "Computer creation outcome unknown; provider reconciliation required");
    }
    const reference: Reference = JSON.parse(this.options.accounts.unseal(`computer-lease:${lease.id}`, lease.reference));
    try { await this.useProvider(connection, p => p.close(reference)); }
    catch { await sql.query("update computer_leases set error='Cleanup failed; retrying' where id=$1", [lease.id]); throw new HttpError(502, "Computer cleanup failed; it will be retried"); }
    await sql.query("update computer_leases set state='closed',closed_at=$2,reference=null,error=null where id=$1", [lease.id, this.now()]);
  }
  async remove(tenant: string, connectionId: string) {
    const c = (await this.options.db.query("select * from computer_connections where tenant=$1 and id=$2", [tenant, connectionId])).rows[0];
    if (!c) throw new HttpError(404, "Unknown computer connection");
    return this.lock(tenant, c.agent, async sql => {
      for (const lease of (await sql.query("select * from computer_leases where connection=$1 and state<>'closed'", [c.id])).rows) await this.stop(c, lease, sql);
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
  async call(tenant: string, agent: string, name: string, args: Record<string, any>, requestKey: string) {
    if (!COMPUTER_TOOLS.has(name)) throw new HttpError(400, "Unknown computer tool");
    return this.lock(tenant, agent, async sql => {
      const c = await this.connection(tenant, agent, sql);
      if (!(c.provider === "browserbase" ? [...COMMON, ...BROWSER] : [...COMMON, ...SHELL]).some(t => t.name === name)) throw new HttpError(400, "Tool not supported by this computer");
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
      if (lease && lease.state !== "closed" && lease.expires_at <= this.now()) { await this.stop(c, lease, sql); lease = undefined; }
      if (name === "computer_start") {
        if (lease && lease.state !== "closed") { if (lease.state !== "active") throw new HttpError(409, "Previous computer operation needs recovery"); return publicLease(lease); }
        const used = (await sql.query("select coalesce(sum(greatest(0,least(coalesce(closed_at,expires_at),expires_at)-greatest(created_at,$2))),0) as used from computer_leases where connection=$1 and expires_at > $2", [c.id, Math.floor(this.now()/86400000)*86400000])).rows[0].used;
        if (Number(used) + c.lease_seconds*1000 > c.daily_seconds*1000) throw new HttpError(429, "Computer daily time budget reached");
        const session = id(), now = this.now(), workspace = await new Workspaces(this.options.db).current(tenant, "agent", agent, sql);
        lease = (await sql.query("insert into computer_leases(id,tenant,agent,connection,workspace,provider,state,created_at,expires_at) values($1,$2,$3,$4,$5,$6,'starting',$7,$8) returning *", [session, tenant, agent, c.id, workspace?.workspace ?? null, c.provider, now, now+c.lease_seconds*1000])).rows[0];
        try {
          const ref = await this.useProvider(c, p => p.create(session, c.lease_seconds, async ref => { await sql.query("update computer_leases set reference=$2 where id=$1", [session, this.options.accounts.seal(`computer-lease:${session}`, JSON.stringify(ref))]); }));
          await sql.query("update computer_leases set state='active',reference=$2 where id=$1", [session, this.options.accounts.seal(`computer-lease:${session}`, JSON.stringify(ref))]);
        } catch { await sql.query("update computer_leases set state='uncertain',error='Creation outcome unknown' where id=$1", [session]); throw new HttpError(502, "Computer creation failed; outcome may be uncertain"); }
        return publicLease({ ...lease, state: "active" });
      }
      if (!lease || lease.state !== "active") throw new HttpError(409, "Call computer_start before using the computer");
      const input = JSON.stringify([name, args]);
      if (input.length > 40000) throw new HttpError(400, "Computer tool input too large");
      const previous = (await sql.query("select * from computer_commands where lease=$1 and key=$2", [lease.id, requestKey])).rows[0];
      if (previous) { if (previous.input_hash !== hash) throw new HttpError(409, "Retried computer call changed"); if (previous.state !== "completed") throw new HttpError(409, "Previous command outcome unknown; inspect the computer before retrying"); return previous.result; }
      let command = args.command;
      if (name === "computer_read_file" || name === "computer_write_file") {
        if (typeof args.path !== "string" || !args.path || args.path.length > 1024 || (name === "computer_write_file" && (typeof args.content !== "string" || args.content.length > 16000))) throw new HttpError(400, "Invalid file input");
        const data = Buffer.from(JSON.stringify(args)).toString("base64");
        command = `python3 -c 'import json,base64,pathlib; d=json.loads(base64.b64decode("${data}")); p=pathlib.Path(d["path"]); ${name === "computer_write_file" ? 'p.parent.mkdir(parents=True,exist_ok=True); p.write_text(d["content"]); print("written")' : 'print(p.open().read(24000))'}'`;
      }
      if (c.provider !== "browserbase" && (typeof command !== "string" || !command || command.length > 32000)) throw new HttpError(400, "Invalid command");
      const timeout = args.timeoutSeconds ?? 60;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) throw new HttpError(400, "Command timeout must be 1–120 seconds");
      await sql.query("insert into computer_commands(lease,key,input_hash,state,created_at,tenant) values($1,$2,$3,'pending',$4,$5)", [lease.id, requestKey, hash, this.now(), tenant]);
      try {
        const ref = JSON.parse(this.options.accounts.unseal(`computer-lease:${lease.id}`, lease.reference));
        const value = await this.useProvider(c, p => p.call(ref, name, { ...args, command, timeoutSeconds: Math.max(1, Math.min(timeout, Math.floor((lease.expires_at-this.now())/1000))), requestKey, remainingSeconds: Math.max(1, Math.floor((lease.expires_at-this.now())/1000)) }));
        const encoded = JSON.stringify(value ?? null, (_key, item) => typeof item === "string" ? item.replaceAll("\u0000", "\ufffd").toWellFormed() : item);
        const result = encoded.length > 64000 ? { truncated: true, text: encoded.slice(0,64000) } : JSON.parse(encoded);
        await sql.query("update computer_commands set state='completed',result=$3 where lease=$1 and key=$2", [lease.id, requestKey, JSON.stringify(result)]);
        return result;
      } catch { await sql.query("update computer_commands set state='uncertain' where lease=$1 and key=$2", [lease.id, requestKey]); throw new HttpError(502, "Computer command failed; outcome may be uncertain"); }
      };
      try {
        const result = await execute();
        if (name !== "computer_status") await sql.query("update computer_operations set state='completed',result=$3 where connection=$1 and key=$2", [c.id, requestKey, JSON.stringify(result)]);
        return result;
      } catch (error) {
        if (name !== "computer_status") await sql.query("update computer_operations set state='uncertain' where connection=$1 and key=$2", [c.id, requestKey]);
        throw error;
      }
    });
  }
  async usage(tenant: string) {
    return (await this.options.db.query("select workspace,provider,count(*)::integer as sessions,sum(greatest(0,least(coalesce(closed_at,$2),expires_at)-created_at))/1000.0 as seconds from computer_leases where tenant=$1 group by workspace,provider", [tenant, this.now()])).rows;
  }
  async sweep() {
    const rows = (await this.options.db.query("select l.*, c.credentials, c.id as connection_id from computer_leases l join computer_connections c on c.id=l.connection left join agents a on a.id=l.agent and a.tenant=l.tenant where (l.state='closing' or (l.state='uncertain' and l.reference is not null) or (l.state='starting' and l.created_at<=$1::bigint-180000) or (l.state='active' and (l.expires_at<=$1 or a.id is null or a.revoked or a.purged_at is not null or a.expires_at<=$1))) order by l.cleanup_at, l.expires_at limit 100", [this.now()])).rows;
    for (const row of rows) {
      try { await this.lock(row.tenant, row.agent, async sql => { const current = (await sql.query("select * from computer_leases where id=$1", [row.id])).rows[0]; if (current.state === "closed" || (current.state === "active" && current.expires_at > this.now() && row.state !== "active")) return; await this.stop({ ...row, id: row.connection_id }, current, sql); }); } catch { /* Durable closing state retries next sweep. No credentials in logs. */ }
    }
  }
}
