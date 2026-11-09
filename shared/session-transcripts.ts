/** Tenant-scoped, bounded transcript export for one conversation tree. No cache. */
export interface TranscriptStore {
  query(text: string, values: unknown[]): Promise<{ rows: any[] }>;
  page(agent: string, after: number, limit: number): Promise<{ entries: { index: number; message: any }[]; total: number; nextAfter?: number }>;
}
export interface TranscriptQuery { from: number; to: number; cursor?: string; limit?: number; children?: boolean }
export interface TranscriptPage { agentId: string | null; entries: { index: number; message: unknown }[]; next: string | null }
export class TranscriptError extends Error { status = 400; }
export async function sessionTranscripts(store: TranscriptStore, tenant: string, root: string, query: TranscriptQuery): Promise<TranscriptPage> {
  const { from, to, children = true, limit = 100 } = query;
  if (![from, to].every(n => Number.isSafeInteger(n) && n >= 0) || from >= to || !Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new TranscriptError('from and to are epoch milliseconds (from < to); limit is 1 to 500');
  let agent = '', after = 0;
  if (query.cursor) {
    try {
      const token = JSON.parse(decodeURIComponent(query.cursor));
      if (token.root !== root || token.from !== from || token.to !== to || token.children !== children || typeof token.agent !== 'string' || !Number.isSafeInteger(token.after) || token.after < 0) throw 0;
      agent = token.agent; after = token.after;
    } catch { throw new TranscriptError('Invalid transcript cursor'); }
  }
  // UNION (not UNION ALL) also terminates if legacy lineage contains a cycle.
  const { rows } = await store.query(`with recursive edges(parent, child) as (
    select parent, child from agent_children where tenant=$2
    union select header->>'parentAgentId', id from agents where tenant=$2 and header->>'parentAgentId' is not null
  ), tree(id) as (
    select id from agents where id=$1 and tenant=$2 and not revoked and purged_at is null
    union select c.child from edges c join tree t on t.id=c.parent where $3
  ) select a.id from tree join agents a on a.id=tree.id where a.tenant=$2 and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at > $5) and a.id >= $4 order by a.id limit 1`, [root, tenant, children, agent, Date.now()]);
  if (!rows.length) return { agentId: null, entries: [], next: null };
  const id = rows[0].id as string;
  const page = await store.page(id, id === agent ? after : 0, limit);
  const offset = page.nextAfter ?? (page.entries.at(-1)?.index === undefined ? page.total : page.entries.at(-1)!.index + 1);
  if (offset <= (id === agent ? after : 0) && offset < page.total) throw new Error('Transcript page did not advance');
  const nextAgent = offset < page.total ? id : `${id}\u0001`;
  const next = encodeURIComponent(JSON.stringify({ root, from, to, children, agent: nextAgent, after: offset < page.total ? offset : 0 }));
  return { agentId: id, entries: page.entries.filter(({ message }) => typeof message.timestamp === 'number' && message.timestamp >= from && message.timestamp < to), next };
}
