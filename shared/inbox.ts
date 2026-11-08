/** The tenant-wide input index. Both backends read these rows; neither fans out to agents. */
import { Buffer } from 'node:buffer';

type Sql = { query(text: string, values?: any[]): Promise<{ rows: any[] }> };
export class InboxQueryError extends Error {}
const priorities = ['urgent', 'high', 'normal', 'low'];
const kinds = ['question', 'approval', 'form', 'url'];
const states = ['pending', 'answered', 'declined', 'cancelled', 'expired', 'superseded', 'withdrawn'];
export function inboxQuery(params: URLSearchParams, legacy = false) {
  const limit = params.get('limit') ?? (legacy ? '100' : '50');
  const max = legacy ? 500 : 100;
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > max) throw new InboxQueryError(`limit must be an integer from 1 to ${max}`);
  if (legacy) {
    const state = params.get('state');
    if (state !== null && !states.includes(state)) throw new InboxQueryError('Invalid state');
    // The original list has no cursor or inbox filters, including no expiry suppression.
    return { limit: Number(limit), cursor: undefined, for: null, subject: null, root: null, priority: null, kind: null, state };
  }
  for (const [key, choices] of [['priority', priorities], ['kind', kinds], ...(legacy ? [['state', states]] : [])] as [string, string[]][]) {
    if (params.has(key) && !choices.includes(params.get(key)!)) throw new InboxQueryError(`Invalid ${key}`);
  }
  let cursor: [number, number, number, string] | undefined;
  if (params.has('cursor')) {
    try {
      const raw = params.get('cursor')!;
      if (raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      const value = JSON.parse(Buffer.from(raw, 'base64url').toString());
      if (!Array.isArray(value) || value.length !== 4 || !Number.isInteger(value[0]) || value[0] < 0 || value[0] > 3 ||
          !Number.isSafeInteger(value[1]) || !Number.isSafeInteger(value[2]) || typeof value[3] !== 'string' || !value[3].length) throw new Error();
      cursor = value as typeof cursor;
    } catch { throw new InboxQueryError('Invalid inbox cursor'); }
  }
  return { limit: Number(limit), cursor, for: params.get('for'), subject: params.get('subject'), root: params.get('root'),
    priority: params.get('priority'), kind: params.get('kind'), state: legacy ? params.get('state') : 'pending' };
}

/** Keep the established /inputs representation, including its audience object and no stored retry data. */
function inputView(row: any) {
  return { id: row.id, agent: row.agent, tenant: row.tenant, requestId: row.request_id, toolCallId: row.tool_call_id,
    kind: row.kind, message: row.input.message, detail: row.input.detail, responders: row.input.responders,
    state: row.state, ...(row.answer ? { answer: row.answer } : {}), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
}

export async function readInbox(sql: Sql, tenant: string, query: ReturnType<typeof inboxQuery>, legacy = false) {
  const values: any[] = [tenant];
  const where = ['tenant = $1'];
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  // A literal pending predicate lets Postgres use the partial inbox index with a prepared query.
  if (query.state === 'pending' && !legacy) where.push("state = 'pending'", `expires_at > ${bind(Date.now())}`);
  else if (query.state) where.push(`state = ${bind(query.state)}`);
  for (const [column, value] of [['subject', query.subject], ['coalesce(root_agent, agent)', query.root], ['priority', query.priority], ['kind', query.kind]]) {
    if (value !== null) where.push(`${column} = ${bind(value)}`);
  }
  // An API key sees all subjects. Open items have no frozen responders; a named audience is explicit.
  if (query.for !== null) where.push(`(responders @> array[${bind(query.for)}]::text[] or cardinality(responders) = 0)`);
  const filter = where.join(' and ');
  const countValues = [...values];
  let pageFilter = filter;
  if (!legacy && query.cursor) pageFilter += ` and (priority_rank, expires_at, created_at, id) > (${query.cursor.map(bind).join(', ')})`;
  const rows = (await sql.query(`select * from agent_inputs where ${pageFilter}
    order by ${legacy ? "created_at desc, coalesce(input->>'workersInputId', id)" : 'priority_rank, expires_at, created_at, id'} limit ${bind(query.limit + (legacy ? 0 : 1))}`, values)).rows;
  const more = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const counts = { priority: { urgent: 0, high: 0, normal: 0, low: 0 } as Record<string, number>, lead: {} as Record<string, number> };
  if (!legacy) {
    const groups = (await sql.query(`select priority, coalesce(root_agent, agent) as lead, count(*)::int as count
      from agent_inputs where ${filter} group by priority, coalesce(root_agent, agent)`, countValues)).rows;
    for (const group of groups) {
      counts.priority[group.priority] += Number(group.count);
      Object.defineProperty(counts.lead, group.lead, { value: (Object.hasOwn(counts.lead, group.lead) ? counts.lead[group.lead] : 0) + Number(group.count), enumerable: true, configurable: true });
    }
  }
  const last = page.at(-1);
  return { items: page.map(row => legacy ? { ...inputView(row), id: row.input.workersInputId ?? row.id } : { ...inputView(row), priority: row.priority, blocking: row.blocking,
    subject: row.subject, root: row.root_agent ?? row.agent, lineage: row.lineage ?? [row.agent], key: row.item_key, version: row.version }),
    cursor: more && last ? Buffer.from(JSON.stringify([last.priority_rank, Number(last.expires_at), Number(last.created_at), last.id])).toString('base64url') : null, counts };
}
