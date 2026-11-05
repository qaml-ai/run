import { z } from 'zod';
import { transaction, withSql, type Sql } from '../postgres.ts';
import { seal, unseal } from '../webhooks.ts';
import type { ControlEnv } from '../control.ts';
import { HttpError } from '../errors.ts';
import { COMMON, SHELL, BROWSER, COMPUTER_TOOLS, PROVIDERS, isBrowserProvider, fileCommand, storable, type Credentials, type ComputerDriver, type Provider } from './policy.ts';
import { remoteDriver, type RemoteBindings } from './remote.ts';
export type ComputerEnv = ControlEnv & RemoteBindings & { COMPUTER_MANAGED_ENABLED?: string };
const id = () => `cmp_${crypto.randomUUID().replaceAll('-', '')}`;
const input = z.object({ agent: z.string().min(1), provider: z.enum([...PROVIDERS, 'container']), credentials: z.record(z.string(), z.string()).optional(),
  subagents: z.boolean().optional(), leaseSeconds: z.number().int().min(60).max(86400).optional(), dailySeconds: z.number().int().min(60).max(86400).optional() }).strict();
export function connectionInput(value: unknown, managedEnabled: boolean) {
  const parsed = input.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'Invalid computer connection');
  const connection = parsed.data, managed = connection.credentials === undefined && ['lambda','boat','container'].includes(connection.provider);
  if (managed) {
    if (!managedEnabled) throw new HttpError(403, 'Managed computers are not available on this runtime');
    const leaseSeconds = connection.leaseSeconds ?? 7200, dailySeconds = connection.dailySeconds ?? 86400;
    if (leaseSeconds > 28800 || dailySeconds < leaseSeconds) throw new HttpError(400, 'Invalid computer time limits');
    return { ...connection, credentials: {}, leaseSeconds, dailySeconds, managed: true };
  }
  if (connection.provider === 'lambda' || connection.provider === 'container') throw new HttpError(400, 'This provider uses runtime credentials');
  const expected = connection.provider === 'modal' ? ['tokenId','tokenSecret'] : connection.provider === 'tunnel' ? ['apiKey','url'] : ['apiKey'];
  const credentials = connection.credentials;
  if (!credentials || expected.some(k => !credentials[k]?.trim()) || Object.keys(credentials).some(k => ![...expected, ...(connection.provider === 'browserbase' ? ['projectId'] : [])].includes(k)) || Object.values(credentials).some(v => v.length > 16000)) throw new HttpError(400, `Credentials require ${expected.join(', ')}`);
  if (connection.provider === 'tunnel') {
    let url: URL;
    try { url = new URL(credentials.url); } catch { throw new HttpError(400, 'Invalid tunnel URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || /^\d|^\[/.test(url.hostname) || ['localhost', 'internal', 'local'].some(x => url.hostname === x || url.hostname.endsWith(`.${x}`)))
      throw new HttpError(400, 'Tunnel URL must be a public HTTPS origin');
  }
  const leaseSeconds = connection.leaseSeconds ?? 900, dailySeconds = connection.dailySeconds ?? 3600;
  if (leaseSeconds > 900 || dailySeconds < leaseSeconds) throw new HttpError(400, 'Invalid computer time limits');
  return { ...connection, credentials, leaseSeconds, dailySeconds, managed: false };
}
export const publicLease = (r: any) => r ? ({ id: r.id, provider: r.provider, workspaceId: r.workspace, state: r.state, recoveryRequired: r.state === 'uncertain' || r.state === 'closing' && !!r.error, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), closedAt: r.closed_at === null ? null : Number(r.closed_at), ...(r.error ? { error: r.error } : {}) }) : null;
const publicConnection = (r: any) => ({ id: r.id, agent: r.agent, provider: r.provider, managed: !!r.managed, subagents: r.subagents, leaseSeconds: r.lease_seconds, dailySeconds: r.daily_seconds, createdAt: Number(r.created_at), billing: r.managed ? 'credits' : 'provider_account', session: publicLease(r.lease) });
const latest = async (sql: Sql, connection: string) => (await sql.query('select * from computer_leases where connection=$1 order by sequence desc limit 1', [connection])).rows[0];
export class ComputerService {
  readonly env: ComputerEnv;
  readonly tenant: string;
  readonly factory: typeof remoteDriver;
  constructor(env: ComputerEnv, tenant: string, factory = remoteDriver) { this.env = env; this.tenant = tenant; this.factory = factory; }
  get managedEnabled() {
    // This experiment does not enable unpaid platform compute. Money integration
    // must supply real settlement before this test-only switch can be removed.
    return this.env.TEST_MODE === '1' && this.env.COMPUTER_MANAGED_ENABLED === '1';
  }
  async connection(agent: string, sql?: Sql) {
    const get = async (db: Sql) => (await db.query("select c.* from computer_connections c join agents a on a.id=c.agent and a.tenant=c.tenant where c.tenant=$1 and c.agent=$2 and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at>$3)", [this.tenant, agent, Date.now()])).rows[0];
    const row = sql ? await get(sql) : await withSql(this.env, get);
    if (!row) throw new HttpError(404, 'No computer connected to this agent');
    return row;
  }
  async hasConnection(agent: string) { try { return await this.connection(agent); } catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e; } }
  async list() {
    return withSql(this.env, async sql => (await sql.query("select c.*, row_to_json(l) as lease from computer_connections c left join lateral (select * from computer_leases where connection=c.id order by sequence desc limit 1) l on true where c.tenant=$1 and c.agent not like 'removed:%' order by c.created_at", [this.tenant])).rows.map(publicConnection));
  }
  async status(agent: string) { return withSql(this.env, async sql => { const c = await this.connection(agent, sql), session = publicLease(await latest(sql, c.id)); return { connection: { ...publicConnection(c), session }, session }; }); }
  async create(value: unknown) {
    const parsed = connectionInput(value, this.managedEnabled);
    if (parsed.managed && parsed.provider === 'boat') parsed.provider = 'lambda';
    return transaction(this.env, async sql => {
      const exists = await sql.query('select id from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3) for update', [this.tenant, parsed.agent, Date.now()]);
      if (!exists.rowCount) throw new HttpError(404, 'Unknown agent');
      if ((await sql.query('select 1 from computer_connections where tenant=$1 and agent=$2', [this.tenant, parsed.agent])).rowCount) throw new HttpError(409, 'This agent already has a computer connection');
      const connection = id(), credentials = await seal(JSON.stringify({ connection, credentials: parsed.credentials }), this.env);
      const row = (await sql.query('insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at,managed,subagents) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *', [connection, this.tenant, parsed.agent, parsed.provider, JSON.stringify(credentials), parsed.leaseSeconds, parsed.dailySeconds, Date.now(), parsed.managed, parsed.subagents ?? true])).rows[0];
      return publicConnection(row);
    });
  }
  async credentials(c: any): Promise<Credentials> {
    const envelope = JSON.parse(await unseal(c.credentials, this.env));
    if (envelope.connection !== c.id) throw new Error('Computer credential binding mismatch');
    return envelope.credentials;
  }
  async tools(agent: string) { const c = await this.hasConnection(agent); return c ? [...COMMON, ...(isBrowserProvider(c.provider) ? BROWSER : SHELL)] : []; }
  private async driver(c: any): Promise<ComputerDriver> { return this.factory(this.env, this.tenant, c.agent, c.provider, await this.credentials(c)); }
  private async stop(c: any, lease: any) {
    if (!lease || lease.state === 'closed') return;
    await withSql(this.env, sql => sql.query("update computer_leases set state='closing',cleanup_at=$2 where id=$1", [lease.id, Date.now()]));
    if (!lease.reference) {
      await withSql(this.env, sql => sql.query("update computer_leases set state='uncertain',error='Creation outcome unknown; confirm provider cleanup' where id=$1", [lease.id]));
      throw new HttpError(409, 'Computer creation outcome unknown; confirm provider cleanup');
    }
    try { await (await this.driver(c)).close(JSON.parse(await unseal(lease.reference, this.env))); }
    catch { await withSql(this.env, sql => sql.query("update computer_leases set error='Cleanup failed; retrying' where id=$1", [lease.id])); throw new HttpError(502, 'Computer cleanup failed; it will be retried'); }
    await withSql(this.env, sql => sql.query("update computer_leases set state='closed',closed_at=$2,reference=null,error=null where id=$1", [lease.id, Date.now()]));
  }
  /** Mutations run inside the owning agent DO's serial queue. Never hold PG over provider I/O. */
  async call(agent: string, name: string, args: Record<string, any>, key: string) {
    if (!COMPUTER_TOOLS.has(name)) throw new HttpError(400, 'Unknown computer tool');
    const c = await this.connection(agent);
    if (!(await this.tools(agent)).some(t => t.name === name)) throw new HttpError(400, 'Tool not supported by this computer');
    const encoded = JSON.stringify([name, args]);
    if (encoded.length > 40000 || typeof key !== 'string' || !key || key.length > 256 || !args || typeof args !== 'object' || Array.isArray(args)) throw new HttpError(400, 'Invalid computer operation');
    let lease = await withSql(this.env, sql => latest(sql, c.id));
    if (name === 'computer_status') return publicLease(lease);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded))), x => x.toString(16).padStart(2, '0')).join('');
    const old = await withSql(this.env, async sql => (await sql.query('select * from computer_operations where connection=$1 and key=$2', [c.id, key])).rows[0]);
    if (old) { if (old.input_hash !== hash) throw new HttpError(409, 'Retried computer operation changed'); if (old.state !== 'completed') throw new HttpError(409, 'Previous operation has an uncertain outcome; inspect status before retrying'); return old.result; }
    // Validate before writing an uncertain intent.
    const command = fileCommand(name, args) ?? args.command, timeout = args.timeoutSeconds ?? 60;
    if (!['computer_start','computer_stop'].includes(name) && ((!isBrowserProvider(c.provider) && (typeof command !== 'string' || !command || command.length > 32000)) || !Number.isInteger(timeout) || timeout < 1 || timeout > 120)) throw new HttpError(400, 'Invalid computer command or timeout');
    await withSql(this.env, sql => sql.query("insert into computer_operations(connection,key,input_hash,state,tenant) values($1,$2,$3,'pending',$4)", [c.id, key, hash, this.tenant]));
    try {
      let result: unknown;
      if (name === 'computer_stop') { await this.stop(c, lease); result = { stopped: true }; }
      else {
        if (lease && lease.state !== 'closed' && Number(lease.expires_at) <= Date.now()) { await this.stop(c, lease); lease = undefined; }
        if (name === 'computer_start') {
          if (lease && lease.state !== 'closed') { if (lease.state !== 'active') throw new HttpError(409, 'Computer needs provider cleanup before restart'); result = publicLease(lease); }
          else {
            const used = await withSql(this.env, async sql => Number((await sql.query('select coalesce(sum(greatest(0,least(coalesce(closed_at,expires_at),expires_at)-greatest(created_at,$2))),0) as used from computer_leases where connection=$1 and expires_at>$2', [c.id, Math.floor(Date.now()/86400000)*86400000])).rows[0].used));
            if (used + c.lease_seconds * 1000 > c.daily_seconds * 1000) throw new HttpError(429, 'Computer daily time budget reached');
            const session = id(), now = Date.now();
            lease = await withSql(this.env, async sql => (await sql.query("insert into computer_leases(id,tenant,agent,connection,provider,state,created_at,expires_at) values($1,$2,$3,$4,$5,'starting',$6,$7) returning *", [session, this.tenant, agent, c.id, c.provider, now, now+c.lease_seconds*1000])).rows[0]);
            let driver: ComputerDriver | undefined, allocated = false;
            try {
              driver = await this.driver(c);
              const ref = await driver.create(session, c.lease_seconds, async value => { allocated = true; const secret = await seal(JSON.stringify(value), this.env); await withSql(this.env, sql => sql.query('update computer_leases set reference=$2 where id=$1', [session, JSON.stringify(secret)])); });
              const secret = await seal(JSON.stringify(ref), this.env);
              await withSql(this.env, sql => sql.query("update computer_leases set state='active',reference=$2 where id=$1", [session, JSON.stringify(secret)]));
            } catch (error) {
              const refused = !allocated && (error instanceof HttpError && error.status === 503 || driver?.refused?.(error));
              await withSql(this.env, sql => sql.query('update computer_leases set state=$2,error=$3,closed_at=$4 where id=$1', [session, refused ? 'closed' : 'uncertain', refused ? 'Provider refused the credentials' : 'Creation outcome unknown', refused ? Date.now() : null]));
              throw new HttpError(502, refused ? 'The provider refused its credentials; reconnect the computer' : 'Computer creation outcome unknown; confirm provider cleanup');
            }
            result = publicLease({ ...lease, state: 'active' });
          }
        } else {
          if (!lease || lease.state !== 'active') throw new HttpError(409, 'Call computer_start before using the computer');
          const ref = JSON.parse(await unseal(lease.reference, this.env));
          const remainingSeconds = Math.max(1, Math.floor((Number(lease.expires_at)-Date.now())/1000));
          result = storable(await (await this.driver(c)).call(ref, name, { ...args, command, requestKey: key, timeoutSeconds: Math.min(timeout, remainingSeconds), remainingSeconds }));
        }
      }
      await withSql(this.env, sql => sql.query("update computer_operations set state='completed',result=$3 where connection=$1 and key=$2", [c.id, key, JSON.stringify(result)]));
      return result;
    } catch (error) {
      await withSql(this.env, sql => sql.query("update computer_operations set state='uncertain' where connection=$1 and key=$2", [c.id, key]));
      throw error;
    }
  }
  private async detach(c: any) {
    await this.stop(c, await withSql(this.env, sql => latest(sql, c.id)));
    await withSql(this.env, sql => sql.query("update computer_connections set agent=$2,credentials=$3 where id=$1", [c.id, `removed:${c.id}`, '{}']));
    return { removed: true };
  }
  async remove(agent: string) { return this.detach(await this.connection(agent)); }
  async nextDeadline(agent: string): Promise<number | null> {
    const row = await withSql(this.env, async sql => (await sql.query("select min(case when l.state='active' then l.expires_at when l.state='starting' then l.created_at+180000 else l.cleanup_at+300000 end) as due from computer_leases l join computer_connections c on c.id=l.connection where c.tenant=$1 and c.agent=$2 and (l.state in ('active','starting') or (l.state in ('closing','uncertain') and l.reference is not null))", [this.tenant, agent])).rows[0]);
    return row?.due == null ? null : Number(row.due);
  }
  async sweepAgent(agent: string) {
    const c = await withSql(this.env, async sql => (await sql.query('select c.*,a.revoked,a.purged_at,a.expires_at as agent_expires_at from computer_connections c left join agents a on a.id=c.agent and a.tenant=c.tenant where c.tenant=$1 and c.agent=$2', [this.tenant, agent])).rows[0]);
    if (!c) return;
    if (c.revoked === null || c.revoked || c.purged_at || c.agent_expires_at && Number(c.agent_expires_at) <= Date.now()) { await this.detach(c); return; }
    const lease = await withSql(this.env, sql => latest(sql, c.id));
    if (lease && lease.state !== 'closed' && (Number(lease.expires_at) <= Date.now() || ['closing','uncertain'].includes(lease.state) || lease.state === 'starting' && Number(lease.created_at) <= Date.now()-180000)) await this.stop(c, lease);
  }
  /** The directory is already revoked when deletion reaches its owning DO. */
  async removeAgent(agent: string) {
    const c = await withSql(this.env, async sql => (await sql.query('select * from computer_connections where tenant=$1 and agent=$2', [this.tenant, agent])).rows[0]);
    return c ? this.detach(c) : { removed: false };
  }

  async confirmCleanup(agent: string) { const c = await this.connection(agent), lease = await withSql(this.env, sql => latest(sql, c.id)); if (!lease || !['uncertain','closing'].includes(lease.state)) throw new HttpError(409, 'Only a failed creation or cleanup can be confirmed manually'); await withSql(this.env, sql => sql.query("update computer_leases set state='closed',closed_at=$2,reference=null,error=null where id=$1", [lease.id, Date.now()])); return { confirmed: true }; }
  async usage() { return withSql(this.env, async sql => (await sql.query('select workspace,provider,count(*)::integer as sessions,sum(greatest(0,least(coalesce(closed_at,$2),expires_at)-created_at))/1000.0 as seconds from computer_leases where tenant=$1 group by workspace,provider', [this.tenant, Date.now()])).rows.map(row => ({ ...row, costUsd: 0 }))); }
}
export async function inheritComputer(env: ComputerEnv, tenant: string, parent: string, child: string, sql?: Sql) {
  const run = async (db: Sql) => {
    const c = (await db.query('select * from computer_connections where tenant=$1 and agent=$2 and subagents for share', [tenant, parent])).rows[0];
    if (!c) return;
    const connection = id(), credentials = await new ComputerService(env, tenant).credentials(c), secret = await seal(JSON.stringify({ connection, credentials }), env);
    await db.query('insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at,managed,subagents) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(tenant,agent) do nothing', [connection, tenant, child, c.provider, JSON.stringify(secret), c.lease_seconds, c.daily_seconds, Date.now(), c.managed, c.subagents]);
  };
  if (sql) await run(sql); else await transaction(env, run);
}

/** Cron repairs missed alarms without holding a database connection during RPC. */
export async function sweepComputers(env: ComputerEnv) {
  const rows = await withSql(env, async sql => (await sql.query("select distinct c.tenant,c.agent from computer_connections c left join agents a on a.id=c.agent and a.tenant=c.tenant left join computer_leases l on l.connection=c.id and l.state<>'closed' where c.agent not like 'removed:%' and (a.id is null or a.revoked or a.purged_at is not null or a.expires_at<=$1 or l.expires_at<=$1 or (l.state='starting' and l.created_at<=$1::bigint-180000) or (l.state in ('closing','uncertain') and l.reference is not null)) limit 100", [Date.now()])).rows);
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await env.AGENTS.getByName(row.agent).fetch(new Request('https://computer.internal/__computer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant: row.tenant, operation: 'sweep' }) }));
      if (!result.ok) failed++;
      await result.body?.cancel();
    } catch { failed++; }
  }
  return { checked: rows.length, failed };
}
