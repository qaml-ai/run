import { createHash, randomBytes } from 'node:crypto';
import { z } from '@hono/zod-openapi';
import type { Db, Sql } from './db.ts';
import { HttpError } from './core/http-error.ts';

export const ShareLinkInput = z.object({ expiresIn: z.union([z.literal(86400), z.literal(604800), z.literal(2592000)]).nullable().optional() }).strict();
export const MemberInput = z.object({ dailyCapMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(), removed: z.literal(false).optional() }).strict().refine(x => Object.keys(x).length > 0);
export const ShareLink = z.object({ id: z.string(), createdAt: z.number(), expiresAt: z.number().nullable(), revokedAt: z.number().nullable(), joins: z.number(), lastJoinedAt: z.number().nullable() });
export const CreatedShareLink = z.object({ id: z.string(), url: z.string(), expiresAt: z.number().nullable() });
export const Member = z.object({ id: z.string(), name: z.string(), email: z.string().nullable(), role: z.enum(['owner', 'guest']), addedAt: z.number(), removedAt: z.number().nullable(), dailyCapMicros: z.number().int().nullable(), spentToday: z.number() });
const linkColumns = 'id, created_at as "createdAt", expires_at as "expiresAt", revoked_at as "revokedAt", joins, last_joined_at as "lastJoinedAt"';
const memberColumns = `m.id, m.name, m.email, m.role, m.added_at as "addedAt", m.removed_at as "removedAt", m.daily_cap as "dailyCapMicros", coalesce(d.charge, 0) as "spentToday"`;
const id = (prefix: string) => prefix + randomBytes(8).toString('hex');

/** S4 guest routes must also check membership; admission rechecks after asynchronous preparation. */
export async function requireActiveMember(sql: Sql, tenant: string, agent: string, actor?: string) {
  if (!actor?.startsWith('member:')) return;
  const found = await sql.query('select 1 from agent_members where tenant=$1 and agent=$2 and id=$3 and removed_at is null', [tenant, agent, actor.slice(7)]);
  if (!found.rows.length) throw new HttpError(403, 'Membership is no longer active');
}

/** Shared SQL policy for both HTTP backends. No link secret leaves the create response. */
export class SharedAgents {
  private db: Db;
  constructor(db: Db) { this.db = db; }
  private async transaction<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
    const sql = await this.db.connect();
    try { await sql.query('begin'); const result = await run(sql); await sql.query('commit'); return result; }
    catch (error) { await sql.query('rollback'); throw error; }
    finally { sql.release(); }
  }
  async create(tenant: string, agent: string, input: z.infer<typeof ShareLinkInput>, origin: string) {
    return this.transaction(async sql => {
      // Serializes creation, including the first owner row and the per-agent rate limit.
      const row = (await sql.query('select header from agents where id=$1 and tenant=$2 and not revoked for update', [agent, tenant])).rows[0];
      if (!row) throw new HttpError(404, 'Unknown agent');
      if (row.header.parent || row.header.parentAgentId) throw new HttpError(400, 'Sub-agents cannot be shared');
      const now = Date.now();
      const count = (await sql.query('select count(*)::int as n from agent_share_links where tenant=$1 and agent=$2 and created_at>$3', [tenant, agent, now - 3600000])).rows[0].n;
      if (count >= 100) throw new HttpError(429, 'Share link creation limit reached');
      const identity = (await sql.query(`select coalesce(t.google_email, p.email) as email, t.github, (select name from console_sessions where tenant=t.id and name is not null order by created_at desc limit 1) as name from tenants t left join tenant_passwords p on p.tenant=t.id where t.id=$1`, [tenant])).rows[0];
      const name = identity?.name || identity?.github || identity?.email?.split('@')[0] || 'Owner';
      await sql.query(`insert into agent_members (id, tenant, agent, person, role, name, email, added_at) values ($1,$2,$3,$2,'owner',$4,$5,$6) on conflict (agent, person) do nothing`, [id('m_'), tenant, agent, name, identity?.email ?? null, now]);
      const secret = randomBytes(32).toString('base64url');
      const link = id('asl_');
      const expiresAt = input.expiresIn === null ? null : now + (input.expiresIn ?? 604800) * 1000;
      await sql.query('insert into agent_share_links (id,tenant,agent,sha256,created_at,expires_at) values ($1,$2,$3,$4,$5,$6)', [link,tenant,agent,createHash('sha256').update(secret).digest(),now,expiresAt]);
      return { id: link, url: `${origin.replace(/\/$/, '')}/console/join#t=${secret}`, expiresAt };
    });
  }
  async links(tenant: string, agent: string) {
    return (await this.db.query(`select ${linkColumns} from agent_share_links where tenant=$1 and agent=$2 order by created_at,id`, [tenant,agent])).rows;
  }
  async revoke(tenant: string, agent: string, link: string) {
    const result = await this.db.query('update agent_share_links set revoked_at=coalesce(revoked_at,$4) where tenant=$1 and agent=$2 and id=$3', [tenant,agent,link,Date.now()]);
    if (!result.rowCount) throw new HttpError(404, 'Unknown share link');
  }
  async members(tenant: string, agent: string) {
    const rows = (await this.db.query(`select ${memberColumns} from agent_members m left join agent_member_days d on d.member=m.id and d.day=(now() at time zone 'UTC')::date where m.tenant=$1 and m.agent=$2 order by m.added_at,m.id`, [tenant,agent])).rows;
    return rows.map(row => ({ ...row, spentToday: row.spentToday / 1e6 }));
  }
  async change(tenant: string, agent: string, member: string, input: z.infer<typeof MemberInput> | 'remove') {
    const remove = input === 'remove';
    const result = await this.db.query(`update agent_members set
      removed_at=case when $4 then coalesce(removed_at,$5) when $6 then null else removed_at end,
      daily_cap=case when $7 then $8 else daily_cap end, revision=revision+1
      where tenant=$1 and agent=$2 and id=$3 and role='guest' returning id`,
      [tenant,agent,member,remove,Date.now(),!remove && input.removed === false,!remove && 'dailyCapMicros' in input,!remove && input.dailyCapMicros != null ? input.dailyCapMicros : null]);
    if (!result.rowCount) {
      const owner = (await this.db.query('select 1 from agent_members where tenant=$1 and agent=$2 and id=$3 and role=\'owner\'', [tenant,agent,member])).rows.length;
      throw new HttpError(owner ? 400 : 404, owner ? 'Only guests can have a daily cap, be removed or be restored' : 'Unknown member');
    }
  }
}
