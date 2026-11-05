import pg, { Client } from "pg";
import { transaction as policyTransaction } from "./postgres-policy.ts";
export { databaseRetryable, databaseUnavailable } from "./postgres-policy.ts";

// Match src/db.ts: ledger amounts and millisecond timestamps are safe integers.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export type Sql = {
  query<R = any>(
    text: string,
    values?: any[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
};
export type DbClient = Sql & {
  close?: () => Promise<void>;
  release(error?: Error): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
};
export type Db = Sql & {
  connect(): Promise<DbClient>;
  end(): Promise<void>;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
};
export type PostgresEnv = { HYPERDRIVE: { connectionString: string } };

/** One short-lived client per operation; never pin an origin connection to a DO. */
export async function withSql<T>(
  env: PostgresEnv,
  run: (sql: Sql) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    application_name: new URL(env.HYPERDRIVE.connectionString).searchParams.get("application_name") ?? "camelrun-proto-workers",
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Adapter for unchanged relational services. connect() is only held by transaction(). */
export function database(env: PostgresEnv): Db {
  return {
    query: (text, values) => withSql(env, (sql) => sql.query(text, values)),
    async connect() {
      const client = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
        connectionTimeoutMillis: 5_000,
        query_timeout: 10_000,
      });
      await client.connect();
      return Object.assign(client, {
        close: () => client.end(),
        release: () => {
          void client.end();
        },
      }) as DbClient;
    },
    async end() {},
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  };
}

/** Transaction callbacks contain SQL only, never model calls or DO RPC. */
export async function transaction<T>(
  target: Db | PostgresEnv,
  run: (sql: Sql) => Promise<T>,
  options: { rerun?: boolean } = {},
): Promise<T> {
  return policyTransaction("HYPERDRIVE" in target ? database(target) : target, run, options);
}
