// Generated from src/db.ts; host imports and connection release are adapted.
// Run node backends/workers/scripts/reuse-security.mjs --check to check source drift.
import type { Db, Sql } from "./postgres.ts";

import { applyScope } from "../../../shared/apply-scope.ts";

import { clock } from "./money-host.ts";

// Host diagnostics and jitter; the transaction and error policy below are from src/.

const random = () => ({ float: Math.random });

const sometimes = (_condition: boolean, _message: string) => {};

const AUTH_FAILED = "28P01";

const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "57P01", "57P02", "57P03", "53300", AUTH_FAILED]);

const UNAVAILABLE_MESSAGES = /^(Connection terminated|Query read timeout|timeout exceeded when trying to connect|Client has encountered a connection error)/;

export function databaseRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;
  return error instanceof AggregateError && error.errors.some(databaseRetryable);
}

const RERUN_CODES = new Set(["40001", "40P01"]);

const RETRYABLE_CODES = new Set([...RERUN_CODES, "57014"]);

const TRANSACTION_ATTEMPTS = 3;

export function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (UNAVAILABLE_CODES.has(code) || code.startsWith("08"))) return true;
  if (error instanceof AggregateError && error.errors.some(databaseUnavailable)) return true;
  return UNAVAILABLE_MESSAGES.test(error.message);
}

export async function transaction<T>(db: Db, work: (sql: Sql) => Promise<T>, options: { rerun?: boolean } = {}): Promise<T> {
  const scoped = applyScope.getStore();
  if (scoped) return work(scoped.sql);
  if (options.rerun === false) return transactionOnce(db, work);
  for (let attempt = 1; ; attempt++) {
    try { return await transactionOnce(db, work); }
    catch (error) {
      const code = (error as { code?: unknown }).code;
      if (attempt >= TRANSACTION_ATTEMPTS || typeof code !== "string" || !RERUN_CODES.has(code)) throw error;
      sometimes(true, "a transaction that lost a race ran again");
      await clock().sleep(Math.floor((10 + random().float() * 40) * attempt));
    }
  }
}

async function transactionOnce<T>(db: Db, work: (sql: Sql) => Promise<T>): Promise<T> {
  const client = await db.connect();
  // A checked-out client whose connection drops emits 'error'; unheard, that would crash the process.
  // The statement in flight fails too, and a broken client is dropped from the pool, not reused.
  let broken: Error | undefined;
  const lost = (error: Error) => { broken = error; };
  client.on("error", lost);
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => { broken ??= error as Error; });
    throw error;
  } finally {
    client.off("error", lost);
    // Workers close the per-operation socket before releasing the request.
    if (client.close) await client.close();
    else client.release(broken);
  }
}