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

/** First retry after 1 s, doubling to at most 5 minutes, each with up to a fifth more at random (deliveries to one
 * owner that failed together do not all come back at once). */
export const OUTBOX_RETRY = { firstMs: 1_000, maxMs: 5 * 60_000, jitter: 0.2 } as const;
/** An undeliverable row (its owner keeps failing) is dropped after this long, as a made child itself is. */
export const OUTBOX_GIVE_UP_MS = 7 * 86_400_000;
const LEGACY_KV_PREFIX = 'child-outbox:';

/**
 * When a deleted (or expired) agent wakes next: only to finish what it owes (billing, terminal events, its outbox's next
 * delivery), never for its watchdog. A deleted agent runs nothing, so nothing it would recover from can need it.
 */
export function deletedDeadline(owed: { billing: boolean; events: boolean; outbox: number | undefined }, now = Date.now()) {
  return Math.min(owed.billing ? now + 5000 : Infinity, owed.events ? now + 1000 : Infinity, owed.outbox ?? Infinity);
}

/**
 * Plan a deleted agent's next wake, or let it go quiet. Only a confirmed tombstone counts (`deleted` read back true from
 * its own storage): a read that fails throws, and an agent whose flag is not set is live ("live", nothing touched), so a
 * transient failure never silences a live agent's schedules. A tombstoned agent that still owes something (`at`) wakes
 * for it; one that owes nothing has its jobs (every capability's: nothing it would run can matter now) and its alarm
 * removed, so nothing re-arms it.
 */
export async function settleDeleted(storage: DurableObjectStorage, at: number, push: (at: number) => Promise<unknown>): Promise<"live" | "armed" | "quiet"> {
  if (await storage.get("deleted") !== true) return "live";
  if (Number.isFinite(at)) { await push(at); return "armed"; }
  // Pi's own wake job goes too: a turn still settling after a restart is fine, since the harness pushes its wake again
  // on start, and its settle writes a receipt and calls arm(), which plans this agent for it.
  if (storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_jobs'").one().n)
    storage.sql.exec("DELETE FROM cf_agents_jobs");
  await storage.deleteAlarm();
  return "quiet";
}

/** Rows one flush delivers; the rest go in the next, at once if they are due. */
export const OUTBOX_PAGE = 128;

export interface OutboxHost {
  storage: DurableObjectStorage;
  /** The owner's receive, through its binding. A throw is a failed delivery, retried; any answer is an acknowledgement. */
  receiveEnding(owner: Owner, ending: ChildEnding): Promise<Receipt>;
  receiveProgress(owner: Owner, progress: ChildProgress): Promise<Receipt>;
  /** The child's alarm at `at`, keeping any earlier work. */
  arm(at: number): Promise<void>;
  now?(): number;
  random?(): number;
}

// Progress sorts before the ending of the same run (`p` < `z`): a report made before the run ended reaches the owner first.
const endingKey = (requestId: string) => `${requestId}:z`;
const progressKey = (requestId: string, callId: string) => `${requestId}:p:${callId}`;

type Stored = { key: string; body: string; attempts: number; next_at: number; created_at: number };

/**
 * The outbox is a table in the child's own SQLite, indexed by when each row is next due, so a flush reads only due rows
 * and the next deadline is one query whatever the outbox holds.
 */
export class ChildOutbox {
  private readonly host: OutboxHost;
  private flushing?: Promise<number | undefined>;
  private created = false;
  private kvImported = false;
  constructor(host: OutboxHost) {
    this.host = host;
    // Made here, outside any transaction: made first inside one that then rolled back, the table would be gone while
    // `created` said it was there.
    void this.sql;
  }
  private now() { return this.host.now?.() ?? Date.now(); }
  private get sql() {
    const sql = this.host.storage.sql;
    if (!this.created) {
      sql.exec("CREATE TABLE IF NOT EXISTS child_outbox (key TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, created_at INTEGER NOT NULL)");
      sql.exec("CREATE INDEX IF NOT EXISTS child_outbox_due ON child_outbox (next_at, key)");
      this.created = true;
    }
    return sql;
  }
  private insert(key: string, row: Row) {
    // INSERT OR IGNORE: staged again (a repeated emit, a report made again), it is the same row.
    this.sql.exec("INSERT OR IGNORE INTO child_outbox (key, body, attempts, next_at, created_at) VALUES (?, ?, 0, ?, ?)", key, JSON.stringify(row), row.nextAt, row.createdAt);
  }
  private remove(key: string) { this.sql.exec("DELETE FROM child_outbox WHERE key = ?", key); }
  private read(stored: Stored): Row { return { ...JSON.parse(stored.body) as Row, attempts: stored.attempts, nextAt: stored.next_at, createdAt: stored.created_at }; }

  /**
   * Stage a run's ending in the transaction recording its outcome (the SQL write joins whatever transaction is open:
   * `tx` names it for the caller). Staged again, it is the same row.
   */
  async stageEnding(_tx: unknown, owner: Owner, ending: ChildEnding) {
    const now = this.now();
    this.insert(endingKey(ending.requestId), { kind: 'ending', owner, ending, attempts: 0, nextAt: now, createdAt: now });
  }

  /**
   * Record a progress report and try it at once: the owner's refusal (an unknown run, its limit) is returned and the row
   * dropped; a failed delivery leaves the row for the alarm, and the report counts as made.
   */
  async report(owner: Owner, progress: ChildProgress): Promise<Receipt> {
    const key = progressKey(progress.requestId, progress.callId), now = this.now();
    this.insert(key, { kind: 'progress', owner, progress, attempts: 0, nextAt: now, createdAt: now });
    const stored = this.sql.exec<Stored>("SELECT * FROM child_outbox WHERE key = ?", key).toArray()[0];
    if (!stored) return { accepted: true };
    try {
      const receipt = await this.host.receiveProgress(owner, progress);
      this.remove(key);
      return receipt;
    } catch {
      await this.retryLater(key, this.read(stored));
      return { accepted: true };
    }
  }

  /** Deliver every row that is due; returns when the next one is (undefined: none left). One flush at a time. */
  flush(): Promise<number | undefined> {
    this.flushing ??= this.flushOnce().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  /**
   * Rows an earlier build of this branch kept in KV (`child-outbox:<request>:…`) move into the table, once per instance.
   * That build never reached main; this only makes sure an object a test deploy ran on loses nothing.
   */
  private async importKv() {
    if (this.kvImported) return;
    const old = await this.host.storage.list<Row>({ prefix: LEGACY_KV_PREFIX });
    for (const [name, row] of old) {
      this.sql.exec("INSERT OR IGNORE INTO child_outbox (key, body, attempts, next_at, created_at) VALUES (?, ?, ?, ?, ?)", name.slice(LEGACY_KV_PREFIX.length), JSON.stringify(row), row.attempts ?? 0, row.nextAt ?? this.now(), row.createdAt ?? this.now());
      await this.host.storage.delete(name);
    }
    this.kvImported = true;
  }

  private async flushOnce(): Promise<number | undefined> {
    await this.importKv();
    const due = this.sql.exec<Stored>("SELECT * FROM child_outbox WHERE next_at <= ? ORDER BY key LIMIT ?", this.now(), OUTBOX_PAGE).toArray();
    for (const stored of due) {
      const row = this.read(stored), now = this.now();
      if (now - row.createdAt > OUTBOX_GIVE_UP_MS) {
        console.error(JSON.stringify({ type: 'child_outbox_dropped', kind: row.kind, owner: row.owner, requestId: row.kind === 'ending' ? row.ending.requestId : row.progress.requestId, attempts: row.attempts }));
        this.remove(stored.key);
        continue;
      }
      try {
        if (row.kind === 'ending') await this.host.receiveEnding(row.owner, row.ending);
        else await this.host.receiveProgress(row.owner, row.progress);
        this.remove(stored.key);
      } catch {
        // Armed once below, for the whole outbox, not once per failing row.
        await this.retryLater(stored.key, row, false);
      }
    }
    // The next deadline over the whole outbox, not this page: due rows past the page make it now, and undue ones
    // their own time, never a loop of alarms that find nothing due.
    const next = await this.deadline();
    if (next !== undefined) await this.host.arm(next);
    return next;
  }

  private async retryLater(key: string, row: Row, arm = true) {
    const attempts = row.attempts + 1;
    const delay = Math.min(OUTBOX_RETRY.maxMs, OUTBOX_RETRY.firstMs * 2 ** Math.min(20, attempts - 1));
    const nextAt = this.now() + Math.round(delay * (1 + OUTBOX_RETRY.jitter * (this.host.random?.() ?? Math.random())));
    // Only if the row is still there: a delivery that raced this one may have removed it.
    this.sql.exec("UPDATE child_outbox SET attempts = ?, next_at = ? WHERE key = ?", attempts, nextAt, key);
    if (arm) await this.host.arm(nextAt);
    return nextAt;
  }

  /**
   * When the alarm must come back for the outbox: its next row's time, but never sooner than a second from now. A row
   * just staged or reported (due now) is being delivered by whoever wrote it (a progress report at once, an ending by
   * its stager's flush); the alarm is only the backstop for a delivery that fails, whose retry is a second or more away
   * anyway. Without the floor, an alarm planned while that delivery was in flight was set for now, and fired again at
   * once with nothing left to do (alarm_rearm_due, on agents and workflow objects alike).
   */
  async wakeAt(now = this.now()): Promise<number | undefined> {
    const next = await this.deadline();
    return next === undefined ? undefined : Math.max(next, now + OUTBOX_RETRY.firstMs);
  }
  /** When the next row is due (the alarm's deadline), undefined when the outbox is empty. */
  async deadline(): Promise<number | undefined> {
    const next = this.sql.exec<{ next: number | null }>("SELECT MIN(next_at) AS next FROM child_outbox").one().next;
    return next === null ? undefined : Number(next);
  }

  /**
   * A deleted (or expired) agent's wake: it runs nothing more, but a run it ended as it went (a failed ending for its
   * owner) must still be delivered, so its outbox is flushed and its alarm re-armed for the next retry.
   */
  static async deletedWake(runtime: { outbox: ChildOutbox; arm(): Promise<void> }) {
    await runtime.outbox.flush().catch(() => {});
    await runtime.arm();
  }

  /** Rows waiting (tests, telemetry). */
  size(): number { return Number(this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM child_outbox").one().n); }
}
