/** Tenant-scoped transcript export. Cursors retain the source message indexes. */
export interface TranscriptRequest { id: string; method?: string; state?: string; startedAt?: number; began?: number; endedAt?: number; endUser?: string; params?: unknown; }
export interface TranscriptScope { subject?: string; requests: TranscriptRequest[] }
export interface TranscriptStore {
  query(text: string, values: unknown[]): Promise<{ rows: any[] }>;
  page(agent: string, after: number, limit: number): Promise<{ entries: { index: number; message: any }[]; total: number; nextAfter?: number }>;
  descendants?(tenant: string, root: string): Promise<string[]>;
  scope?(agent: string): Promise<TranscriptScope>;
}
export interface TranscriptQuery { from: number; to: number; cursor?: string; limit?: number; children?: boolean; endUser?: string }
export interface TranscriptPage { agentId: string | null; entries: { index: number; message: unknown }[]; next: string | null }
export class TranscriptError extends Error { status = 400; }
export async function transcriptAgents(store: TranscriptStore, tenant: string, root: string, children = true) {
  const extra = children && store.descendants ? await store.descendants(tenant, root) : [];
  const { rows } = await store.query(`with recursive edges(parent, child) as (
    select parent, child from agent_children where tenant=$2
    union select header->>'parentAgentId', id from agents where tenant=$2 and header->>'parentAgentId' is not null
  ), tree(id) as (
    select id from agents where id=$1 and tenant=$2 and not revoked and purged_at is null
    union select id from agents where id=any($5::text[]) and tenant=$2
    union select c.child from edges c join tree t on t.id=c.parent where $3
  ) select a.id from tree join agents a on a.id=tree.id where a.tenant=$2 and not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at > $4) order by a.id`, [root, tenant, children, Date.now(), extra]);
  return rows.map(row => row.id as string);
}
/** Fail closed when a message cannot be attributed to a retained request. */
export function messageEndUser(message: any, scope: TranscriptScope): string | undefined {
  const requests = scope.requests;
  const own = message.requestId && requests.find(request => request.id === message.requestId);
  const at = typeof message.timestamp === 'number' ? message.timestamp : NaN;
  const request = own || requests.filter(request => (request.began !== undefined || request.state === 'completed') && request.method !== 'steer' && (request.began ?? request.startedAt ?? Infinity) <= at && at <= (request.endedAt ?? Infinity))
    .sort((a,b) => (b.began ?? b.startedAt ?? 0) - (a.began ?? a.startedAt ?? 0))[0];
  return request ? request.endUser ?? (request.params as {endUser?: string} | undefined)?.endUser ?? scope.subject : undefined;
}
export async function sessionTranscripts(store: TranscriptStore, tenant: string, root: string, query: TranscriptQuery): Promise<TranscriptPage> {
  const { from, to, children = true, limit = 100, endUser } = query;
  if (![from, to].every(n => Number.isSafeInteger(n) && n >= 0) || from >= to || !Number.isInteger(limit) || limit < 1 || limit > 500 || (endUser !== undefined && (!endUser || endUser.length > 256)))
    throw new TranscriptError('from and to are epoch milliseconds (from < to); limit is 1 to 500; endUser must be a nonempty identifier');
  let agent = '', after = 0;
  if (query.cursor) {
    try {
      const token = JSON.parse(decodeURIComponent(query.cursor));
      if (token.root !== root || token.from !== from || token.to !== to || token.children !== children || token.endUser !== endUser || typeof token.agent !== 'string' || !Number.isSafeInteger(token.after) || token.after < 0) throw 0;
      agent = token.agent; after = token.after;
    } catch { throw new TranscriptError('Invalid transcript cursor'); }
  }
  const id = (await transcriptAgents(store, tenant, root, children)).find(id => id >= agent);
  if (!id) return { agentId: null, entries: [], next: null };
  const page = await store.page(id, id === agent ? after : 0, limit);
  const offset = page.nextAfter ?? (page.entries.at(-1)?.index === undefined ? page.total : page.entries.at(-1)!.index + 1);
  if (offset <= (id === agent ? after : 0) && offset < page.total) throw new Error('Transcript page did not advance');
  const nextAgent = offset < page.total ? id : `${id}\u0001`;
  const next = encodeURIComponent(JSON.stringify({ root, from, to, children, endUser, agent: nextAgent, after: offset < page.total ? offset : 0 }));
  const scope = endUser !== undefined ? await store.scope?.(id) : undefined;
  return { agentId: id, entries: page.entries.filter(({ message }) => typeof message.timestamp === 'number' && message.timestamp >= from && message.timestamp < to && (endUser === undefined || scope && messageEndUser(message, scope) === endUser)), next };
}
