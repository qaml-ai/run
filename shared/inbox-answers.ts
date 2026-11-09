/** Transport-independent batch coordination. Reads and validation run at the input authority. */
import { createHash, randomUUID } from 'node:crypto';
import { canonical } from './durable-json.ts';
export type InboxAnswer = { agent: string; id: string; version: number; action?: string; content?: unknown; accept?: 'recommended'; actor?: string; from?: unknown };
export type InboxOutcome = { id: string; outcome: 'answered' | 'same' | 'conflict' | 'forbidden' | 'unknown' | 'invalid' | 'unavailable'; status: number; retryable?: boolean; state?: string; by?: unknown; error?: string };
export const unavailable = (id: string): InboxOutcome => ({ id, outcome: 'unavailable', status: 503, retryable: true });
export const inboxAgentFailure = (id: string, error: any): InboxOutcome => [403, 404].includes(error?.status) ? inboxFailure(id, error) : unavailable(id);
export function inboxFailure(id: string, error: any, input?: any): InboxOutcome {
  const status = error?.status;
  if (![400, 403, 404, 409].includes(status)) return unavailable(id);
  return { id, outcome: status === 403 ? 'forbidden' : status === 404 ? 'unknown' : status === 400 ? 'invalid' : 'conflict', status,
    ...(status === 409 && input ? { state: input.expiresAt <= Date.now() && input.state === 'pending' ? 'expired' : input.state, ...(input.answer ? { by: input.answer.by } : {}) } : {}), error: error.message };
}
export function inboxAnswers(body: any): { requestId: string; answers: InboxAnswer[] } {
  if (!body || typeof body.requestId !== 'string' || !body.requestId.length || body.requestId.length > 200 ||
      !Array.isArray(body.answers) || !body.answers.length || body.answers.length > 100 ||
      body.answers.some((a: any) => !a || typeof a.agent !== 'string' || !a.agent.length || typeof a.id !== 'string' || !a.id.length || !Number.isSafeInteger(a.version) || a.version < 1) ||
      new Set(body.answers.map((a: any) => JSON.stringify([a.agent, a.id]))).size !== body.answers.length)
    throw Object.assign(new Error('Send requestId and 1 to 100 different answers with agent, id and version'), { status: 400 });
  return body;
}
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
export async function answerInboxGroup(entries: InboxAnswer[], read: (id: string) => Promise<any>, validate: (input: any, body: any) => { action: string; content?: unknown } | void,
  write: (answers: { id: string; body: any }[]) => Promise<{ status: number }>, partition: (input: any) => string = () => ''): Promise<InboxOutcome[]> {
  const outcomes = new Map<string, InboxOutcome>(), ready: { id: string; body: any; partition: string }[] = [];
  const check = async (entry: InboxAnswer) => {
    let input: any;
    try {
      input = await read(entry.id);
      if (!input) throw Object.assign(new Error('Unknown input'), { status: 404 });
      let body: any = { ...entry };
      if (entry.accept === 'recommended') {
        const recommendation = input.detail?.recommendation;
        if (!recommendation) throw Object.assign(new Error('Input has no recommendation'), { status: 400 });
        body = { ...body, action: 'accept', content: recommendation.answer };
      }
      const normalized = validate(input, body);
      if (normalized) body = { ...body, ...normalized };
      const same = input.state !== 'pending' && input.answer && !input.answer.by.system &&
        input.answer.action === body.action && canonical(input.answer.content ?? null) === canonical(body.content ?? null);
      if (same) { outcomes.set(entry.id, { id: entry.id, outcome: 'same', status: 200 }); return; }
      if (entry.version !== (input.version ?? 1)) throw conflict('Input version moved');
      if (input.state !== 'pending' || input.expiresAt <= Date.now()) throw conflict('Input is already settled or expired');
      return { id: entry.id, body, partition: partition(input) };
    } catch (error) { outcomes.set(entry.id, inboxFailure(entry.id, error, input)); }
  };
  for (const entry of entries) { const item = await check(entry); if (item) ready.push(item); }
  for (const key of [...new Set(ready.map(item => item.partition))].sort()) {
    const group = ready.filter(item => item.partition === key);
    try {
      const result = await write(group);
      for (const item of group) outcomes.set(item.id, { id: item.id, outcome: result.status === 200 ? 'same' : 'answered', status: result.status });
    } catch {
      // Never split a failed write into more notices. Re-read races and classify
      // each item; unchanged pending items remain retryable, not falsely answered.
      for (const item of group) {
        const pending = await check(entries.find(entry => entry.id === item.id)!);
        if (pending) outcomes.set(item.id, unavailable(item.id));
      }
    }
  }
  return entries.map(entry => outcomes.get(entry.id)!);
}

type Sql = { query(text: string, values?: any[]): Promise<{ rows: any[] }> };
export const INBOX_RECEIPT_TTL_MS = 7 * 86400_000;
export async function sweepInboxReceipts(sql: Sql, now = Date.now()) {
  await sql.query(`delete from inbox_answer_receipts where (tenant, request_id) in
    (select tenant, request_id from inbox_answer_receipts where created_at <= $1 order by created_at limit 1000)`, [new Date(now - INBOX_RECEIPT_TTL_MS)]);
}
/** Short database claims only. No transaction or advisory lock spans the agent call. */
export async function inboxReceipt(sql: Sql, tenant: string, body: ReturnType<typeof inboxAnswers>, run: () => Promise<InboxOutcome[]>) {
  const hash = createHash('sha256').update(canonical(body.answers)).digest('hex'), owner = randomUUID();
  const cutoff = () => new Date(Date.now() - INBOX_RECEIPT_TTL_MS);
  for (let attempt = 0; attempt < 100; attempt++) {
    const claimed = (await sql.query(`insert into inbox_answer_receipts (tenant, request_id, answers_hash, owner, claimed_until)
      values ($1,$2,$3,$4,now()+interval '2 minutes') on conflict (tenant,request_id) do update
      set answers_hash=excluded.answers_hash, owner=excluded.owner, claimed_until=excluded.claimed_until,
          created_at=now(), result=null
      where inbox_answer_receipts.created_at <= $5
        or (inbox_answer_receipts.answers_hash=excluded.answers_hash and inbox_answer_receipts.result is null and inbox_answer_receipts.claimed_until <= now())
      returning owner`, [tenant, body.requestId, hash, owner, cutoff()])).rows.length > 0;
    if (claimed) {
      // Keep a slow authority call from losing its receipt to a concurrent retry.
      const renewal = setInterval(() => { void sql.query(`update inbox_answer_receipts
        set claimed_until=now()+interval '2 minutes' where tenant=$1 and request_id=$2 and owner=$3 and result is null`,
        [tenant, body.requestId, owner]).catch(() => {}); }, 30_000);
      try {
        const result = { outcomes: await run() };
        const saved = await sql.query(`update inbox_answer_receipts set result=$4, claimed_until=null
          where tenant=$1 and request_id=$2 and owner=$3 returning request_id`, [tenant, body.requestId, owner, JSON.stringify(result)]);
        if (!saved.rows.length) throw Object.assign(new Error('Inbox receipt claim expired; retry'), { status: 503 });
        return result;
      } catch (error) {
        await sql.query('delete from inbox_answer_receipts where tenant=$1 and request_id=$2 and owner=$3 and result is null', [tenant, body.requestId, owner]);
        throw error;
      } finally { clearInterval(renewal); }
    }
    const previous = (await sql.query(`select answers_hash,result from inbox_answer_receipts
      where tenant=$1 and request_id=$2 and created_at > $3`, [tenant, body.requestId, cutoff()])).rows[0];
    if (previous?.answers_hash !== undefined && previous.answers_hash !== hash) throw conflict('requestId was already used with different answers');
    if (previous?.result) return previous.result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Object.assign(new Error('Inbox request is still running; retry'), { status: 503 });
}
