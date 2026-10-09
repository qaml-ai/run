import { randomUUID } from "node:crypto";
import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { safeError } from "./metrics.ts";
import { clock, network, random } from "./node-context.ts";
import { buggify } from "./buggify.ts";
import { reachable, sometimes } from "./assert.ts";

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
 * only) it is a plain transaction. A rerun (see `transaction`) runs `work` again: `rerun: false` for work that may not.
 */
export function underClaim<T>(db: Db, claim: Claim | undefined, work: (sql: Sql) => Promise<T>, options: { rerun?: boolean } = {}): Promise<T> {
  return transaction(db, async sql => {
    if (claim && !(await sql.query("select from actor_owners where actor = $1 and session = $2 and epoch = $3 for share", [claim.actor, claim.session, claim.epoch])).rowCount) {
      throw new LostClaim(claim.actor);
    }
    return work(sql);
  }, options);
}

/** Peers suspect a node whose last renewal began this many heartbeats ago (`reap`). */
export const SUSPECT_RENEWALS = 3;
/**
 * A node makes model and tool calls only while its last successful renewal began fewer than this many
 * heartbeats ago (`fresh`). The heartbeat left before peers suspect it covers the gap between a check
 * and the call it lets through, clock rate drift, and a late timer cutting a model request in flight.
 */
export const FRESH_RENEWALS = 2;

/**
 * Which node serves each actor (an agent or a volume). Every node keeps one
 * heartbeat row, renewed every sixth of the TTL but at least every 3 s on the
 * database's clock (and retried every thirtieth of the TTL while renewal fails, as in
 * a database failover), and each actor it serves has an ownership row naming the
 * node's session and an epoch. Renewal is one write per node however many actors it serves.
 *
 * A node takes an actor only when the row is released, already names this
 * session, or names a session whose heartbeat has expired; every acquire advances
 * the epoch. A node that cannot renew before its published expiry fences itself:
 * it stops serving everything it owns and rejoins under a new session, so peers
 * can take its actors as soon as they see the heartbeat expire. An expired heartbeat
 * is never renewed: its node fences instead.
 *
 * The TTL is long, so a node rides out a database failover. A node that died is found
 * sooner (`reap`): a peer ends a heartbeat three renewals late whose node refuses
 * connections or does not answer them, which frees its actors at once.
 *
 * So a node cut off from its peers and the database alike may be taken for dead while it
 * still runs, long before its own deadline. Its database writes are fenced, but its model
 * and tool calls are not database writes: those wait for a fresh lease instead (`fresh`),
 * a successful renewal that began less than two heartbeats ago, one heartbeat before any
 * peer could suspect the node. A node that is not fresh pauses its effects and cuts its
 * model requests in flight (`onStale`); when a renewal succeeds again (a database failover
 * ends) they go on. Only at the deadline does it fence.
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
  /** When the last successful renewal (or registration) began, on the same clock and from the same point as `deadline`. */
  private renewedAt = -Infinity;
  /** How long after `renewedAt` this node may still act (`fresh`). */
  readonly freshMs: number;
  /** Fires as the lease stops being fresh (see `stale`). */
  private staleTimer?: ReturnType<typeof setTimeout>;
  private staleSince?: number;
  private readonly staled = new Set<() => void>();
  /** Effects waiting for a fresh lease (`whenFresh`): woken by each successful renewal, and by a fence. */
  private waiters?: PromiseWithResolvers<void>;
  /** Other nodes' actors, so forwarding needs no query per request; entries never outlive the owner's heartbeat. */
  private readonly owners = new Map<string, { node: string; until: number }>();
  private readonly cacheMs: number;
  private peers?: { nodes: string[]; until: number };
  /** How often the heartbeat is renewed. */
  readonly heartbeatMs: number;
  private readonly alive?: (node: string) => Promise<boolean>;
  private readonly reaped = new Set<(nodes: string[]) => void>();
  private reaping = false;
  private closed = false;
  draining = false;

  /**
   * `alive`, when given, says whether a peer whose heartbeat is late still runs (see `reap`); nodes use
   * `probeNode`. It must answer true unless the peer's process is certainly gone.
   */
  constructor(db: Db, options: { node: string; ttlMs?: number; cacheMs?: number; alive?: (node: string) => Promise<boolean> }) {
    this.db = db;
    this.node = options.node;
    this.ttlMs = options.ttlMs ?? 90_000;
    this.cacheMs = options.cacheMs ?? 5_000;
    this.heartbeatMs = Math.max(10, Math.min(Math.floor(this.ttlMs / 6), 3_000));
    this.freshMs = FRESH_RENEWALS * this.heartbeatMs;
    this.alive = options.alive;
  }

  async start() {
    await this.register();
    this.timer ??= clock().setInterval(() => void this.renew(), this.heartbeatMs);
    this.timer.unref();
  }

  /** Called with the peers `reap` ended, once their heartbeats are gone: their actors are free. */
  onReaped(listener: (nodes: string[]) => void) { this.reaped.add(listener); }

  /** This node's current session. Rows it writes under it (busy-agents.ts) count only while its heartbeat is live. */
  get sessionId() { return this.session; }

  /** Called when this node fences itself; everything it served must stop. */
  onFence(listener: (reason: string) => void) { this.fenced.add(listener); }

  /** Called when this node's lease stops being fresh: model requests in flight must be cut (they are made again once it is). */
  onStale(listener: () => void) { this.staled.add(listener); }

  /**
   * Whether this node may make side effects (model and tool calls, channel sends) now: its last successful renewal
   * began less than `freshMs` ago, so no peer can have taken it for dead (they suspect it at `SUSPECT_RENEWALS`).
   */
  fresh() { return this.registered && clock().monotonic() - this.renewedAt < this.freshMs; }

  /**
   * Wait for a fresh lease: at once while it is, else until a renewal succeeds (a database failover ends). A node
   * that fenced (no later than its deadline) rejoins first, as an acquire would: claims it held stay lost (`holds`).
   * Rejects when it cannot, once the node closed, or when `signal` aborts.
   */
  async whenFresh(signal?: AbortSignal): Promise<void> {
    while (!this.fresh()) {
      signal?.throwIfAborted();
      if (this.closed) throw new HttpError(503, "This node is shutting down; retry");
      if (!this.registered) { await this.register(); continue; }
      const waiters = this.waiters ??= Promise.withResolvers<void>();
      if (!signal) { await waiters.promise; continue; }
      const aborted = Promise.withResolvers<void>();
      const abort = () => aborted.resolve();
      signal.addEventListener("abort", abort, { once: true });
      try { await Promise.race([waiters.promise, aborted.promise]); }
      finally { signal.removeEventListener("abort", abort); }
    }
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = undefined;
    waiters?.resolve();
  }

  private register() {
    if (this.registered) return Promise.resolve();
    return this.registering ??= (async () => {
      const session = this.session;
      const started = clock().monotonic();
      await this.db.query(`
        insert into runtime_nodes (node, session, expires_at) values ($1, $2, now() + $3 * interval '1 millisecond')
        on conflict (node) do update set session = excluded.session, expires_at = excluded.expires_at, draining = false`, [this.node, session, this.ttlMs]);
      if (session !== this.session) return;
      this.registered = true;
      this.arm(started);
    })().finally(() => { this.registering = undefined; });
  }

  /** Extend this node's heartbeat. A failure is retried next tick; the watchdog fences at the deadline. */
  async renew() {
    // A node that fenced rejoins at the next tick, under its new session, whether or not it takes an actor: an idle one
    // would otherwise stay out of the cluster, no peer for a retiring task to retire to. Not one that drains or closed.
    if (!this.registered && !this.registering && !this.closed && !this.draining) {
      await this.register().catch(error => console.error(JSON.stringify({ type: "heartbeat_rejoin_failed", error: safeError(error) })));
      return;
    }
    if (!this.registered || this.renewing) return;
    this.renewing = true;
    const session = this.session;
    // Measured before the write, so the local deadline never passes the published expiry.
    const started = clock().monotonic();
    try {
      if (buggify("ownership.renew.fails")) throw new Error("BUGGIFY: the heartbeat renewal failed");
      // Only a live heartbeat is renewed: one that expired, or that a peer ended (`reap`), may have lost its actors.
      const { rowCount } = await this.db.query("update runtime_nodes set expires_at = now() + $3 * interval '1 millisecond' where node = $1 and session = $2 and expires_at > now()", [this.node, session, this.ttlMs]);
      if (session !== this.session) return;
      sometimes(!rowCount, "a renewal found its heartbeat ended");
      if (!rowCount) this.fence("heartbeat_replaced");
      else {
        this.arm(started);
        if (this.alive) void this.reap().catch(error => console.error(JSON.stringify({ type: "reap_failed", error: safeError(error) })));
      }
    } catch (error) {
      console.error(JSON.stringify({ type: "heartbeat_renew_failed", error: (error as Error).message }));
      // Retry soon rather than a whole interval later: every second lost here is a second less of outage the node survives.
      this.retry ??= clock().setTimeout(() => { this.retry = undefined; void this.renew(); }, Math.max(10, Math.floor(this.ttlMs / 30)));
      this.retry.unref();
    } finally { this.renewing = false; }
  }

  /**
   * End the heartbeats of peers that died, so their actors are free without waiting out the TTL. A peer is
   * a suspect once its last renewal is three of this node's heartbeats old; its heartbeat is ended only if
   * `alive` says its process is gone, and only if it has not renewed since. A live process, even one whose
   * event loop is stalled, still accepts connections (the kernel completes them), so a late heartbeat alone
   * (a database outage, a slow renewal) never ends one: peers wait for its expiry, as before. Runs after
   * each renewal, one at a time.
   */
  async reap(): Promise<string[]> {
    if (!this.alive || this.reaping || !this.registered) return [];
    const lateMs = this.ttlMs - SUSPECT_RENEWALS * this.heartbeatMs;
    if (lateMs <= 0) return [];
    this.reaping = true;
    try {
      const { rows } = await this.db.query(`
        select node, session from runtime_nodes
        where node <> $1 and expires_at > now() and expires_at < now() + $2 * interval '1 millisecond'`, [this.node, lateMs]);
      const ended: string[] = [];
      await Promise.all(rows.map(async ({ node, session }) => {
        // A probe that times out counts as gone, as a partitioned peer's does.
        if (!buggify("ownership.reap.probe_times_out") && await this.alive!(node)) return;
        const { rowCount } = await this.db.query(`
          delete from runtime_nodes where node = $1 and session = $2 and expires_at > now() and expires_at < now() + $3 * interval '1 millisecond'`,
          [node, session, lateMs]);
        if (!rowCount) return;
        ended.push(node);
        reachable("a late peer's heartbeat was ended");
        console.log(JSON.stringify({ type: "node_reaped", node, by: this.node }));
      }));
      if (!ended.length) return ended;
      for (const [actor, entry] of this.owners) if (ended.includes(entry.node)) this.owners.delete(actor);
      this.peers = undefined;
      for (const listener of this.reaped) {
        try { listener(ended); } catch (error) { console.error(JSON.stringify({ type: "reap_listener_failed", error: safeError(error) })); }
      }
      return ended;
    } finally { this.reaping = false; }
  }

  /**
   * After a successful write of the heartbeat that began at `started`: fence a tenth of the TTL before its expiry, so a
   * slow timer or clock drift cannot outlast the published expiry, and act until `freshMs` after it.
   */
  private arm(started: number) {
    clock().clearTimeout(this.watchdog);
    this.deadline = started + this.ttlMs - this.ttlMs / 10;
    this.watchdog = clock().setTimeout(() => this.fence("heartbeat_expired"), Math.max(0, this.deadline - clock().monotonic()));
    this.watchdog.unref();
    this.renewedAt = Math.max(this.renewedAt, started);
    clock().clearTimeout(this.staleTimer);
    this.staleTimer = clock().setTimeout(() => this.stale(), Math.max(0, this.renewedAt + this.freshMs - clock().monotonic()));
    this.staleTimer.unref();
    if (this.fresh()) {
      if (this.staleSince !== undefined) console.log(JSON.stringify({ type: "lease_fresh", node: this.node, staleMs: Math.round(clock().monotonic() - this.staleSince) }));
      this.staleSince = undefined;
      this.wake();
    }
  }

  /**
   * The lease is no longer fresh: new effects wait (`whenFresh`). A renewal under way (one a blocked event loop
   * delayed runs before this) gets half a heartbeat to land; then model requests in flight are cut. Even then
   * they end, at the latest, two and a half heartbeats after the last renewal began, before peers suspect the node.
   */
  private stale() {
    if (!this.registered) return;
    // Timers run on a coarser clock than performance.now(), and may run a fraction of a millisecond early.
    if (this.fresh()) {
      this.staleTimer = clock().setTimeout(() => this.stale(), Math.max(1, Math.ceil(this.renewedAt + this.freshMs - clock().monotonic())));
      this.staleTimer.unref();
      return;
    }
    this.staleSince ??= clock().monotonic();
    console.error(JSON.stringify({ type: "lease_stale", node: this.node, sinceRenewalMs: Math.round(clock().monotonic() - this.renewedAt) }));
    void this.renew();
    this.staleTimer = clock().setTimeout(() => {
      if (!this.registered || this.fresh()) return;
      console.error(JSON.stringify({ type: "lease_interrupt", node: this.node, sinceRenewalMs: Math.round(clock().monotonic() - this.renewedAt) }));
      for (const listener of this.staled) {
        try { listener(); } catch (error) { console.error(JSON.stringify({ type: "stale_listener_failed", error: safeError(error) })); }
      }
    }, Math.max(1, Math.floor(this.heartbeatMs / 2)));
    this.staleTimer.unref();
  }

  /** Stop serving every actor, then rejoin under a new session on the next acquire. */
  fence(reason: string) {
    if (!this.registered) return;
    reachable("a node fenced itself");
    console.error(JSON.stringify({ type: "self_fence", node: this.node, reason }));
    clock().clearTimeout(this.watchdog);
    clock().clearTimeout(this.staleTimer);
    this.registered = false;
    this.session = randomUUID();
    this.renewedAt = -Infinity;
    this.staleSince = undefined;
    // Effects waiting for a fresh lease give up: their claims are gone.
    this.wake();
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
      // Only while this node's own heartbeat is live, so peers never see an owner they would call dead. Only the row this
      // statement's snapshot saw is taken: one that changed while it waited (another node took it) is checked against
      // that snapshot's heartbeats, which may not hold the new owner's yet, so it is left, and `owner` reads afresh.
      const { rows } = await this.db.query(`
        insert into actor_owners as o (actor, node, session, epoch)
        select $1, $2, $3, 1 where exists (select 1 from runtime_nodes where node = $2 and session = $3 and expires_at > now())
        on conflict (actor) do update set node = excluded.node, session = excluded.session, epoch = o.epoch + 1
        where o.epoch = (select epoch from actor_owners where actor = $1)
          and (o.session is null or o.session = excluded.session
            or not exists (select 1 from runtime_nodes n where n.node = o.node and n.session = o.session and n.expires_at > now()))
        returning epoch`, [actor, this.node, session]);
      this.owners.delete(actor);
      sometimes(attempt > 0, "an acquire tried again after a heartbeat expired between its statements");
      if (rows[0]) {
        sometimes(rows[0].epoch > 1, "an actor was taken again, under a later epoch");
        return { claim: { actor, session, epoch: rows[0].epoch } };
      }
      const owner = await this.owner(actor);
      if (owner && owner !== this.node) return { owner };
    }
    throw new HttpError(503, "This node could not take ownership; retry");
  }

  /** Whether a claim is still this node's: it has not fenced since taking it, and its fence is not overdue. */
  holds(claim: Claim) { return this.registered && claim.session === this.session && clock().monotonic() < this.deadline; }

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
    const now = clock().monotonic();
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
    const now = clock().monotonic();
    if (!this.peers || this.peers.until <= now) {
      const { rows } = await this.db.query("select node from runtime_nodes where node <> $1 and expires_at > now() and not draining", [this.node]);
      this.peers = { nodes: rows.map(row => row.node), until: now + this.cacheMs };
    }
    return this.peers.nodes[Math.floor(random().float() * this.peers.nodes.length)];
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
    this.closed = true;
    clock().clearInterval(this.timer);
    clock().clearTimeout(this.watchdog);
    clock().clearTimeout(this.retry);
    clock().clearTimeout(this.staleTimer);
    const session = this.session;
    this.registered = false;
    this.wake();
    this.session = randomUUID();
    await this.db.query("delete from runtime_nodes where node = $1 and session = $2", [this.node, session]);
  }
}

/** Errors that mean nothing listens at an address: the process exited, or its host is gone. */
const GONE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN"]);

/**
 * Whether a node's process still runs, by opening a TCP connection to its address: false only when the
 * connection is refused or the host unreachable, or nothing answers within `timeoutMs` (a stopped task's
 * address drops it). A live process accepts even while its event loop is stalled. An address that is not
 * a URL, a name that does not resolve here, or any other error answers true: nothing is known, so peers
 * wait for the heartbeat to expire.
 */
export function probeNode(node: string, timeoutMs = 2_000): Promise<boolean> {
  let url: URL;
  try { url = new URL(node); } catch { return Promise.resolve(true); }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return new Promise(resolve => {
    const socket = network().connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port });
    const done = (alive: boolean) => { clock().clearTimeout(timer); socket.destroy(); resolve(alive); };
    const timer = clock().setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", error => done(!GONE.has((error as NodeJS.ErrnoException).code ?? "")));
  });
}
