import type { DelegatedChild } from './delegation.ts';
import { ownerOf } from '../../../shared/owner.ts';

/**
 * The owner's children: one row per child run its delegate, spawn_agent and send_message calls started, in the owner's
 * own SQLite, indexed by status, by call and by the child's run, so a start, a progress report or a listing reads the
 * rows it needs instead of every child (the `delegation:*` KV rows were listed whole on each of them).
 *
 * Expand step (docs/design/swarm-workflows.md, PR 1): every write still writes the `delegation:<key>` KV row too, so
 * a version of the object deployed before this one (a rollback) still finds its children. Rows that version wrote
 * (or that predate the table) are imported once per instance: a KV row whose value differs from its SQL row's was
 * written by older code, since this code writes both the same. The contract deploy drops the KV writes and the import.
 */
export const CHILDREN_KV_PREFIX = 'delegation:';

type Row = { state: string };
type Sql = DurableObjectStorage['sql'];
type Kv = Pick<DurableObjectStorage, 'put'>;

export class ChildRows {
  private ready?: Promise<void>;
  private readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) { this.storage = storage; }

  private get sql(): Sql { return this.storage.sql; }

  /** Create the table and import the KV rows it lacks, once per instance. */
  load(): Promise<void> {
    this.ready ??= this.importRows().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }

  private async importRows() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS children (
      key TEXT PRIMARY KEY,
      owner_kind TEXT NOT NULL DEFAULT 'agent',
      owner_id TEXT NOT NULL DEFAULT '',
      call_id TEXT NOT NULL DEFAULT '',
      child_id TEXT NOT NULL DEFAULT '',
      request_id TEXT NOT NULL,
      parent_request_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      background INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL DEFAULT '',
      root_owner TEXT,
      chain TEXT,
      depth INTEGER,
      max_depth INTEGER,
      started INTEGER NOT NULL,
      ended INTEGER,
      cost REAL,
      state TEXT NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS children_status ON children(status, started)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS children_call ON children(call_id)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS children_run ON children(child_id, request_id)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS children_owner_run ON children(parent_request_id, status)');
    const kv = await this.storage.list<DelegatedChild>({ prefix: CHILDREN_KV_PREFIX, noCache: true });
    if (!kv.size) return;
    const stored = new Map<string, string>();
    for (const row of this.sql.exec<{ key: string; state: string }>('SELECT key, state FROM children')) stored.set(row.key, row.state);
    for (const [name, value] of kv) {
      if (!value || typeof value !== 'object' || typeof value.key !== 'string' || name !== CHILDREN_KV_PREFIX + value.key) continue;
      if (stored.get(value.key) !== JSON.stringify(value)) this.write(value);
    }
  }

  private write(child: DelegatedChild) {
    const owner = ownerOf(child.owner);
    this.sql.exec(`INSERT INTO children (key, owner_kind, owner_id, call_id, child_id, request_id, parent_request_id, status, background, name,
        root_owner, chain, depth, max_depth, started, ended, cost, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET owner_kind=excluded.owner_kind, owner_id=excluded.owner_id, call_id=excluded.call_id,
        child_id=excluded.child_id, request_id=excluded.request_id, parent_request_id=excluded.parent_request_id,
        status=excluded.status, background=excluded.background, name=excluded.name, root_owner=excluded.root_owner,
        chain=excluded.chain, depth=excluded.depth, max_depth=excluded.max_depth, started=excluded.started,
        ended=excluded.ended, cost=excluded.cost, state=excluded.state`,
      child.key, owner?.kind ?? 'agent', owner?.id ?? '', child.callId ?? child.toolCallId ?? '', child.id ?? '', child.requestId ?? '',
      child.parentRequestId ?? '', child.status, child.background ? 1 : 0, child.name ?? '',
      child.rootOwner ? JSON.stringify(child.rootOwner) : child.root ? JSON.stringify({ kind: 'agent', id: child.root }) : null,
      child.chain ? JSON.stringify(child.chain) : null, child.depth ?? null, child.maxDepth ?? null,
      child.createdAt ?? 0, child.endedAt ?? null, child.spent ?? child.held ?? null, JSON.stringify(child));
  }

  /** Write a child's state (no payload): its row, and its KV row for older code. `kv` is the transaction it joins. */
  async put(child: DelegatedChild, kv: Kv = this.storage) {
    await this.load();
    this.write(child);
    await kv.put(CHILDREN_KV_PREFIX + child.key, child);
  }

  private rows(query: string, ...bindings: unknown[]): DelegatedChild[] {
    return this.sql.exec<Row>(query, ...bindings).toArray().map(row => JSON.parse(row.state) as DelegatedChild);
  }

  async get(key: string): Promise<DelegatedChild | undefined> {
    await this.load();
    return this.rows('SELECT state FROM children WHERE key = ?', key)[0];
  }

  /** Every child, oldest first. Only listings use it; the hot paths below read by index. */
  async all(): Promise<DelegatedChild[]> {
    await this.load();
    return this.rows('SELECT state FROM children ORDER BY started, key');
  }

  async running(): Promise<DelegatedChild[]> {
    await this.load();
    return this.rows("SELECT state FROM children WHERE status = 'running' ORDER BY started, key");
  }

  /** The children one run of the owner started. */
  async ofRun(requestId: string): Promise<DelegatedChild[]> {
    await this.load();
    return this.rows('SELECT state FROM children WHERE parent_request_id = ? ORDER BY started, key', requestId);
  }

  /** The row of one child run. */
  async byRun(childId: string, requestId: string): Promise<DelegatedChild | undefined> {
    await this.load();
    return this.rows('SELECT state FROM children WHERE child_id = ? AND request_id = ? ORDER BY started DESC LIMIT 1', childId, requestId)[0];
  }

  /** The latest row of a child, by its agent id. */
  async byChild(childId: string): Promise<DelegatedChild | undefined> {
    await this.load();
    return this.rows('SELECT state FROM children WHERE child_id = ? ORDER BY started DESC LIMIT 1', childId)[0];
  }

  /** Every row of one child (its spawn, its messages' and resumes' runs), oldest first. */
  async ofChild(childId: string): Promise<DelegatedChild[]> {
    await this.load();
    return this.rows('SELECT state FROM children WHERE child_id = ? ORDER BY started, key', childId);
  }

  /** Rows a notification request (`child_<request>`) names. */
  async byRequest(requestId: string): Promise<DelegatedChild[]> {
    await this.load();
    return this.rows('SELECT state FROM children WHERE request_id = ? ORDER BY started, key', requestId);
  }

  /** Background children that ended and whose ending has not landed: what a notice's batch may carry. */
  async ended(): Promise<DelegatedChild[]> {
    await this.load();
    return this.rows("SELECT state FROM children WHERE background = 1 AND status <> 'running' AND json_extract(state, '$.landedBy') IS NULL ORDER BY started, key");
  }

  /** Background rows not yet charged: what a background start holds against the agent's budget. */
  async unsettled(): Promise<DelegatedChild[]> {
    await this.load();
    return this.rows("SELECT state FROM children WHERE status = 'running' OR json_extract(state, '$.charged') IS NOT 1 ORDER BY started, key");
  }
}
