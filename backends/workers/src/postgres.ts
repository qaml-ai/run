import type { AgentInvocation } from "./agent-invocation.ts";
import { applyScope } from "../../../shared/apply-scope.ts";
import pg, { Client } from "pg";
import { transaction as policyTransaction } from "./postgres-policy.ts";
import { profileConnect, profileSql, traceDatabaseFailure } from "./db-profile.ts";
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
export type PostgresEnv = { HYPERDRIVE: { connectionString: string }; AGENT_CREATE_DIAGNOSTICS?: string };

/** Lease an invocation client, or open a short-lived client for this operation. */
export async function withSql<T>(
  env: PostgresEnv,
  run: (sql: Sql) => Promise<T>,
  invocation?: AgentInvocation,
): Promise<T> {
  const scoped = applyScope.getStore();
  if (scoped) return run(scoped.sql);
  if (invocation) {
    const client = await invocation.postgres(() => openClient(env, true)).connect();
    try { return await run(client); }
    finally { await client.close(); }
  }
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    application_name: new URL(env.HYPERDRIVE.connectionString).searchParams.get("application_name") ?? "camelrun-proto-workers",
  });
  try {
    await profileConnect(() => traceDatabaseFailure(env.AGENT_CREATE_DIAGNOSTICS === "1", "connect", () => client.connect()));
    return await run(profileSql(client, env.AGENT_CREATE_DIAGNOSTICS === "1"));
  } finally {
    await client.end();
  }
}

async function openClient(env: PostgresEnv, pooled: boolean) {
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    ...(pooled ? { application_name: new URL(env.HYPERDRIVE.connectionString).searchParams.get("application_name") ?? "camelrun-proto-workers" } : {}),
  });
  if (pooled) client.on("error", () => {});
  try {
    await profileConnect(() => traceDatabaseFailure(env.AGENT_CREATE_DIAGNOSTICS === "1", "connect", () => client.connect()));
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
  return Object.assign(profileSql(client, env.AGENT_CREATE_DIAGNOSTICS === "1"), {
    close: () => client.end(),
    release: () => { void client.end(); },
  });
}

/** Adapter for relational services. Transactions hold one checkout until commit or rollback. */
export function database(env: PostgresEnv, invocation?: AgentInvocation): Db {
  return {
    query: (text, values) => withSql(env, (sql) => sql.query(text, values), invocation),
    async connect() {
      return invocation ? invocation.postgres(() => openClient(env, true)).connect() : openClient(env, false);
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
  invocation?: AgentInvocation,
): Promise<T> {
  const scoped = applyScope.getStore();
  if (scoped) return run(scoped.sql);
  return policyTransaction("HYPERDRIVE" in target ? database(target, invocation) : target, run, options);
}
