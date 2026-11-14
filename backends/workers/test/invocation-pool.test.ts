import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { AgentInvocation } from "../src/agent-invocation.ts";
import { database, transaction, withSql } from "../src/postgres.ts";

class Connection extends EventEmitter {
  ended = false;
  statements: string[] = [];
  async close() { this.ended = true; }
  release() { void this.close(); }
  async query<R>(text: string): Promise<{ rows: R[]; rowCount: number }> {
    this.statements.push(text);
    if (text === "fail") throw new Error("statement failed");
    return { rows: [], rowCount: 0 };
  }
}

const env = { HYPERDRIVE: { connectionString: "postgres://localhost/unused" } };

function setup() {
  const invocation = new AgentInvocation();
  const connections: Connection[] = [];
  invocation.postgres(async () => {
    const connection = new Connection();
    connections.push(connection);
    return connection;
  });
  return { invocation, connections, db: database(env, invocation) };
}

test("four checkouts cap the pool, queued work is FIFO, and idle clients are reused", async () => {
  const { invocation, db, connections } = setup();
  try {
    assert.equal(connections.length, 0);
    const active = await Promise.all(Array.from({ length: 4 }, () => db.connect()));
    const order: string[] = [];
    const query = (text: string) => withSql(env, async sql => {
      order.push(text);
      await sql.query(text);
    }, invocation);
    const first = query("fifth"), second = query("sixth");
    await Promise.resolve();
    assert.equal(connections.length, 4);
    assert.deepEqual(order, []);
    await active[0].close!();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["fifth", "sixth"]);
    assert.deepEqual(connections[0].statements, order);
    assert.equal(connections.length, 4);
  } finally {
    await invocation.end();
  }
  assert.ok(connections.every(connection => connection.ended));
});

test("a transaction exclusively leases one connection through commit", async () => {
  const { invocation, connections } = setup();
  try {
    await transaction(env, async sql => {
      await sql.query("transaction work");
      await withSql(env, other => other.query("parallel work"), invocation);
      assert.deepEqual(connections.map(connection => connection.statements),
        [["begin", "transaction work"], ["parallel work"]]);
    }, {}, invocation);
    assert.deepEqual(connections[0].statements, ["begin", "transaction work", "commit"]);
  } finally {
    await invocation.end();
  }
});

test("query failures and idle connection errors discard the client without retrying", async () => {
  const { invocation, db, connections } = setup();
  try {
    await assert.rejects(db.query("fail"), /statement failed/);
    assert.deepEqual(connections[0].statements, ["fail"]);
    assert.equal(connections[0].ended, true);
    await db.query("next");
    connections[1].emit("error", new Error("socket dropped"));
    await db.query("last");
    assert.equal(connections[1].ended, true);
    assert.deepEqual(connections[2].statements, ["last"]);
  } finally {
    await invocation.end();
  }
});

test("ending rejects waiters and closes a client still connecting", async () => {
  const invocation = new AgentInvocation();
  const opening = Promise.withResolvers<Connection>();
  const pool = invocation.postgres(() => opening.promise);
  const active = Array.from({ length: 4 }, () => assert.rejects(pool.connect(), /checkout is unavailable/));
  const waiting = assert.rejects(pool.connect(), /invocation has ended/);
  await Promise.resolve();
  const ended = invocation.end();
  const client = new Connection();
  opening.resolve(client);
  await Promise.all([...active, waiting, ended]);
  assert.equal(client.ended, true);
});
