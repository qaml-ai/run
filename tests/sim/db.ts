import { AsyncResource } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Db, DbClient, Rows } from "../../src/db.ts";

const INT8 = 20;

/**
 * The cluster's database as a simulation drives it: a `Db` per node that can be cut off or killed, a LISTEN per node,
 * queries of its own for checkers, and the statements it ran. SimDb (PGlite, deterministic) and PostgresDb (a real
 * server, for the nightly mode) are the two.
 */
export interface WorldDb {
  readonly statements: string[];
  /** How the ownership statements came out (`ownershipOutcome`), counted: what the fuzzer reads as behaviour. */
  readonly outcomes: Map<string, number>;
  /** `gate` is called with each answer's statement before the node hears it: it waits while the node is paused. */
  connection(node: string, gate?: (text: string) => Promise<void>, latency?: () => number): Db & { kill(): void };
  listen(node: string, dead?: () => boolean, deliver?: (work: () => void) => void): (handlers: Record<string, (payload: string) => void>) => Promise<{ close(): Promise<void> }>;
  setDown(node: string, down: boolean): void;
  migrate(): Promise<void>;
  /** A query of the simulation's own (a checker's), as no node. */
  query(text: string, values?: unknown[]): Promise<Rows>;
  close(): Promise<void>;
}
const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/**
 * What an ownership statement (on actor_owners or runtime_nodes) came to: which statement (its table and verb) and
 * whether it found or changed a row. A renewal that found its heartbeat gone, an acquire that took nothing, an owner
 * query that found none: the paths a race takes, which coverage of the code that runs them does not tell apart.
 */
export function ownershipOutcome(text: string, rowCount: number) {
  const flat = text.trim().replace(/\s+/g, " ").toLowerCase();
  const table = /\b(actor_owners|runtime_nodes)\b/.exec(flat)?.[1];
  if (!table) return undefined;
  return `${flat.split(" ", 1)[0]} ${table}${flat.includes(" join ") ? " join" : ""}: ${rowCount ? "rows" : "none"}`;
}

/**
 * The simulated database: one PGlite (Postgres in WASM, in this process), shared by every node, each through its own
 * `Db` (`connection`). PGlite has one session, so a transaction holds it to itself and every other query waits: each
 * transaction is one atomic step of the simulation, which explores all serial orders of transactions but none of the
 * interleavings inside them (the nightly real-Postgres mode is for those). Its `now()` follows the process's `Date.now`,
 * which the simulation's clock fakes, so the database clock is virtual too.
 *
 * A node's connection can be cut (`down`): its queries fail as in a failover, its open transaction rolls back, and its
 * LISTEN hears nothing; `up` restores it. A crashed node's connection is ended.
 */
export class SimDb implements WorldDb {
  readonly pglite: PGlite;
  private holder: Promise<void> = Promise.resolve();
  /** The database runs as itself, never as the node that asked: its `now()` is the base clock, not a node's skewed one. */
  private readonly scope = new AsyncResource("SimDb");
  private readonly down = new Set<string>();
  /** Every statement, for the trace: `node: first word`. */
  readonly statements: string[] = [];
  readonly outcomes = new Map<string, number>();

  private constructor(pglite: PGlite) { this.pglite = pglite; }

  /**
   * A database for a run. `seed` seeds SQL's random() (the orphan sweep orders by it), which would otherwise draw from
   * the machine's entropy. (gen_random_uuid() still does; nothing on simulated paths orders by what it makes.)
   */
  static async create(seed = 0) {
    const pglite = await PGlite.create({ parsers: { [INT8]: (value: string) => Number(value) } });
    await pglite.query("select setseed($1)", [seed]);
    return new SimDb(pglite);
  }

  /** Run `work` with the session to itself. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.holder.then(work);
    this.holder = result.then(() => {}, () => {});
    return result;
  }

  private async run(node: string, text: string, values?: unknown[]): Promise<Rows> {
    if (this.down.has(node)) throw unavailable();
    this.statements.push(`${this.scope.runInAsyncScope(() => Date.now())} ${node}: ${text.trim().replace(/\s+/g, " ").slice(0, 70)} ${JSON.stringify(values ?? []).slice(0, 200)}`);
    const result = await this.scope.runInAsyncScope(() => this.pglite.query<Record<string, unknown>>(text, values as unknown[]));
    // PGlite counts only changed rows; pg counts a select's rows too.
    const rowCount = result.affectedRows || result.rows.length;
    const outcome = ownershipOutcome(text, rowCount);
    if (outcome) this.outcomes.set(outcome, (this.outcomes.get(outcome) ?? 0) + 1);
    return { rows: result.rows, rowCount };
  }

  /** Cut `node` off from the database, or (up) let it back. */
  setDown(node: string, down: boolean) {
    if (down) this.down.add(node); else this.down.delete(node);
  }

  /**
   * `node`'s view of the database: its own pool. Ending it ends nothing shared. `kill` is its process dying: every
   * query from then on fails, as the server dropped its connections (an open transaction rolls back on release).
   */
  connection(node: string, gate: (text: string) => Promise<void> = async () => {}, latency: () => number = () => 0): Db & { kill(): void } {
    let ended = false, killed = false;
    // A paused node hears the answer once it runs again (`gate`).
    const answered = <T>(result: Promise<T>, text: string) => result.then(async value => { await gate(text); return value; }, async error => { await gate(text); throw error; });
    // A pool query's round trip (`latency`, virtual ms): it reaches the server that much later, on the node's timers.
    const travel = async () => { const ms = latency(); if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms)); };
    const query = (text: string, values?: unknown[]) => ended ? Promise.reject(new Error("Cannot use a pool after calling end on the pool"))
      : killed ? Promise.reject(unavailable()) : answered(travel().then(() => this.exclusive(() => killed ? Promise.reject(unavailable()) : this.run(node, text, values))), text);
    return {
      query: query as Db["query"],
      connect: () => new Promise<DbClient>((resolve, reject) => {
        if (ended) return reject(new Error("Cannot use a pool after calling end on the pool"));
        if (this.down.has(node) || killed) return reject(unavailable());
        void this.exclusive(() => new Promise<void>(release => {
          const listeners = new Set<(error: Error) => void>();
          // A transaction its node could not finish (cut off mid-way) is rolled back here, as the server would on the
          // connection's loss, before the session serves anyone else.
          let broken = false;
          resolve({
            query: (async (text: string, values?: unknown[]) => {
              if (killed) { broken = true; throw unavailable(); }
              try { return await answered(this.run(node, text, values), text); }
              catch (error) { if (this.down.has(node)) broken = true; throw error; }
            }) as DbClient["query"],
            release: () => { if (broken) void this.pglite.exec("rollback").catch(() => {}).finally(release); else release(); },
            on: (_event, listener) => listeners.add(listener),
            off: (_event, listener) => listeners.delete(listener),
          });
        }));
      }),
      end: async () => { ended = true; },
      kill: () => { killed = true; },
      totalCount: 0, idleCount: 0, waitingCount: 0,
    };
  }

  /** `node`'s LISTEN connection: each channel's notifications, unless the node is cut off or `dead` says it died. */
  listen(node: string, dead: () => boolean = () => false, deliver: (work: () => void) => void = work => work()) {
    return async (handlers: Record<string, (payload: string) => void>) => {
      // Notifications reach the node as itself (the context it listened in), whoever's NOTIFY sent them.
      const asNode = new AsyncResource("SimListen");
      const stops = await Promise.all(Object.entries(handlers).map(([channel, handler]) =>
        this.scope.runInAsyncScope(() => this.pglite.listen(channel, payload => { if (!this.down.has(node) && !dead()) deliver(() => asNode.runInAsyncScope(() => handler(payload))); }))));
      return { close: async () => { for (const stop of stops) await stop(); } };
    };
  }

  /** Apply the runtime's migrations (once, before any node starts, so nodes do not race to). */
  async migrate() {
    const files = readdirSync(MIGRATIONS).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    await this.pglite.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    for (const name of files) {
      await this.pglite.exec(readFileSync(new URL(name, MIGRATIONS), "utf8"));
      await this.pglite.query("insert into schema_migrations (name) values ($1)", [name]);
    }
  }

  query(text: string, values?: unknown[]): Promise<Rows> {
    return this.exclusive(() => this.scope.runInAsyncScope(async () => {
      const result = await this.pglite.query<Record<string, unknown>>(text, values as unknown[]);
      return { rows: result.rows, rowCount: result.affectedRows || result.rows.length };
    }));
  }

  close() { return this.pglite.close(); }
}

const unavailable = () => Object.assign(new Error("connect ECONNREFUSED (simulated database outage)"), { code: "ECONNREFUSED" });
