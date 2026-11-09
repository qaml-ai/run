import { keyServices } from "../security-services.ts";
import { reserveComputer, releaseComputer, suspendComputer, beginComputerUse, endComputerUse, computerToolError } from "../../../../src/core/computer-limit.ts";
import { computerOwner, SHARED_COMPUTER_CONTROL, SHARED_COMPUTER_STOPPED } from "../../../../src/core/computer-share.ts";
import { z } from 'zod';
import { transaction, withSql, type Sql } from '../postgres.ts';
import { seal, unseal } from '../webhooks.ts';
import type { ControlEnv } from '../control.ts';
import { HttpError } from '../errors.ts';
import { COMMON, SHELL, BROWSER, COMPUTER_TOOLS, PROVIDERS, isBrowserProvider, fileCommand, storable, type Credentials, type ComputerDriver, type Provider } from './policy.ts';
import { remoteDriver, type RemoteBindings } from './remote.ts';
import { connectionForkable, FORK_LIMITS, forkableProvider, forkedFrom, forkRows, forkUnsupported, noSession, notForkable, snapshotFailed, snapshotRef, type ForkedFrom, type SnapshotRef } from '../../../../src/core/computer-fork.ts';
export type ComputerEnv = ControlEnv & RemoteBindings & { COMPUTER_MANAGED_ENABLED?: string };
const id = () => `cmp_${crypto.randomUUID().replaceAll('-', '')}`;
/** A fork snapshot's sealed reference: the snapshot and the provider account's credentials that drop it, bound to its row. */
type SnapshotSecret = { snapshot: string; ref: SnapshotRef; provider: string; credentials: Credentials };
const input = z.object({ agent: z.string().min(1), provider: z.enum([...PROVIDERS, 'container']), credentials: z.record(z.string(), z.string()).optional(),
  subagents: z.boolean().optional(), forkable: z.boolean().optional(), leaseSeconds: z.number().int().min(60).max(86400).optional(), dailySeconds: z.number().int().min(60).max(86400).optional() }).strict();
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
  const expected = connection.provider === 'tunnel' ? ['apiKey','url'] : ['apiKey'];
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
const publicConnection = (r: any) => ({ id: r.id, agent: r.agent, provider: r.provider, managed: !!r.managed, subagents: r.subagents, leaseSeconds: r.lease_seconds, dailySeconds: r.daily_seconds, createdAt: Number(r.created_at), billing: r.managed ? 'credits' : 'provider_account', session: publicLease(r.lease), forkable: connectionForkable(r), ...forkedFrom(r) ? { forkedFrom: forkedFrom(r) } : {} });
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
    agent = sql ? await computerOwner(sql, this.tenant, agent) : await withSql(this.env, db => computerOwner(db, this.tenant, agent));
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
      const row = (await sql.query('insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at,managed,subagents,forkable) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *', [connection, this.tenant, parsed.agent, parsed.provider, JSON.stringify(credentials), parsed.leaseSeconds, parsed.dailySeconds, Date.now(), parsed.managed, parsed.subagents ?? true, parsed.forkable ?? null])).rows[0];
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
  /**
   * A fork snapshot of `parent`'s connection for one call (`batch`): taken once and shared by every child of that call,
   * as src/computers/service.ts does. Runs in the parent agent DO's serial queue, so it never races the parent's own
   * computer calls. Answers undefined when the parent has no connection (its native computer may still fork).
   */
  async forkSnapshot(parent: string, batch: string): Promise<{ id: string; connection: string; provider: string; at: number } | undefined> {
    const c = await this.hasConnection(parent);
    if (!c) return undefined;
    const existing = await withSql(this.env, sql => forkRows.batch(sql, c.id, batch));
    if (existing?.state === 'ready') return { id: existing.id, connection: c.id, provider: existing.provider, at: Number(existing.created_at) };
    if (isBrowserProvider(c.provider) || (!c.managed && !forkableProvider(c.provider))) throw forkUnsupported(c.provider);
    const driver = await this.driver(c);
    if (!driver.snapshot) throw forkUnsupported(c.provider);
    if (!connectionForkable(c)) throw notForkable(c.provider);
    const lease = await withSql(this.env, sql => latest(sql, c.id));
    if (!lease || lease.state !== 'active' || !lease.reference || Number(lease.expires_at) <= Date.now()) throw noSession();
    // The parent DO's serial queue runs one fork at a time, so this call wins the batch's row (a stale one is cleared first).
    if (existing) await withSql(this.env, sql => forkRows.abandon(sql, existing.id));
    const snapshot = `cms_${crypto.randomUUID().replaceAll('-', '')}`, at = Date.now();
    await withSql(this.env, sql => forkRows.claim(sql, { id: snapshot, tenant: this.tenant, connection: c.id, agent: parent, batch, provider: c.provider, created_at: at }));
    let ref: SnapshotRef;
    try { ref = await driver.snapshot(JSON.parse(await unseal(lease.reference, this.env)), `camelrun-${snapshot}`); }
    catch (error) { await withSql(this.env, sql => forkRows.abandon(sql, snapshot)).catch(() => {}); throw snapshotFailed(c.provider, error); }
    const secret: SnapshotSecret = { snapshot, ref, provider: c.provider, credentials: await this.credentials(c) };
    await withSql(this.env, async sql => forkRows.ready(sql, snapshot, JSON.stringify(await seal(JSON.stringify(secret), this.env))));
    console.error(JSON.stringify({ type: 'computer_snapshot', tenant: this.tenant, agent: parent, snapshot, provider: c.provider, ...ref.sizeBytes !== undefined ? { bytes: ref.sizeBytes } : {} }));
    return { id: snapshot, connection: c.id, provider: c.provider, at };
  }
  /** The fork route's targets, before anything is snapshotted: the tenant's live agents, none with a connection. */
  async forkTargets(source: string, agents: string[]) {
    await withSql(this.env, async sql => {
      if (!(await sql.query('select 1 from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3)', [this.tenant, source, Date.now()])).rowCount) throw new HttpError(404, 'Unknown agent');
      for (const agent of agents) {
        if (agent === source) throw new HttpError(400, 'An agent cannot fork its computer into itself');
        if (!(await sql.query('select 1 from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3)', [this.tenant, agent, Date.now()])).rowCount) throw new HttpError(404, `Unknown agent ${agent}`);
        if ((await sql.query('select 1 from computer_connections where tenant=$1 and agent=$2', [this.tenant, agent])).rowCount) throw new HttpError(409, `Agent ${agent} already has a computer connection; remove it first`);
      }
    });
  }
  /** Connections for `agents` that start from `snapshot` (forkSnapshot), for the fork route. Each agent must have none yet. */
  async forkInto(source: string, snapshot: { id: string; connection: string; provider: string; at: number }, agents: string[]) {
    // One transaction: every target gets its connection, or none does.
    return transaction(this.env, async sql => {
      const seed = await forkRows.attachable(sql, snapshot.id, this.tenant);
      const c = (await sql.query("select * from computer_connections where tenant=$1 and id=$2 and agent not like 'removed:%' for share", [this.tenant, snapshot.connection])).rows[0];
      if (!seed || !c) throw new HttpError(409, "The source's computer connection was removed; nothing to fork");
      const forks = [];
      for (const agent of agents) {
        if (!(await sql.query('select 1 from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3) for update', [this.tenant, agent, Date.now()])).rowCount) throw new HttpError(404, `Unknown agent ${agent}`);
        const row = await attachConnection(this.env, sql, this.tenant, agent, c, seed);
        if (!row) throw new HttpError(409, `Agent ${agent} already has a computer connection; remove it first`);
        forks.push(publicConnection(row));
      }
      return forks;
    });
  }
  /** A child's computer when its work is done (a delegate call answered): its session stops, its connection stays. */
  async release(agent: string) {
    if (await withSql(this.env, sql => computerOwner(sql, this.tenant, agent)) !== agent || !(await this.hasConnection(agent))) return;
    try { await this.call(agent, 'computer_stop', {}, `release-${crypto.randomUUID()}`); }
    catch { console.error(JSON.stringify({ type: 'computer_release_failed', tenant: this.tenant, agent })); }
  }
  /** The snapshot a forked connection's sessions start from. */
  private async seedOf(c: any): Promise<SnapshotRef | undefined> {
    if (!c.seed) return undefined;
    const row = await withSql(this.env, sql => forkRows.get(sql, c.seed));
    if (!row || row.dropped_at !== null || row.state !== 'ready') throw new HttpError(409, 'This computer was forked from a snapshot that is gone. Its owner can remove the connection and connect it again.');
    return snapshotRef((await openSnapshot(this.env, row)).ref);
  }
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
    await withSql(this.env, sql => releaseComputer(sql, this.tenant, c.id));
  }
  /** Mutations run inside the owning agent DO's serial queue. Never hold PG over provider I/O. */
  async call(agent: string, name: string, args: Record<string, any>, key: string) {
    if (!COMPUTER_TOOLS.has(name)) throw new HttpError(400, 'Unknown computer tool');
    const c = await this.connection(agent);
    if (c.agent !== agent && ['computer_start', 'computer_stop'].includes(name)) throw new HttpError(409, SHARED_COMPUTER_CONTROL);
    if (c.agent !== agent) key = `${agent}:${key}`;
    if (!(await this.tools(agent)).some(t => t.name === name)) throw new HttpError(400, 'Tool not supported by this computer');
    const encoded = JSON.stringify([name, args]);
    if (encoded.length > 40000 || typeof key !== 'string' || !key || key.length > 256 || !args || typeof args !== 'object' || Array.isArray(args)) throw new HttpError(400, 'Invalid computer operation');
    let lease = await withSql(this.env, sql => latest(sql, c.id));
    if (c.agent !== agent && name !== 'computer_status' && !lease) {
      const stopped = await withSql(this.env, sql => sql.query(`select 1 from computer_operations where connection=$1 and result @> '{"stopped":true}'::jsonb limit 1`, [c.id]));
      if (!stopped.rowCount) {
        await this.call(c.agent, 'computer_start', {}, `shared-first-use:${c.id}`);
        lease = await withSql(this.env, sql => latest(sql, c.id));
      }
    }
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
        if (c.agent !== agent && (!lease || lease.state !== "active" || Number(lease.expires_at) <= Date.now())) throw new HttpError(409, SHARED_COMPUTER_STOPPED, "COMPUTER_STOPPED");
        if (lease && lease.state !== 'closed' && Number(lease.expires_at) <= Date.now()) { await this.stop(c, lease); lease = undefined; }
        if (name === 'computer_start') {
          if (lease && lease.state !== 'closed') { if (lease.state !== 'active') throw new HttpError(409, 'Computer needs provider cleanup before restart'); result = publicLease(lease); }
          else {
            const used = await withSql(this.env, async sql => Number((await sql.query('select coalesce(sum(greatest(0,least(coalesce(closed_at,expires_at),expires_at)-greatest(created_at,$2))),0) as used from computer_leases where connection=$1 and expires_at>$2', [c.id, Math.floor(Date.now()/86400000)*86400000])).rows[0].used));
            if (used + c.lease_seconds * 1000 > c.daily_seconds * 1000) throw new HttpError(429, 'Computer daily time budget reached');
            // A forked connection's every new session starts from its seed, the parent's disk as it was at the fork.
            const from = await this.seedOf(c);
            await transaction(this.env, async sql => reserveComputer(sql, this.tenant, c.agent, c.id, Date.now() + c.lease_seconds * 1000, Date.now(), (await keyServices(this.env)).accounts.tenants.computerLimit(this.tenant)));
            const session = id(), now = Date.now();
            lease = await withSql(this.env, async sql => (await sql.query("insert into computer_leases(id,tenant,agent,connection,provider,state,created_at,expires_at) values($1,$2,$3,$4,$5,'starting',$6,$7) returning *", [session, this.tenant, c.agent, c.id, c.provider, now, now+c.lease_seconds*1000])).rows[0]);
            let driver: ComputerDriver | undefined, allocated = false;
            try {
              driver = await this.driver(c);
              const ref = await driver.create(session, c.lease_seconds, async value => { allocated = true; const secret = await seal(JSON.stringify(value), this.env); await withSql(this.env, sql => sql.query('update computer_leases set reference=$2 where id=$1', [session, JSON.stringify(secret)])); }, { ...from ? { from } : {}, forkable: connectionForkable(c) });
              const secret = await seal(JSON.stringify(ref), this.env);
              await withSql(this.env, sql => sql.query("update computer_leases set state='active',reference=$2 where id=$1", [session, JSON.stringify(secret)]));
            } catch (error) {
              const refused = !allocated && (error instanceof HttpError && error.status === 503 || driver?.refused?.(error));
              await withSql(this.env, sql => sql.query('update computer_leases set state=$2,error=$3,closed_at=$4 where id=$1', [session, refused ? 'closed' : 'uncertain', refused ? 'Provider refused the credentials' : 'Creation outcome unknown', refused ? Date.now() : null]));
              if (refused) await withSql(this.env, sql => releaseComputer(sql, this.tenant, c.id));
              throw new HttpError(502, refused ? 'The provider refused its credentials; reconnect the computer' : 'Computer creation outcome unknown; confirm provider cleanup');
            }
            result = publicLease({ ...lease, state: 'active' });
          }
        } else {
          if (!lease || lease.state !== 'active') throw new HttpError(409, 'Call computer_start before using the computer');
          const ref = JSON.parse(await unseal(lease.reference, this.env));
          if (c.provider === 'lambda') {
            const driver = await this.driver(c);
            if (driver.running && !(await driver.running(ref))) {
              await withSql(this.env, sql => suspendComputer(sql, this.tenant, c.id));
            }
            await transaction(this.env, async sql => {
              await reserveComputer(sql, this.tenant, c.agent, c.id, Number(lease.expires_at), Date.now(), (await keyServices(this.env)).accounts.tenants.computerLimit(this.tenant));
              await beginComputerUse(sql, this.tenant, c.id, Date.now() + (timeout + 60) * 1000);
            });
          }
          const remainingSeconds = Math.max(1, Math.floor((Number(lease.expires_at)-Date.now())/1000));
          try { result = storable(await (await this.driver(c)).call(ref, name, { ...args, command, requestKey: key, timeoutSeconds: Math.min(timeout, remainingSeconds), remainingSeconds })); }
          finally { if (c.provider === 'lambda') await withSql(this.env, sql => endComputerUse(sql, this.tenant, c.id)); }
        }
      }
      await withSql(this.env, sql => sql.query("update computer_operations set state='completed',result=$3 where connection=$1 and key=$2", [c.id, key, JSON.stringify(result)]));
      return result;
    } catch (error) {
      await withSql(this.env, sql => sql.query("update computer_operations set state='uncertain' where connection=$1 and key=$2", [c.id, key]));
      if (c.agent !== agent && (error as { code?: string }).code === 'COMPUTER_STOPPED') throw new HttpError(409, SHARED_COMPUTER_STOPPED, 'COMPUTER_STOPPED');
      throw computerToolError(error);
    }
  }
  private async detach(c: any) {
    await this.stop(c, await withSql(this.env, sql => latest(sql, c.id)));
    await withSql(this.env, sql => sql.query("update computer_connections set agent=$2,credentials=$3 where id=$1", [c.id, `removed:${c.id}`, '{}']));
    // The last connection started from a fork snapshot takes it with it.
    const orphan = c.seed ? await withSql(this.env, sql => forkRows.orphaned(sql, c.seed, Date.now() - FORK_LIMITS.dropGraceMs)) : undefined;
    if (orphan) await dropSnapshot(this.env, orphan);
    return { removed: true };
  }
  async remove(agent: string) { const c = await this.connection(agent); if (c.agent !== agent) throw new HttpError(409, SHARED_COMPUTER_CONTROL); return this.detach(c); }
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

  async confirmCleanup(agent: string) { const c = await this.connection(agent); if (c.agent !== agent) throw new HttpError(409, SHARED_COMPUTER_CONTROL); const lease = await withSql(this.env, sql => latest(sql, c.id)); if (!lease || !['uncertain','closing'].includes(lease.state)) throw new HttpError(409, 'Only a failed creation or cleanup can be confirmed manually'); await withSql(this.env, sql => sql.query("update computer_leases set state='closed',closed_at=$2,reference=null,error=null where id=$1", [lease.id, Date.now()]));
    await withSql(this.env, sql => releaseComputer(sql, this.tenant, c.id)); return { confirmed: true }; }
  async usage() { return withSql(this.env, async sql => (await sql.query('select workspace,provider,count(*)::integer as sessions,sum(greatest(0,least(coalesce(closed_at,$2),expires_at)-created_at))/1000.0 as seconds from computer_leases where tenant=$1 group by workspace,provider', [this.tenant, Date.now()])).rows.map(row => ({ ...row, costUsd: 0 }))); }
}
/** A connection for `agent` with `c`'s provider and settings (credentials sealed for it), started from `seed` when forked. */
async function attachConnection(env: ComputerEnv, db: Sql, tenant: string, agent: string, c: any, seed?: { id: string; agent: string; provider: string; created_at: string | number }) {
  const connection = id(), credentials = await new ComputerService(env, tenant).credentials(c), secret = await seal(JSON.stringify({ connection, credentials }), env);
  const from: ForkedFrom | null = seed ? { agent: seed.agent, connection: c.id, snapshot: seed.id, provider: seed.provider, at: Number(seed.created_at) } : null;
  return (await db.query('insert into computer_connections(id,tenant,agent,provider,credentials,lease_seconds,daily_seconds,created_at,managed,subagents,seed,forked_from,forkable) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict(tenant,agent) do nothing returning *', [connection, tenant, agent, c.provider, JSON.stringify(secret), c.lease_seconds, c.daily_seconds, Date.now(), c.managed, c.subagents, seed?.id ?? null, from && JSON.stringify(from), c.forkable ?? null])).rows[0];
}
/**
 * Copy the parent's attachment for a child just made: a new machine, never the parent's session. `computer` is the
 * delegate or spawn_agent call's choice: "none" attaches nothing; `{ seed }` (a fork snapshot the call took,
 * `ComputerService.forkSnapshot`) attaches a connection whose sessions start from it, whatever the parent's `subagents`.
 */
export async function inheritComputer(env: ComputerEnv, tenant: string, parent: string, child: string, sql?: Sql, computer?: 'none' | { seed: string }) {
  if (computer === 'none') return;
  const run = async (db: Sql) => {
    parent = await computerOwner(db, tenant, parent);
    // Locked (FOR SHARE) until the child's transaction ends, so a drop cannot take it meanwhile.
    const seed = computer?.seed ? await forkRows.attachable(db, computer.seed, tenant) : undefined;
    if (computer?.seed && !seed) throw new HttpError(409, "The fork's snapshot is gone; fork again");
    const c = (await db.query(seed ? "select * from computer_connections where tenant=$1 and id=$2 and agent not like 'removed:%' for share" : 'select * from computer_connections where tenant=$1 and agent=$2 and subagents for share', [tenant, seed ? seed.connection : parent])).rows[0];
    if (!c) { if (seed) throw new HttpError(409, "The parent's computer connection was removed; nothing to fork"); return; }
    await attachConnection(env, db, tenant, child, c, seed);
  };
  if (sql) await run(sql); else await transaction(env, run);
}

/** A fork snapshot row's sealed reference, opened and checked against its row. */
async function openSnapshot(env: ComputerEnv, row: { id: string; reference: string }): Promise<SnapshotSecret> {
  const secret = JSON.parse(await unseal(JSON.parse(row.reference), env)) as SnapshotSecret;
  if (secret.snapshot !== row.id) throw new Error('Computer snapshot binding mismatch');
  return secret;
}
/**
 * Delete a fork snapshot no connection starts from any more (`force`: whatever starts from it, for account deletion).
 * The row is locked while the provider deletes it and checked again under the lock. A failure backs off and the sweep
 * tries again; past the last attempt it is given up and logged. Answers whether it is gone.
 */
async function dropSnapshot(env: ComputerEnv, row: { id: string; tenant: string }, force = false) {
  try {
    return await transaction(env, async sql => {
      const current = await forkRows.lockForDrop(sql, row.id, force);
      if (!current) return false;
      const secret = await openSnapshot(env, current);
      await remoteDriver(env, current.tenant, '', secret.provider as Provider, secret.credentials).dropSnapshot?.(snapshotRef(secret.ref));
      await forkRows.dropped(sql, current.id, Date.now());
      return true;
    });
  } catch (error) {
    const gaveUp = await withSql(env, sql => forkRows.failed(sql, row.id, (error as Error).message ?? 'drop failed', Date.now())).catch(() => false);
    console.error(JSON.stringify({ type: gaveUp ? 'computer_snapshot_abandoned' : 'computer_snapshot_drop_failed', tenant: row.tenant, snapshot: row.id }));
    return false;
  }
}
/** Fork snapshots no connection starts from any more (a failed drop, or a fork whose children never attached). */
export async function sweepSnapshots(env: ComputerEnv) {
  const rows = await withSql(env, sql => forkRows.unused(sql, Date.now() - FORK_LIMITS.dropGraceMs, Date.now()));
  for (const row of rows) await dropSnapshot(env, row);
  return rows.length;
}
/** An account deletion: every open fork snapshot of the account goes, whatever starts from it; throws while any is left. */
export async function dropTenantSnapshots(env: ComputerEnv, tenant: string) {
  let left = 0;
  for (const row of await withSql(env, sql => forkRows.ofTenant(sql, tenant))) if (!(await dropSnapshot(env, row, true))) left++;
  left += await withSql(env, sql => forkRows.takingOf(sql, tenant));
  if (left) throw new Error(`${left} computer snapshots are not deleted yet`);
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
