import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";

/** This node's ownership of one actor. Writes that only the owner may make are conditional on it. */
export interface Claim { actor: string; session: string; epoch: number }

/**
 * Which node serves each actor (an agent or a volume). Every node keeps one
 * heartbeat row, renewed every third of the TTL on the database's clock, and each
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

  constructor(db: Db, options: { node: string; ttlMs?: number }) {
    this.db = db;
    this.node = options.node;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  async start() {
    await this.register();
    this.timer ??= setInterval(() => void this.renew(), Math.max(10, Math.floor(this.ttlMs / 3)));
    this.timer.unref();
  }

  /** Called when this node fences itself; everything it served must stop. */
  onFence(listener: (reason: string) => void) { this.fenced.add(listener); }

  private register() {
    if (this.registered) return Promise.resolve();
    return this.registering ??= (async () => {
      const session = this.session;
      const started = performance.now();
      await this.db.query(`
        insert into runtime_nodes (node, session, expires_at) values ($1, $2, now() + $3 * interval '1 millisecond')
        on conflict (node) do update set session = excluded.session, expires_at = excluded.expires_at`, [this.node, session, this.ttlMs]);
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
    } finally { this.renewing = false; }
  }

  /** Fence a tenth of the TTL before the deadline, so a slow timer or clock drift cannot outlast the published expiry. */
  private arm(deadline: number) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => this.fence("heartbeat_expired"), Math.max(0, deadline - this.ttlMs / 10 - performance.now()));
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
    await this.register();
    const session = this.session;
    // Only while this node's own heartbeat is live, so peers never see an owner they would call dead.
    const { rows } = await this.db.query(`
      insert into actor_owners as o (actor, node, session, epoch)
      select $1, $2, $3, 1 where exists (select 1 from runtime_nodes where node = $2 and session = $3 and expires_at > now())
      on conflict (actor) do update set node = excluded.node, session = excluded.session, epoch = o.epoch + 1
      where o.session is null or o.session = excluded.session
        or not exists (select 1 from runtime_nodes n where n.node = o.node and n.session = o.session and n.expires_at > now())
      returning epoch`, [actor, this.node, session]);
    if (rows[0]) return { claim: { actor, session, epoch: rows[0].epoch } };
    const owner = await this.owner(actor);
    if (owner && owner !== this.node) return { owner };
    throw new HttpError(503, "This node could not take ownership; retry");
  }

  /** Whether a claim is still this node's: it has not fenced since taking it. */
  holds(claim: Claim) { return this.registered && claim.session === this.session; }

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

  /** Leave the cluster: dropping the heartbeat frees every actor this node still names. */
  async close() {
    clearInterval(this.timer);
    clearTimeout(this.watchdog);
    const session = this.session;
    this.registered = false;
    this.session = randomUUID();
    await this.db.query("delete from runtime_nodes where node = $1 and session = $2", [this.node, session]);
  }
}
