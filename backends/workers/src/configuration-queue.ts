import { BadRequest } from './validation.ts';
import { MAX_OPEN_REQUESTS } from './access-policy.ts';
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

type Record = { id: string; method: string; params?: { [key: string]: unknown }; fingerprint: string; state: 'queued' | 'running' | 'completed'; startedAt: number; configurationOrder?: number; replaceConfiguration?: boolean };

/** Configuration shares the agent's durable queue and is applied between turns. */
export class ConfigurationQueue<T extends Record> {
  private working?: Promise<void>;
  constructor(private readonly storage: DurableObjectStorage, private readonly host: {
    busy(order: number): Promise<boolean>;
    released(order: number): Promise<void>;
    apply(record: T): Promise<unknown>;
    failed(record: T, error: unknown): Promise<void>;
    background(work: Promise<void>): void;
    wake(): Promise<void>;
  }) {}
  async enqueue(input: { id: string; method: string; params: { [key: string]: unknown } }, replaceConfiguration = false, configurationOrigin?: string) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.id)) throw new BadRequest('Invalid request id');
    const fingerprint = canonical(input);
    const record = await this.storage.transaction(async tx => {
      const key = `request:${input.id}`;
      const old = await tx.get<T>(key);
      if (old) {
        if (old.fingerprint !== fingerprint) throw Object.assign(new Error('Request id reused with different input'), { status: 409, code: 'IDEMPOTENCY_CONFLICT' });
        return old;
      }
      const requests = await tx.list<T>({ prefix: 'request:' });
      if ([...requests.values()].filter(record => record.state !== 'completed').length >= MAX_OPEN_REQUESTS)
        throw Object.assign(new Error('Too many requests queued for this agent'), { status: 429 });
      const sequence = (await tx.get<number>('configuration-order') ?? 0) + 1;
      await tx.put('configuration-order', sequence);
      const record = { ...input, fingerprint, state: 'queued', startedAt: Date.now(), configurationOrder: sequence, replaceConfiguration, ...(configurationOrigin !== undefined ? { configurationOrigin } : {}) } as T;
      await tx.put(key, record);
      return record;
    });
    this.kick();
    await this.host.wake();
    return record;
  }
  async pendingOrder() {
    return Math.max(0, ...[...(await this.storage.list<T>({ prefix: 'request:' })).values()]
      .filter(record => record.method === 'configure' && record.state !== 'completed').map(record => record.configurationOrder ?? 0));
  }
  async completedOrder() { return await this.storage.get<number>('configuration-completed') ?? 0; }
  kick() {
    if (this.working) return;
    const work = this.drain().finally(() => { this.working = undefined; });
    this.working = work;
    this.host.background(work);
  }
  /** Wait only for a write already under way, not for a future turn boundary. */
  async settled() { await this.working; }
  private async drain() {
    for (;;) {
      const records = [...(await this.storage.list<T>({ prefix: 'request:' })).values()];
      const completed = Math.max(await this.completedOrder(), ...records.filter(record => record.method === 'configure' && record.state === 'completed').map(record => record.configurationOrder ?? 0));
      await this.storage.put('configuration-completed', completed);
      await this.host.released(completed);
      const pending = records
        .filter(record => record.method === 'configure' && record.state !== 'completed')
        .sort((a, b) => (a.configurationOrder ?? 0) - (b.configurationOrder ?? 0));
      if (!pending.length) return;
      if (await this.host.busy(pending[0].configurationOrder ?? 0)) { await this.host.wake(); return; }
      const record = pending[0];
      try { await this.host.apply(record); }
      catch (error) { await this.host.failed(record, error); }
    }
  }
}
