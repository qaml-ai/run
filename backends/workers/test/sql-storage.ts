import { DatabaseSync } from 'node:sqlite';
import type { Placement } from '../../../shared/owner.ts';

/**
 * Give a test's fake Durable Object storage the SQLite API (`sql.exec`) the children table needs (children-table.ts),
 * on an in-memory database. Its `transaction`, if it has one, becomes a savepoint too: SQL writes made in a
 * transaction that throws are rolled back with its KV writes.
 */
export function withSql<S extends object>(storage: S): S & { sql: DurableObjectStorage['sql'] } {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings as never[]) as Record<string, unknown>[];
      return Object.assign(rows[Symbol.iterator](), { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('Expected exactly one row'); return rows[0]; } });
    },
  };
  const inner = (storage as { transaction?: (work: (tx: unknown) => unknown) => Promise<unknown> }).transaction;
  let savepoints = 0;
  if (inner) Object.assign(storage, {
    async transaction(work: (tx: unknown) => unknown) {
      const name = `tx${++savepoints}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = await inner.call(storage, work);
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      }
    },
  });
  return Object.assign(storage, { sql }) as S & { sql: DurableObjectStorage['sql'] };
}

/**
 * A fake host's `submitChild` that hands a child's start to its `fetch` as the POST /requests it was before the
 * binding took it, with the placement beside it (`delegation`), so a test's fetch double sees every start. The
 * host's `fetch` is read at each call, so a test may replace it.
 */
export function submitViaFetch(host: { fetch(id: string, request: Request): Promise<Response> }) {
  return async (id: string, request: { id: string; method: 'prompt'; params: Record<string, unknown> }, placement: Placement) => {
    const response = await host.fetch(id, new Request('https://agent/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, delegation: placement }) }));
    if (response.ok) return { ok: true as const };
    const detail = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    return { ok: false as const, status: response.status, error: typeof detail?.error === 'string' ? detail.error : '' };
  };
}

/**
 * The children's outboxes, simulated for a fake host: every few milliseconds each running child run the owner
 * accepted is read (its host's `fetch` GET /requests/:id, so a test's double decides how and when it ends), and an
 * ended one's ending is delivered to the owner's `receiveEnding`, as the child's alarm would. The owner itself never
 * reads its children. Returns the stop.
 */
export function childAlarms(host: { fetch(id: string, request: Request): Promise<Response> }, owner: { rows: { running(): Promise<{ id: string; requestId: string; accepted?: boolean }[]> }; receiveEnding(ending: { agentId: string; requestId: string; record: any }): Promise<unknown> }, everyMs = 5) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      await new Promise(resolve => setTimeout(resolve, everyMs));
      for (const child of await owner.rows.running().catch(() => [])) {
        if (stopped || !child.id || !child.accepted) continue;
        const response = await host.fetch(child.id, new Request(`https://agent/requests/${child.requestId}`)).catch(() => undefined);
        if (!response) continue;
        const record = response.ok ? await response.json().catch(() => undefined) as { state?: string } | undefined
          : response.status === 404 ? { state: 'completed', status: 'failed', error: 'The sub-agent was deleted before it answered' } : undefined;
        if (record?.state === 'completed') await owner.receiveEnding({ agentId: child.id, requestId: child.requestId, record }).catch(() => {});
      }
    }
  })();
  return async () => { stopped = true; await loop; };
}
