import { Client } from "pg";

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
    application_name: "camelrun-proto-workers",
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
): Promise<T> {
  const perform = async (sql: Sql) => {
    await sql.query("begin");
    try {
      await sql.query("set local statement_timeout = '8s'");
      const result = await run(sql);
      await sql.query("commit");
      return result;
    } catch (error) {
      await sql.query("rollback").catch(() => {});
      throw error;
    }
  };
  if ("HYPERDRIVE" in target) return withSql(target, perform);
  const client = await target.connect();
  try {
    return await perform(client);
  } finally {
    if (client.close) await client.close();
    else client.release();
  }
}
