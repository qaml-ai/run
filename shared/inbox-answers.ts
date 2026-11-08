/** Transport-independent batch coordination. Reads and validation run at the input authority. */
export type InboxAnswer = { id: string; version: number; action?: string; content?: unknown; accept?: 'recommended'; actor?: string; from?: unknown };
export type InboxOutcome = { id: string; outcome: 'answered' | 'same' | 'conflict' | 'forbidden' | 'unknown' | 'invalid'; status: number; state?: string; by?: unknown; error?: string };
export function inboxAnswers(body: any): { requestId: string; answers: InboxAnswer[] } {
  if (!body || typeof body.requestId !== 'string' || !body.requestId.length || body.requestId.length > 200 ||
      !Array.isArray(body.answers) || !body.answers.length || body.answers.length > 100 ||
      body.answers.some((a: any) => !a || typeof a.id !== 'string' || !a.id.length || !Number.isSafeInteger(a.version) || a.version < 1) ||
      new Set(body.answers.map((a: any) => a.id)).size !== body.answers.length)
    throw Object.assign(new Error('Send requestId and 1 to 100 different answers with id and version'), { status: 400 });
  return body;
}
export async function answerInboxGroup(entries: InboxAnswer[], read: (id: string) => Promise<any>, validate: (input: any, body: any) => void,
  write: (answers: { id: string; body: any }[]) => Promise<{ status: number }>): Promise<InboxOutcome[]> {
  const outcomes = new Map<string, InboxOutcome>(), ready: { id: string; body: any }[] = [];
  const failed = (id: string, error: any, input?: any) => {
    const status = error.status ?? 500;
    if (![400, 403, 404, 409].includes(status)) throw error;
    outcomes.set(id, { id, outcome: status === 403 ? 'forbidden' : status === 404 ? 'unknown' : status === 400 ? 'invalid' : 'conflict', status,
      ...(input ? { state: input.expiresAt <= Date.now() && input.state === 'pending' ? 'expired' : input.state, ...(input.answer ? { by: input.answer.by } : {}) } : {}), error: error.message });
  };
  for (const entry of entries) {
    const input = await read(entry.id);
    try {
      if (!input) throw Object.assign(new Error('Unknown input'), { status: 404 });
      let body: any = { ...entry };
      if (entry.accept === 'recommended') {
        const recommendation = input.detail?.recommendation;
        if (!recommendation) throw Object.assign(new Error('Input has no recommendation'), { status: 400 });
        body = { ...body, action: 'accept', content: recommendation.answer };
      }
      validate(input, body);
      if (entry.version !== (input.version ?? 1)) throw Object.assign(new Error('Input version moved'), { status: 409 });
      if (input.state !== 'pending' || input.expiresAt <= Date.now()) throw Object.assign(new Error('Input is already settled or expired'), { status: 409 });
      ready.push({ id: entry.id, body });
    } catch (error) { failed(entry.id, error, input); }
  }
  // A mixed batch is filtered before the write, so all fresh answers reach an agent together.
  // Only a concurrent settlement requires another pass; never turn a server failure into an item conflict.
  const commit = async (items: typeof ready): Promise<void> => {
    if (!items.length) return;
    try {
      const result = await write(items);
      for (const item of items) outcomes.set(item.id, { id: item.id, outcome: result.status === 200 ? 'same' : 'answered', status: result.status });
    } catch (error: any) {
      if (![400, 403, 404, 409].includes(error.status)) throw error;
      if (items.length === 1) failed(items[0].id, error, await read(items[0].id));
      else {
        const middle = Math.ceil(items.length / 2);
        await commit(items.slice(0, middle));
        await commit(items.slice(middle));
      }
    }
  };
  await commit(ready);
  return entries.map(entry => outcomes.get(entry.id)!);
}

type Sql = { query(text: string, values?: any[]): Promise<{ rows: any[] }> };
/** A durable receipt per tenant and request key. The caller owns this dedicated SQL connection. */
export async function inboxReceipt(sql: Sql, tenant: string, body: ReturnType<typeof inboxAnswers>, run: () => Promise<InboxOutcome[]>) {
  await sql.query('begin');
  await sql.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`inbox:${tenant}:${body.requestId}`]);
  try {
    const previous = (await sql.query('select result from inbox_answer_receipts where tenant=$1 and request_id=$2', [tenant, body.requestId])).rows[0];
    if (previous) { await sql.query('commit'); return previous.result; }
    const result = { outcomes: await run() };
    await sql.query('insert into inbox_answer_receipts (tenant,request_id,result) values ($1,$2,$3)', [tenant, body.requestId, JSON.stringify(result)]);
    await sql.query('commit');
    return result;
  } catch (error) { await sql.query('rollback'); throw error; }
}
