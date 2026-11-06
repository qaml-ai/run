import { AsyncLocalStorage } from "node:async_hooks";

export type DbPhase = "admission" | "hold" | "renew" | "settle" | "usage" | "webhooks" | "history" | "other" | "edge";
type Measures = { queries: number; queryMs: number; errors: number; connections: number; connectMs: number; transactions: number; transactionMs: number; transactionMaxMs: number; transactionSamplesMs: number[] };
export type DbProfileSnapshot = { phases: Partial<Record<DbPhase, Measures>>; operations: Partial<Record<DbPhase, number>> };
const context = new AsyncLocalStorage<{ profile: DbProfile; phase: DbPhase }>();
const fresh = (): Measures => ({ queries: 0, queryMs: 0, errors: 0, connections: 0, connectMs: 0, transactions: 0, transactionMs: 0, transactionMaxMs: 0, transactionSamplesMs: [] });

/** Pilot-only counters. Never retain SQL, parameters, account IDs or credentials. */
export class DbProfile {
  private value: DbProfileSnapshot = { phases: {}, operations: {} };
  readonly enabled: boolean;
  constructor(enabled: boolean) { this.enabled = enabled; }
  run<T>(phase: DbPhase, action: () => T): T {
    if (!this.enabled) return action();
    this.value.operations[phase] = (this.value.operations[phase] ?? 0) + 1;
    return context.run({ profile: this, phase }, action);
  }
  measure(phase: DbPhase) { return this.value.phases[phase] ??= fresh(); }
  snapshot(reset = false): DbProfileSnapshot {
    const value = structuredClone(this.value);
    if (reset) this.value = { phases: {}, operations: {} };
    return value;
  }
}

export function dbPhase<T>(phase: DbPhase, action: () => T): T {
  const active = context.getStore();
  return active ? active.profile.run(phase, action) : action();
}

export async function profileConnect<T>(action: () => Promise<T>): Promise<T> {
  const active = context.getStore();
  if (!active) return action();
  const started = performance.now();
  try { return await action(); }
  finally { const m = active.profile.measure(active.phase); m.connections++; m.connectMs += performance.now() - started; }
}

/** One invocation is one pg query round trip, including BEGIN/COMMIT/ROLLBACK.
 * Hold time is measured from BEGIN acknowledgement through COMMIT/ROLLBACK
 * acknowledgement; connect/pool wait is recorded separately. */
export function profileSql<T extends { query: (...args: any[]) => Promise<any> }>(client: T): T {
  let transaction: { profile: DbProfile; phase: DbPhase; started: number } | undefined;
  const query = client.query.bind(client);
  client.query = async (...args: any[]) => {
    const active = context.getStore();
    if (!active) return query(...args);
    const text = typeof args[0] === "string" ? args[0] : "";
    // Table classification partitions accounting's nested transaction SQL without
    // retaining the statement. Control statements remain in their parent phase.
    const phase: DbPhase = /\b(?:webhook_events|webhook_deliveries|webhooks)\b/i.test(text) ? "webhooks"
      : /\b(?:usage|usage_daily|usage_monthly|workspace_usage)\b/i.test(text) ? "usage" : active.phase;
    const started = performance.now(), m = active.profile.measure(phase);
    m.queries++;
    try {
      const result = await query(...args);
      if (/^\s*begin\b/i.test(text)) transaction = { ...active, started: performance.now() };
      return result;
    } catch (error) { m.errors++; throw error; }
    finally {
      m.queryMs += performance.now() - started;
      if (transaction && /^\s*(?:commit|rollback)\b/i.test(text)) {
        const held = performance.now() - transaction.started;
        const tx = transaction.profile.measure(transaction.phase);
        tx.transactions++; tx.transactionMs += held; tx.transactionMaxMs = Math.max(tx.transactionMaxMs, held);
        if (tx.transactionSamplesMs.length < 4096) tx.transactionSamplesMs.push(held);
        transaction = undefined;
      }
    }
  };
  return client;
}

export async function profileHttp(enabled: boolean, action: () => Promise<Response>): Promise<Response> {
  if (!enabled) return action();
  const profile = new DbProfile(true);
  const response = await profile.run("edge", action);
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("x-pilot-db-profile", JSON.stringify(profile.snapshot()));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
