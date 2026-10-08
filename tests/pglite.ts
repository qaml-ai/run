import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../src/db.ts";

/**
 * PGlite (Postgres compiled to WASM, in this process) behind the slice of `pg.Pool` the runtime uses:
 * `query` and `connect` (for `transaction`). PGlite has one session, so a checked-out client holds it
 * exclusively until released and pool queries wait for it, as a real pool's would wait on row locks.
 * This is stronger than Postgres (no two transactions ever overlap): lock contention between sessions
 * is what the real-Postgres properties are for.
 *
 * The database clock is virtual: `now()` resolves to `sim.now()`, which reads `sim.clock` (search_path
 * puts `sim` before pg_catalog), so a test moves the clock the runtime's SQL sees (`setClock`).
 */
export interface PgliteDb {
  db: Db;
  pglite: PGlite;
  /** The database clock, in ms since the epoch. */
  clock(): Promise<number>;
  setClock(ms: number): Promise<void>;
  close(): Promise<void>;
}

const INT8 = 20;

/** The SQL that makes `now()` virtual in `schema`: a one-row clock table and a `now()` that shadows pg_catalog's. */
export const VIRTUAL_CLOCK_SQL = (schema: string) => `
  create schema if not exists ${schema};
  create table ${schema}.clock (singleton boolean primary key default true, at timestamptz not null);
  insert into ${schema}.clock (at) values ('2030-01-01T00:00:00Z');
  create function ${schema}.now() returns timestamptz language sql stable as $$ select at from ${schema}.clock $$;`;

export async function pgliteDb(options: { migrations?: string[] } = {}): Promise<PgliteDb> {
  // bigint columns hold millisecond times and counts, as src/db.ts parses them for pg.
  const pglite = await PGlite.create({ parsers: { [INT8]: (value: string) => Number(value) } });
  await pglite.exec(VIRTUAL_CLOCK_SQL("sim"));
  await pglite.exec("set search_path = public, sim, pg_catalog");
  for (const file of options.migrations ?? []) await pglite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));

  let holder: Promise<void> = Promise.resolve();
  /** Run `work` with the session to itself. */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = holder.then(work);
    holder = result.then(() => {}, () => {});
    return result;
  };
  const run = async (text: string, values?: unknown[]) => {
    const result = await pglite.query<Record<string, unknown>>(text, values as any[]);
    return { rows: result.rows, rowCount: result.affectedRows || result.rows.length, fields: result.fields };
  };
  const db = {
    query: (text: string, values?: unknown[]) => exclusive(() => run(text, values)),
    connect: () => new Promise(resolveClient => {
      void exclusive(() => new Promise<void>(release => {
        resolveClient({ query: run, release: () => release(), on() {}, off() {} });
      }));
    }),
  } as unknown as Db;
  return {
    db, pglite,
    async clock() { return new Date((await db.query("select at from sim.clock")).rows[0].at).getTime(); },
    async setClock(ms) { await db.query("update sim.clock set at = $1", [new Date(ms).toISOString()]); },
    close: () => pglite.close(),
  };
}
