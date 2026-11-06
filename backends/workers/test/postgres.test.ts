import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { databaseRetryable, databaseUnavailable, transaction, type Db, type DbClient } from "../src/postgres.ts";
import { testDatabase } from "./billing-database.ts";

const failure = (code: string, message = "injected database failure") => Object.assign(new Error(message), { code });
function fakeDatabase(query: (statement: string, connection: number, emit: (error: Error) => void) => void | Promise<void>) {
  const clients: { statements: string[]; released?: Error; done: boolean; listenerCount: () => number }[] = [];
  const db = {
    async connect() {
      const events = new EventEmitter(), connection = clients.length;
      const state = { statements: [] as string[], released: undefined as Error | undefined, done: false, listenerCount: () => events.listenerCount("error") };
      clients.push(state);
      return {
        async query(statement: string) {
          state.statements.push(statement);
          await query(statement, connection, error => events.emit("error", error));
          return { rows: [], rowCount: 0 };
        },
        release(error?: Error) { state.done = true; state.released = error; },
        on: events.on.bind(events), off: events.off.bind(events),
      } as DbClient;
    },
    async query() { return { rows: [], rowCount: 0 }; },
    async end() {}, totalCount: 0, idleCount: 0, waitingCount: 0,
  } satisfies Db;
  return { db, clients };
}

test("source transaction policy reruns only rolled-back serialization failures and deadlocks", async () => {
  for (const code of ["40001", "40P01"]) {
    const { db, clients } = fakeDatabase((statement, connection) => { if (statement === "debit" && connection === 0) throw failure(code); });
    let calls = 0;
    assert.equal(await transaction(db, async sql => { calls++; await sql.query("debit"); return "charged"; }), "charged");
    assert.equal(calls, 2);
    assert.deepEqual(clients.map(client => client.statements), [["begin", "debit", "rollback"], ["begin", "debit", "commit"]]);
    assert.ok(clients.every(client => client.done && client.listenerCount() === 0));
  }
});

test("source transaction policy limits retries and honors callers that cannot safely rerun", async () => {
  for (const [code, options, attempts] of [
    ["40001", {}, 3], ["40P01", { rerun: false }, 1], ["57014", {}, 1], ["ECONNRESET", {}, 1],
  ] as const) {
    const error = failure(code);
    const { db, clients } = fakeDatabase(statement => { if (statement === "debit") throw error; });
    await assert.rejects(transaction(db, sql => sql.query("debit"), options), error);
    assert.equal(clients.length, attempts);
    assert.ok(clients.every(client => client.done && client.listenerCount() === 0));
  }
});

test("an uncertain commit is never rerun; a lost or rollback-broken connection is discarded", async () => {
  const disconnected = failure("ECONNRESET");
  const { db, clients } = fakeDatabase((statement, _connection, emit) => {
    if (statement === "commit") { emit(disconnected); throw disconnected; }
    if (statement === "rollback") throw disconnected;
  });
  let calls = 0;
  await assert.rejects(transaction(db, async sql => { calls++; await sql.query("debit"); }), disconnected);
  assert.equal(calls, 1);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].released, disconnected);
  assert.equal(clients[0].listenerCount(), 0);
});

test("database error classification matches source nested aggregates and connection messages", () => {
  assert.equal(databaseRetryable(new AggregateError([failure("40001")])), true);
  assert.equal(databaseRetryable(failure("57014")), true);
  assert.equal(databaseRetryable({ code: "40001" }), false);
  assert.equal(databaseUnavailable(new AggregateError([failure("08006")])), true);
  assert.equal(databaseUnavailable(new Error("Query read timeout")), true);
  assert.equal(databaseUnavailable(new Error("Connection terminated unexpectedly")), true);
  assert.equal(databaseUnavailable(failure("40001")), false);
  assert.equal(databaseUnavailable({ code: "ECONNRESET" }), false);
});

test("Postgres retry rolls back the first debit before committing exactly one debit", async () => {
  const { db } = await testDatabase();
  await db.query("create table debit_retry (id text primary key, balance bigint not null check (balance >= 0))");
  await db.query("insert into debit_retry values ('account', 1000)");
  let attempts = 0;
  await transaction(db, async sql => {
    attempts++;
    await sql.query("update debit_retry set balance = balance - 375 where id = 'account'");
    if (attempts === 1) await sql.query("do $$ begin raise exception 'serialization test' using errcode = '40001'; end $$");
  });
  assert.equal(attempts, 2);
  assert.equal((await db.query("select balance from debit_retry where id = 'account'")).rows[0].balance, 625);
});
