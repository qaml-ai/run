import type { Owner } from '../../../shared/owner.ts';
import type { ChildRun } from './delegation.ts';

/**
 * A child's outbox (docs/design/swarm-workflows.md, "Endings are durable, for every owner"). A run its owner started
 * writes its ending to its own storage in the transaction that records the run's outcome, and each progress report
 * as it is made; the child's alarm delivers them to the owner's `receiveEnding`/`receiveProgress` with backoff until
 * the owner answers. The owner's receive is idempotent on the child's run (`agentId`, `requestId`), so a delivery made
 * again (the child evicted before it removed the row) changes nothing. Nothing on the owner's side polls: a
 * hibernating owner hears every ending when the child's alarm reaches it.
 */
export type ChildEnding = { agentId: string; requestId: string; record: ChildRun };
export type ChildProgress = { agentId: string; requestId: string; text: string; callId: string };
/** What an owner answers: `accepted` false when it has no such child run (then there is nothing to deliver). */
export type Receipt = { accepted: boolean; error?: string };

type Row =
  | { kind: 'ending'; owner: Owner; ending: ChildEnding; attempts: number; nextAt: number; createdAt: number }
  | { kind: 'progress'; owner: Owner; progress: ChildProgress; attempts: number; nextAt: number; createdAt: number };

export const OUTBOX_PREFIX = 'child-outbox:';
/** First retry after 1 s, doubling to at most 5 minutes. */
export const OUTBOX_RETRY = { firstMs: 1_000, maxMs: 5 * 60_000 } as const;
/** An undeliverable row (its owner keeps failing) is dropped after this long, as a made child itself is. */
export const OUTBOX_GIVE_UP_MS = 7 * 86_400_000;

export interface OutboxHost {
  storage: DurableObjectStorage;
  /** The owner's receive, through its binding. A throw is a failed delivery, retried; any answer is an acknowledgement. */
  receiveEnding(owner: Owner, ending: ChildEnding): Promise<Receipt>;
  receiveProgress(owner: Owner, progress: ChildProgress): Promise<Receipt>;
  /** The child's alarm at `at`, keeping any earlier work. */
  arm(at: number): Promise<void>;
  now?(): number;
}

// Progress sorts before the ending of the same run (`p` < `z`): a report made before the run ended reaches the owner first.
const endingKey = (requestId: string) => `${OUTBOX_PREFIX}${requestId}:z`;
const progressKey = (requestId: string, callId: string) => `${OUTBOX_PREFIX}${requestId}:p:${callId}`;

export class ChildOutbox {
  private readonly host: OutboxHost;
  private flushing?: Promise<number | undefined>;
  constructor(host: OutboxHost) { this.host = host; }
  private now() { return this.host.now?.() ?? Date.now(); }

  /** Stage a run's ending in `tx`, the transaction recording its outcome. Staged again (a repeated emit), it is the same row. */
  async stageEnding(tx: Pick<DurableObjectTransaction, 'get' | 'put'>, owner: Owner, ending: ChildEnding) {
    const key = endingKey(ending.requestId);
    if (await tx.get(key)) return;
    const now = this.now();
    await tx.put(key, { kind: 'ending', owner, ending, attempts: 0, nextAt: now, createdAt: now } satisfies Row);
  }

  /**
   * Record a progress report and try it at once: the owner's refusal (an unknown run, its limit) is returned and the row
   * dropped; a failed delivery leaves the row for the alarm, and the report counts as made.
   */
  async report(owner: Owner, progress: ChildProgress): Promise<Receipt> {
    const key = progressKey(progress.requestId, progress.callId), now = this.now();
    if (!await this.host.storage.get(key)) await this.host.storage.put(key, { kind: 'progress', owner, progress, attempts: 0, nextAt: now, createdAt: now } satisfies Row);
    const row = await this.host.storage.get<Row>(key);
    if (!row) return { accepted: true };
    try {
      const receipt = await this.host.receiveProgress(owner, progress);
      await this.host.storage.delete(key);
      return receipt;
    } catch {
      await this.retryLater(key, row);
      return { accepted: true };
    }
  }

  /** Deliver every row that is due; returns when the next one is (undefined: none left). One flush at a time. */
  flush(): Promise<number | undefined> {
    this.flushing ??= this.flushOnce().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushOnce(): Promise<number | undefined> {
    const rows = await this.host.storage.list<Row>({ prefix: OUTBOX_PREFIX, limit: 128 });
    let next: number | undefined;
    for (const [key, row] of rows) {
      const now = this.now();
      if (row.nextAt > now) { next = Math.min(next ?? Infinity, row.nextAt); continue; }
      if (now - row.createdAt > OUTBOX_GIVE_UP_MS) {
        console.error(JSON.stringify({ type: 'child_outbox_dropped', kind: row.kind, owner: row.owner, requestId: row.kind === 'ending' ? row.ending.requestId : row.progress.requestId, attempts: row.attempts }));
        await this.host.storage.delete(key);
        continue;
      }
      try {
        if (row.kind === 'ending') await this.host.receiveEnding(row.owner, row.ending);
        else await this.host.receiveProgress(row.owner, row.progress);
        await this.host.storage.delete(key);
      } catch {
        next = Math.min(next ?? Infinity, await this.retryLater(key, row));
      }
    }
    // More than a page: the rest go at once.
    if (rows.size === 128) next = Math.min(next ?? Infinity, this.now());
    if (next !== undefined) await this.host.arm(next);
    return next;
  }

  private async retryLater(key: string, row: Row) {
    const attempts = row.attempts + 1;
    const nextAt = this.now() + Math.min(OUTBOX_RETRY.maxMs, OUTBOX_RETRY.firstMs * 2 ** Math.min(20, attempts - 1));
    // Only if the row is still there: a delivery that raced this one may have removed it.
    if (await this.host.storage.get(key)) await this.host.storage.put(key, { ...row, attempts, nextAt });
    await this.host.arm(nextAt);
    return nextAt;
  }

  /** When the next row is due (the alarm's deadline), undefined when the outbox is empty. */
  async deadline(): Promise<number | undefined> {
    let next: number | undefined;
    for (const row of (await this.host.storage.list<Row>({ prefix: OUTBOX_PREFIX, limit: 128 })).values()) next = Math.min(next ?? Infinity, row.nextAt);
    return next;
  }
}
