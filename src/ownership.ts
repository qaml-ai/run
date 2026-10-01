import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";

/** This node's ownership of one actor. Writes that only the owner may make are conditional on it. */
export interface Claim { actor: string; session: string; epoch: number }

/** A write under a claim that is no longer current: another node may own the actor now. */
export class LostClaim extends HttpError {
  constructor(actor: string) { super(503, `This node lost ownership of ${actor}; retry`); this.name = "LostClaim"; }
}

/**
 * Run `work` in one transaction that first locks the claim's ownership row FOR SHARE,
 * as a log append does: a takeover waits until it commits, and once the claim is no
 * longer current nothing runs (LostClaim). Every write to state an actor owns goes
 * through here or a log append. With no claim (no ownership configured: one node
 * only) it is a plain transaction.
 */
export function underClaim<T>(db: Db, claim: Claim | undefined, work: (sql: Sql) => Promise<T>): Promise<T> {
  return transaction(db, async sql => {
    if (claim && !(await sql.query("select from actor_owners where actor = $1 and session = $2 and epoch = $3 for share", [claim.actor, claim.session, claim.epoch])).rowCount) {
      throw new LostClaim(claim.actor);
    }
    return work(sql);
  });
}

/**
 * Which node serves each actor (an agent or a volume). Every node keeps one
 * heartbeat row, renewed every sixth of the TTL on the database's clock (and retried
 * every thirtieth while renewal fails, as in a database failover), and each
 * actor it serves has an ownership row naming the node's session and an epoch.
 * Renewal is one write per node however many actors it serves.
 *
 * A node takes an actor only when the row is released, already names this
 * session, or names a session whose heartbeat has expired; every acquire advances
 * the epoch. A node that cannot renew before its published expiry fences itself:
 * it stops serving everything it owns and rejoins under a new session, so peers
 * can take its actors as soon as they see the heartbeat expire.
 */
export class Ownership {
  readonly node: string;
  readonly ttlMs: number;
  private readonly db: Db;
  private session = randomUUID();
  private registering?: Promise<void>;
  private registered = false;
  private renewing = false;
  private readonly fenced = new Set<(reason: string) => void>();
  private timer?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  /** When the watchdog is due; `holds` checks it too, so a timer delayed by a blocked event loop cannot extend a claim. */
  private deadline = 0;
  /** Other nodes' actors, so forwarding needs no query per request; entries never outlive the owner's heartbeat. */
  private readonly owners = new Map<string, { node: string; until: number }>();
  private readonly cacheMs: number;
  private peers?: { nodes: string[]; until: number };
  draining = false;

  constructor(db: Db, options: { node: string; ttlMs?: number; cacheMs?: number }) {
    this.db = db;
    this.node = options.node;
    this.ttlMs = options.ttlMs ?? 90_000;
    this.cacheMs = options.cacheMs ?? 5_000;
  }

  async start() {
    await this.register();
    this.timer ??= setInterval(() => void this.renew(), Math.max(10, Math.floor(this.ttlMs / 6)));
    this.timer.unref();
  }

  /** This node's current session. Rows it writes under it (busy-agents.ts) count only while its heartbeat is live. */
  get sessionId() { return this.session; }

  /** Called when this node fences itself; everything it served must stop. */
  onFence(listener: (reason: string) => void) { this.fenced.add(listener); }

  private register() {
    if (this.registered) return Promise.resolve();
    return this.registering ??= (async () => {
      const session = this.session;
      const started = performance.now();
      await this.db.query(`
        insert into runtime_nodes (node, session, expires_at) values ($1, $2, now() + $3 * interval '1 millisecond')
        on conflict (node) do update set session = excluded.session, expires_at = excluded.expires_at, draining = false`, [this.node, session, this.ttlMs]);
      if (session !== this.session) return;
      this.arm(started + this.ttlMs);
      this.registered = true;
    })().finally(() => { this.registering = undefined; });
  }

  /** Extend this node's heartbeat. A failure is retried next tick; the watchdog fences at the deadline. */
  async renew() {
    if (!this.registered || this.renewing) return;
    this.renewing = true;
    const session = this.session;
    // Measured before the write, so the local deadline never passes the published expiry.
    const started = performance.now();
    try {
      const { rowCount } = await this.db.query("update runtime_nodes set expires_at = now() + $3 * interval '1 millisecond' where node = $1 and session = $2", [this.node, session, this.ttlMs]);
      if (session !== this.session) return;
      if (!rowCount) this.fence("heartbeat_replaced");
      else this.arm(started + this.ttlMs);
    } catch (error) {
      console.error(JSON.stringify({ type: "heartbeat_renew_failed", error: (error as Error).message }));
      // Retry soon rather than a whole interval later: every second lost here is a second less of outage the node survives.
      this.retry ??= setTimeout(() => { this.retry = undefined; void this.renew(); }, Math.max(10, Math.floor(this.ttlMs / 30)));
      this.retry.unref();
    } finally { this.renewing = false; }
  }

  /** Fence a tenth of the TTL before the deadline, so a slow timer or clock drift cannot outlast the published expiry. */
  private arm(deadline: number) {
    clearTimeout(this.watchdog);
    this.deadline = deadline - this.ttlMs / 10;
    this.watchdog = setTimeout(() => this.fence("heartbeat_expired"), Math.max(0, this.deadline - performance.now()));
    this.watchdog.unref();
  }

  /** Stop serving every actor, then rejoin under a new session on the next acquire. */
  fence(reason: string) {
    if (!this.registered) return;
    console.error(JSON.stringify({ type: "self_fence", node: this.node, reason }));
    clearTimeout(this.watchdog);
    this.registered = false;
    this.session = randomUUID();
    for (const listener of this.fenced) {
      try { listener(reason); } catch (error) { console.error(JSON.stringify({ type: "fence_listener_failed", error: (error as Error).message })); }
    }
  }

  /** Take an actor. Returns this node's claim on it, or the node that serves it now. */
  async acquire(actor: string): Promise<{ claim: Claim } | { owner: string }> {
    if (this.draining) {
      const owner = await this.owner(actor);
      if (owner && owner !== this.node) return { owner };
      throw new HttpError(503, "This node is shutting down; retry");
    }
    await this.register();
    const session = this.session;
    // Two statements see two clocks: a heartbeat can expire between them, leaving neither a claim nor an owner. Then try again.
    for (let attempt = 0; attempt < 3; attempt++) {
      // Only while this node's own heartbeat is live, so peers never see an owner they would call dead.
      const { rows } = await this.db.query(`
        insert into actor_owners as o (actor, node, session, epoch)
        select $1, $2, $3, 1 where exists (select 1 from runtime_nodes where node = $2 and session = $3 and expires_at > now())
        on conflict (actor) do update set node = excluded.node, session = excluded.session, epoch = o.epoch + 1
        where o.session is null or o.session = excluded.session
          or not exists (select 1 from runtime_nodes n where n.node = o.node and n.session = o.session and n.expires_at > now())
        returning epoch`, [actor, this.node, session]);
      this.owners.delete(actor);
      if (rows[0]) return { claim: { actor, session, epoch: rows[0].epoch } };
      const owner = await this.owner(actor);
      if (owner && owner !== this.node) return { owner };
    }
    throw new HttpError(503, "This node could not take ownership; retry");
  }

  /** Whether a claim is still this node's: it has not fenced since taking it, and its fence is not overdue. */
  holds(claim: Claim) { return this.registered && claim.session === this.session && performance.now() < this.deadline; }

  /** Give an actor up so any node can take it at once. */
  async release(claim: Claim) {
    await this.db.query("update actor_owners set node = null, session = null where actor = $1 and session = $2 and epoch = $3", [claim.actor, claim.session, claim.epoch]);
  }

  /** The node serving `actor` under a live heartbeat, if any. */
  async owner(actor: string): Promise<string | undefined> {
    const { rows } = await this.db.query(`
      select o.node from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session
      where o.actor = $1 and n.expires_at > now()`, [actor]);
    return rows[0]?.node;
  }

  /**
   * Where requests for an actor this node does not hold go: its live owner (cached
   * for a few seconds), or while draining, any live peer, which then takes it. The
   * cache is only a hint: a node that no longer owns an actor cannot serve it, and
   * callers `forget` an entry when its node answers 503 or cannot be reached.
   */
  async route(actor: string): Promise<string | undefined> {
    const now = performance.now();
    const hit = this.owners.get(actor);
    if (hit && hit.until > now) return hit.node;
    this.owners.delete(actor);
    const { rows } = await this.db.query(`
      select o.node, extract(epoch from n.expires_at - now()) * 1000 as remaining from actor_owners o
      join runtime_nodes n on n.node = o.node and n.session = o.session
      where o.actor = $1 and n.expires_at > now()`, [actor]);
    const owner = rows[0]?.node as string | undefined;
    if (owner && owner !== this.node) {
      if (this.owners.size >= 10_000) for (const [key, entry] of this.owners) if (entry.until <= now) this.owners.delete(key);
      this.owners.set(actor, { node: owner, until: now + Math.min(this.cacheMs, Number(rows[0].remaining)) });
    }
    return owner ?? (this.draining ? this.peer() : undefined);
  }

  /** Drop what is cached about a node that answered 503 or could not be reached. */
  forget(actor?: string) {
    if (actor) this.owners.delete(actor);
    this.peers = undefined;
  }

  /** Every other node whose heartbeat is live, draining or not. */
  async livePeers(): Promise<string[]> {
    return (await this.db.query("select node from runtime_nodes where node <> $1 and expires_at > now() order by node", [this.node])).rows.map(row => row.node);
  }

  /** A live peer that is not draining, if any. */
  async peer(): Promise<string | undefined> {
    const now = performance.now();
    if (!this.peers || this.peers.until <= now) {
      const { rows } = await this.db.query("select node from runtime_nodes where node <> $1 and expires_at > now() and not draining", [this.node]);
      this.peers = { nodes: rows.map(row => row.node), until: now + this.cacheMs };
    }
    return this.peers.nodes[Math.floor(Math.random() * this.peers.nodes.length)];
  }

  /** Stop taking actors, and tell peers to stop sending this node work. What it owns it keeps serving. */
  async drain() {
    this.draining = true;
    await this.db.query("update runtime_nodes set draining = true where node = $1 and session = $2", [this.node, this.session]);
  }

  /** Take actors again, and tell peers so: a retiring node left with no peer to hand them to. */
  async undrain() {
    this.draining = false;
    this.forget();
    await this.db.query("update runtime_nodes set draining = false where node = $1 and session = $2", [this.node, this.session]);
  }

  /** Leave the cluster: dropping the heartbeat frees every actor this node still names. */
  async close() {
    clearInterval(this.timer);
    clearTimeout(this.watchdog);
    clearTimeout(this.retry);
    const session = this.session;
    this.registered = false;
    this.session = randomUUID();
    await this.db.query("delete from runtime_nodes where node = $1 and session = $2", [this.node, session]);
  }
}
