import { AsyncResource } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate, type Db, type DbClient, type Rows } from "../../src/db.ts";
import type { WorldDb } from "./db.ts";

const URL_ = process.env.AGENT_TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/postgres";
const unavailable = () => Object.assign(new Error("connect ECONNREFUSED (simulated database outage)"), { code: "ECONNREFUSED" });

/**
 * The simulation's database on a real Postgres server (AGENT_TEST_DATABASE_URL), for the nightly mode: a schema of its
 * own per run, a pool and a LISTEN connection per node. What PGlite cannot show, two sessions' transactions
 * interleaving (lock waits, READ COMMITTED races), happens here for real; the price is that runs are not deterministic.
 * A node cut off (`setDown`) or killed fails its queries as in a failover; killing ends its pool, so the server rolls
 * back what it had open.
 */
export class PostgresDb implements WorldDb {
  readonly statements: string[] = [];
  private readonly url: string;
  private readonly schema: string;
  private readonly admin: pg.Pool;
  private readonly down = new Set<string>();
  private readonly pools = new Set<pg.Pool>();
  private readonly listeners = new Set<pg.Client>();
  private readonly scope = new AsyncResource("PostgresDb");

  private constructor(schema: string) {
    this.schema = schema;
    const url = new URL(URL_);
    url.searchParams.set("options", `-c search_path=${schema}`);
    url.searchParams.set("application_name", schema);
    this.url = url.toString();
    this.admin = new pg.Pool({ connectionString: this.url, max: 2 });
  }

  static async create() {
    const schema = `sim_${randomBytes(6).toString("hex")}`;
    const client = new pg.Client({ connectionString: URL_ });
    await client.connect();
    try { await client.query(`create schema ${schema}`); } finally { await client.end(); }
    return new PostgresDb(schema);
  }

  migrate() { return migrate(this.admin).then(() => {}); }

  query(text: string, values?: unknown[]): Promise<Rows> {
    return this.scope.runInAsyncScope(() => this.admin.query(text, values as unknown[]) as Promise<Rows>);
  }

  setDown(node: string, down: boolean) {
    if (down) this.down.add(node); else this.down.delete(node);
  }

  connection(node: string, gate: () => Promise<void> = async () => {}): Db & { kill(): void } {
    const pool = new pg.Pool({ connectionString: this.url, max: 4, connectionTimeoutMillis: 10_000 });
    pool.on("error", () => {});
    this.pools.add(pool);
    let killed = false;
    const refused = () => killed || this.down.has(node);
    const answered = <T>(result: Promise<T>) => result.then(async value => { await gate(); return value; }, async error => { await gate(); throw error; });
    const run = (sql: Pick<pg.Pool, "query">, text: string, values?: unknown[]) => {
      if (refused()) return Promise.reject(unavailable());
      this.statements.push(`${node}: ${text.trim().split(/\s+/, 1)[0]}`);
      return answered(this.scope.runInAsyncScope(() => sql.query(text, values as unknown[])) as Promise<Rows>);
    };
    return {
      query: ((text: string, values?: unknown[]) => run(pool, text, values)) as Db["query"],
      connect: async () => {
        if (refused()) throw unavailable();
        const client = await this.scope.runInAsyncScope(() => pool.connect());
        await gate();
        let broken: Error | undefined;
        return {
          query: (async (text: string, values?: unknown[]) => {
            try { return await run(client, text, values); }
            catch (error) { if (refused()) broken = error as Error; throw error; }
          }) as DbClient["query"],
          // A connection its node was cut off from mid-transaction is dropped, so the server rolls back what it held.
          release: error => client.release(error ?? broken ?? undefined),
          on: (event, listener) => client.on(event, listener),
          off: (event, listener) => client.off(event, listener),
        };
      },
      end: async () => { this.pools.delete(pool); await pool.end(); },
      kill: () => { killed = true; this.pools.delete(pool); void pool.end().catch(() => {}); },
      get totalCount() { return pool.totalCount; },
      get idleCount() { return pool.idleCount; },
      get waitingCount() { return pool.waitingCount; },
    };
  }

  listen(node: string, dead: () => boolean = () => false, deliver: (work: () => void) => void = work => work()) {
    return async (handlers: Record<string, (payload: string) => void>) => {
      const asNode = new AsyncResource("PostgresListen");
      const client = new pg.Client({ connectionString: this.url });
      client.on("error", () => {});
      this.listeners.add(client);
      await this.scope.runInAsyncScope(() => client.connect());
      client.on("notification", message => {
        const handler = handlers[message.channel];
        if (handler && message.payload !== undefined && !this.down.has(node) && !dead()) deliver(() => asNode.runInAsyncScope(() => handler(message.payload!)));
      });
      for (const channel of Object.keys(handlers)) await client.query(`listen "${channel.replaceAll("\"", "")}"`);
      return { close: async () => { this.listeners.delete(client); await client.end().catch(() => {}); } };
    };
  }

  async close() {
    for (const client of this.listeners) await client.end().catch(() => {});
    for (const pool of this.pools) await pool.end().catch(() => {});
    await this.admin.query(`drop schema ${this.schema} cascade`).catch(() => {});
    await this.admin.end();
  }
}
