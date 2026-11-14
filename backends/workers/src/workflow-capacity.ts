/**
 * Workflow capacity: how many children a workflow may run at once, and a tenant across all its workflows, so
 * one workflow cannot take a tenant's (or the platform's) capacity. The ledger here is the policy over SQLite; the
 * `WorkflowCapacity` object (workflow-capacity-object.ts), one per tenant, holds it. A workflow opens itself, asks for a
 * slot before it starts each child (`acquire`), renews its slots from its own alarm, releases each when the child
 * ends, and closes when it ends. A slot is a lease: a workflow that dies loses its slots when they expire.
 *
 * Caps:
 * - per workflow: `concurrency` children (default 16, at most 64);
 * - per tenant: children across its workflows (operator default 256, never more than 90% of its busy-agent limit),
 *   and running workflows (default 20).
 *
 * Fair share, within a tenant: a request that cannot be granted waits, in order. When a slot frees, it goes first to a
 * waiting workflow holding fewer than its fair share (the tenant cap over the workflows holding or waiting,
 * at least 1), then to any waiting workflow; within each group, to the workflow granted longest ago (round robin), and
 * within a workflow to its oldest request. So every competing workflow is guaranteed its share as slots free, and
 * capacity no one else wants is never left idle. Nothing is taken back from a workflow above its share: children end
 * on their own, and their slots go to those below it. A new request queues behind the waiters, never past them.
 *
 * The contract for a workflow: from `open` to `close` it calls `renew` on a timer shorter than its lease (10 minutes by
 * default), whether or not it holds slots or waits for any. A workflow that stops renewing is taken for dead when its
 * lease runs out: its slots go to waiters, its waiting requests lose their place in line, and its seat among the
 * tenant's running workflows is freed; it must `open` again, and ask again, at the back of the line.
 */
import { randomUUID } from "node:crypto";

export type SlotKind = "child";

export const WORKFLOW_CAPACITY = {
  concurrency: { default: 16, max: 64 },
  /** Operator defaults for a tenant, across its workflows. */
  tenant: { children: 256, workflows: 20 },
  /** Of the tenant's busy-agent limit, what its workflows' children may use: the rest stays for its other agents. */
  busyShare: 0.9,
  /** How long a slot or a waiting request lives without a renewal. */
  leaseMs: 10 * 60_000,
  minLeaseMs: 30_000,
  maxLeaseMs: 60 * 60_000,
};

/** A tenant's caps across its workflows. */
export type TenantCaps = { children: number; workflows: number };
/** What the host knows of a tenant when a workflow opens: its busy-agent limit (null: none). */
export type TenantLimits = { busyAgents: number | null };
type CapsOverride = Partial<TenantCaps>;
export type CapacityEnv = { AGENT_WORKFLOW_LIMITS?: string; AGENT_WORKFLOW_TENANT_LIMITS?: string };

export class CapacityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "CapacityError"; this.code = code; }
}

const positiveInt = (value: unknown, label: string) => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive whole number`);
  return value as number;
};
function overrideOf(value: unknown, label: string): CapsOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object of children and workflows`);
  const out: CapsOverride = {};
  for (const [key, given] of Object.entries(value)) {
    if (key !== "children" && key !== "workflows") throw new Error(`${label} has an unknown field ${key}`);
    out[key] = positiveInt(given, `${label}.${key}`);
  }
  return out;
}

/**
 * A tenant's caps: the operator's defaults (`AGENT_WORKFLOW_LIMITS`), the tenant's own (`AGENT_WORKFLOW_TENANT_LIMITS`,
 * by tenant id), with children bounded by 90% of its busy-agent limit. An invalid setting refuses the call.
 */
export function tenantCaps(env: CapacityEnv, tenant: string, limits: TenantLimits): TenantCaps {
  const operator = env.AGENT_WORKFLOW_LIMITS ? overrideOf(JSON.parse(env.AGENT_WORKFLOW_LIMITS), "AGENT_WORKFLOW_LIMITS") : {};
  const tenants = env.AGENT_WORKFLOW_TENANT_LIMITS ? JSON.parse(env.AGENT_WORKFLOW_TENANT_LIMITS) as Record<string, unknown> : {};
  const own = Object.hasOwn(tenants, tenant) ? overrideOf(tenants[tenant], `AGENT_WORKFLOW_TENANT_LIMITS.${tenant}`) : {};
  const caps = { ...WORKFLOW_CAPACITY.tenant, ...operator, ...own };
  const busy = limits.busyAgents === null || limits.busyAgents === undefined ? Infinity : Math.max(1, Math.floor(limits.busyAgents * WORKFLOW_CAPACITY.busyShare));
  return { children: Math.min(caps.children, busy), workflows: caps.workflows };
}

/** A workflow's own caps: what it asked for (defaults otherwise), at most the maximum and the tenant's cap. */
export function workflowCaps(asked: { concurrency?: number }, caps: TenantCaps) {
  const { default: fallback, max } = WORKFLOW_CAPACITY.concurrency;
  const concurrency = asked.concurrency === undefined ? fallback : asked.concurrency;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > max)
    throw new CapacityError("invalid", `concurrency must be a whole number from 1 to ${max}`);
  return { concurrency: Math.min(concurrency, caps.children) };
}

export type Lease = { id: string; kind: SlotKind; key: string; expiresAt: number };
/** A slot granted to a waiting request, which its workflow is told of (WorkflowObject.capacityGranted). */
export type Grant = Lease & { workflow: string };
export type Acquired =
  | { granted: true; lease: Lease }
  | { granted: false; id: string; position: number; reason: "workflow_cap" | "tenant_cap" | "fair_share" };
export type KindUsage = { held: number; waiting: number; cap: number };
export type WorkflowUsage = { workflow: string; children: KindUsage; openedAt: number; expiresAt: number };
export type CapacityUsage = { tenant: { caps: TenantCaps; workflows: number; children: { held: number; waiting: number } }; workflows: WorkflowUsage[] };

type Row = { id: string; workflow: string; kind: SlotKind; key: string; state: "held" | "waiting"; seq: number; expires_at: number };
type WorkflowRow = { workflow: string; concurrency: number; opened_at: number; expires_at: number; child_grant: number };

/** The ledger: every call is one transaction, and returns the grants it made to other workflows' waiting requests. */
export class CapacityLedger {
  private readonly sql: SqlStorage;
  private readonly atomic: <T>(write: () => T) => T;
  private readonly now: () => number;
  constructor(sql: SqlStorage, atomic: <T>(write: () => T) => T, now: () => number = Date.now) {
    this.sql = sql; this.atomic = atomic; this.now = now;
    this.initialize();
  }

  initialize() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS capacity_workflows (workflow TEXT PRIMARY KEY, concurrency INTEGER NOT NULL, opened_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, child_grant INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS capacity_slots (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL, seq INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE (workflow, kind, key))");
    this.sql.exec("CREATE INDEX IF NOT EXISTS capacity_slots_waiting ON capacity_slots (kind, state, seq)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS capacity_slots_expiry ON capacity_slots (expires_at)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS capacity_meta (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, children INTEGER NOT NULL, workflows INTEGER NOT NULL)");
    this.sql.exec("INSERT OR IGNORE INTO capacity_meta VALUES (1, 0, ?, ?)", WORKFLOW_CAPACITY.tenant.children, WORKFLOW_CAPACITY.tenant.workflows);
  }

  private meta() { return this.sql.exec<{ seq: number; children: number; workflows: number }>("SELECT seq, children, workflows FROM capacity_meta WHERE id=1").one(); }
  private next() { this.sql.exec("UPDATE capacity_meta SET seq=seq+1 WHERE id=1"); return this.meta().seq; }
  private caps(): TenantCaps { const { children, workflows } = this.meta(); return { children, workflows }; }
  private tenantCap() { return this.caps().children; }
  private workflow(workflow: string) { return this.sql.exec<WorkflowRow>("SELECT * FROM capacity_workflows WHERE workflow=?", workflow).toArray()[0]; }
  private count(where: string, ...args: unknown[]) { return Number(this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM capacity_slots WHERE ${where}`, ...args).one().n); }
  private lease(row: Pick<Row, "id" | "kind" | "key" | "expires_at">): Lease { return { id: row.id, kind: row.kind, key: row.key, expiresAt: row.expires_at }; }
  private leaseMs(given?: number) {
    if (given === undefined) return WORKFLOW_CAPACITY.leaseMs;
    if (!Number.isSafeInteger(given) || given < WORKFLOW_CAPACITY.minLeaseMs || given > WORKFLOW_CAPACITY.maxLeaseMs) throw new CapacityError("invalid", `leaseMs must be from ${WORKFLOW_CAPACITY.minLeaseMs} to ${WORKFLOW_CAPACITY.maxLeaseMs}`);
    return given;
  }

  /**
   * A workflow starts: with its tenant's caps as they are now (the host resolves them: `tenantCaps`), refused with
   * `workflow_limit` when the tenant already runs as many workflows as it may. Opening again (a restarted workflow)
   * updates its caps and keeps its slots.
   */
  open(workflow: string, asked: { concurrency?: number; leaseMs?: number }, caps: TenantCaps) {
    return this.atomic(() => {
      const expired = this.expireNow();
      this.sql.exec("UPDATE capacity_meta SET children=?, workflows=? WHERE id=1", caps.children, caps.workflows);
      const own = workflowCaps(asked, caps);
      const expires = this.now() + this.leaseMs(asked.leaseMs);
      if (this.workflow(workflow)) {
        this.sql.exec("UPDATE capacity_workflows SET concurrency=?, expires_at=? WHERE workflow=?", own.concurrency, expires, workflow);
      } else {
        const running = Number(this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM capacity_workflows").one().n);
        if (running >= caps.workflows) throw new CapacityError("workflow_limit", `This account runs ${running} workflows, as many as it may at once (${caps.workflows}); one must end first`);
        this.sql.exec("INSERT INTO capacity_workflows (workflow, concurrency, opened_at, expires_at) VALUES (?,?,?,?)", workflow, own.concurrency, this.now(), expires);
      }
      // Raised caps may let waiters in.
      return { caps: own, grants: [...expired, ...this.pump()] };
    });
  }

  /**
   * A slot for one child, named by the workflow's effect `key`: granted now, or queued until one frees (its
   * workflow is told: `Grant`). Idempotent on (workflow, kind, key): a replayed step gets its slot, or its place, back.
   */
  acquire(workflow: string, kind: SlotKind, key: string, leaseMs?: number): { acquired: Acquired; grants: Grant[] } {
    if (kind !== "child") throw new CapacityError("invalid", "kind is child");
    if (typeof key !== "string" || !key || key.length > 512) throw new CapacityError("invalid", "key is a string of 1 to 512 characters");
    const ms = this.leaseMs(leaseMs);
    return this.atomic(() => {
      const expired = this.expireNow();
      const flow = this.workflow(workflow);
      if (!flow) throw new CapacityError("workflow_not_open", `Workflow ${workflow} is not open here: open it first`);
      const expires = this.now() + ms;
      if (!this.sql.exec("SELECT id FROM capacity_slots WHERE workflow=? AND kind=? AND key=?", workflow, kind, key).toArray().length)
        this.sql.exec("INSERT INTO capacity_slots VALUES (?,?,?,?,'waiting',?,?)", randomUUID(), workflow, kind, key, this.next(), expires);
      else this.sql.exec("UPDATE capacity_slots SET expires_at=max(expires_at, ?) WHERE workflow=? AND kind=? AND key=?", expires, workflow, kind, key);
      const grants = [...expired, ...this.pump()];
      const row = this.sql.exec<Row>("SELECT * FROM capacity_slots WHERE workflow=? AND kind=? AND key=?", workflow, kind, key).one();
      const others = grants.filter(grant => grant.id !== row.id);
      if (row.state === "held") return { acquired: { granted: true, lease: this.lease(row) }, grants: others };
      const held = this.count("workflow=? AND kind=? AND state='held'", workflow, kind);
      const reason = held >= Number(flow.concurrency) ? "workflow_cap" as const : this.count("kind=? AND state='held'", kind) >= this.tenantCap() ? "tenant_cap" as const : "fair_share" as const;
      return { acquired: { granted: false, id: row.id, position: this.count("kind=? AND state='waiting' AND seq<?", kind, row.seq) + 1, reason }, grants: others };
    });
  }

  /** The slot ended (its child did): it goes to the next fair waiter. Releasing twice is a no-op. */
  release(workflow: string, id: string): Grant[] {
    return this.atomic(() => {
      // Expired first: the pump must never grant a waiter whose workflow stopped renewing.
      const expired = this.expireNow();
      const row = this.sql.exec<Row>("SELECT * FROM capacity_slots WHERE id=? AND workflow=?", id, workflow).toArray()[0];
      if (!row) return expired;
      this.sql.exec("DELETE FROM capacity_slots WHERE id=?", id);
      return [...expired, ...this.pump()];
    });
  }

  /** The workflow is alive: its slots, its waiting requests and itself live another lease. What it holds and awaits now. */
  renew(workflow: string, leaseMs?: number): { held: Lease[]; waiting: string[]; grants: Grant[] } {
    const ms = this.leaseMs(leaseMs);
    return this.atomic(() => {
      const grants = this.expireNow();
      if (!this.workflow(workflow)) throw new CapacityError("workflow_not_open", `Workflow ${workflow} is not open here: its leases expired, open it again`);
      const expires = this.now() + ms;
      this.sql.exec("UPDATE capacity_workflows SET expires_at=? WHERE workflow=?", expires, workflow);
      this.sql.exec("UPDATE capacity_slots SET expires_at=? WHERE workflow=?", expires, workflow);
      const rows = this.sql.exec<Row>("SELECT * FROM capacity_slots WHERE workflow=? ORDER BY seq", workflow).toArray();
      return { held: rows.filter(row => row.state === "held").map(row => this.lease(row)), waiting: rows.filter(row => row.state === "waiting").map(row => row.id), grants };
    });
  }

  /** The workflow ended: its slots and requests go, and so does its place among the tenant's running workflows. */
  close(workflow: string): Grant[] {
    return this.atomic(() => {
      const expired = this.expireNow();
      this.sql.exec("DELETE FROM capacity_slots WHERE workflow=?", workflow);
      this.sql.exec("DELETE FROM capacity_workflows WHERE workflow=?", workflow);
      return [...expired, ...this.pump()];
    });
  }

  /** Drop what expired (a workflow that stopped renewing), and give its slots to waiters. */
  expire(): Grant[] { return this.atomic(() => this.expireNow()); }

  private expireNow(): Grant[] {
    const now = this.now();
    const gone = this.sql.exec<{ workflow: string }>("SELECT workflow FROM capacity_workflows WHERE expires_at <= ?", now).toArray().map(row => row.workflow);
    for (const workflow of gone) this.sql.exec("DELETE FROM capacity_slots WHERE workflow=?", workflow);
    this.sql.exec("DELETE FROM capacity_workflows WHERE expires_at <= ?", now);
    const slots = this.count("expires_at <= ?", now);
    this.sql.exec("DELETE FROM capacity_slots WHERE expires_at <= ?", now);
    return gone.length || slots ? this.pump() : [];
  }

  /** Grant waiting requests while the tenant has room: fair share first, then round robin, oldest request first. */
  private pump(): Grant[] {
    const grants: Grant[] = [];
    const cap = this.tenantCap(), kind = "child";
    for (;;) {
      const held = this.count("kind=? AND state='held'", kind);
      if (held >= cap) break;
      const flows = this.sql.exec<{ workflow: string; held: number; cap: number; last: number; first: number }>(`
        SELECT w.workflow, w.concurrency AS cap, w.child_grant AS last,
          (SELECT count(*) FROM capacity_slots s WHERE s.workflow=w.workflow AND s.kind=? AND s.state='held') AS held,
          (SELECT min(seq) FROM capacity_slots s WHERE s.workflow=w.workflow AND s.kind=? AND s.state='waiting') AS first
        FROM capacity_workflows w`, kind, kind).toArray();
      const active = flows.filter(flow => Number(flow.held) > 0 || flow.first !== null).length;
      const share = Math.max(1, Math.floor(cap / Math.max(1, active)));
      const candidates = flows.filter(flow => flow.first !== null && Number(flow.held) < Number(flow.cap));
      if (!candidates.length) break;
      candidates.sort((a, b) => Number(Number(a.held) >= share) - Number(Number(b.held) >= share) || Number(a.last) - Number(b.last) || Number(a.first) - Number(b.first));
      const chosen = candidates[0];
      const row = this.sql.exec<Row>("SELECT * FROM capacity_slots WHERE workflow=? AND kind=? AND state='waiting' ORDER BY seq LIMIT 1", chosen.workflow, kind).one();
      this.sql.exec("UPDATE capacity_slots SET state='held' WHERE id=?", row.id);
      this.sql.exec("UPDATE capacity_workflows SET child_grant=? WHERE workflow=?", this.next(), chosen.workflow);
      grants.push({ workflow: row.workflow, ...this.lease(row) });
    }
    return grants;
  }

  /** When the next lease or workflow expires, strictly after now; undefined when nothing can. */
  nextExpiry(): number | undefined {
    const at = this.sql.exec<{ at: number | null }>("SELECT min(at) AS at FROM (SELECT min(expires_at) AS at FROM capacity_slots UNION ALL SELECT min(expires_at) FROM capacity_workflows)").one().at;
    return at === null ? undefined : Math.max(Number(at), this.now() + 1);
  }

  /** Usage for the console and the items API: the tenant's caps and totals, and each workflow's slots and waiters. */
  usage(workflow?: string): CapacityUsage {
    const caps = this.caps();
    const kind = (name: string, kind: SlotKind, cap: number): KindUsage => ({
      held: this.count("workflow=? AND kind=? AND state='held'", name, kind), waiting: this.count("workflow=? AND kind=? AND state='waiting'", name, kind), cap });
    const flows = (workflow ? [this.workflow(workflow)].filter(Boolean) : this.sql.exec<WorkflowRow>("SELECT * FROM capacity_workflows ORDER BY opened_at").toArray()) as WorkflowRow[];
    const totals = (k: SlotKind) => ({ held: this.count("kind=? AND state='held'", k), waiting: this.count("kind=? AND state='waiting'", k) });
    return {
      tenant: { caps, workflows: Number(this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM capacity_workflows").one().n), children: totals("child") },
      workflows: flows.map(row => ({ workflow: row.workflow, children: kind(row.workflow, "child", Number(row.concurrency)), openedAt: Number(row.opened_at), expiresAt: Number(row.expires_at) })),
    };
  }
}
