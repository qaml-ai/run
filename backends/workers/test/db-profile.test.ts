import { test } from "node:test";
import assert from "node:assert/strict";
import { DbProfile, dbPhase, profileConnect, profileHttp, profileSql, statementCategory } from "../src/db-profile.ts";

test("concurrent profiles retain phase attribution and never expose SQL or parameters", async () => {
  const profiles = [new DbProfile(true), new DbProfile(true)];
  await Promise.all(profiles.map((profile, i) => profile.run("admission", async () => {
    const sql = profileSql({ async query(_text: string, _values?: unknown[]) { await Promise.resolve(); return { rows: [] }; } });
    await profileConnect(async () => {});
    await sql.query("select secret from private_table", ["credential-do-not-record"]);
    await dbPhase(i ? "renew" : "hold", () => sql.query("select end_user_holds"));
    await sql.query("insert into usage values ($1)", ["private"]);
    await sql.query("select webhook_deliveries");
  })));
  for (const [i, profile] of profiles.entries()) {
    const snapshot = profile.snapshot();
    assert.equal(snapshot.phases.admission?.queries, 1);
    assert.equal(snapshot.phases.admission?.connections, 1);
    assert.equal(snapshot.phases[i ? "renew" : "hold"]?.queries, 1);
    assert.equal(snapshot.phases.usage?.queries, 1);
    assert.equal(snapshot.phases.webhooks?.queries, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /credential|private|secret/);
    profile.snapshot(true);
    assert.deepEqual(profile.snapshot(), { phases: {}, operations: {} });
  }
});

test("transactions include control round trips, hold time and failed queries", async () => {
  const profile = new DbProfile(true);
  await profile.run("settle", async () => {
    const sql = profileSql({ async query(text: string) { if (text === "fail") throw new Error("not recorded"); return { rows: [] }; } });
    await sql.query("begin");
    await sql.query("select end_user_holds");
    await assert.rejects(sql.query("fail"));
    await sql.query("rollback");
  });
  const m = profile.snapshot().phases.settle!;
  assert.equal(m.queries, 4);
  assert.equal(m.errors, 1);
  assert.equal(m.transactions, 1);
  assert.equal(m.transactionSamplesMs.length, 1);
  assert.ok(m.transactionMs >= 0);
});

test("profiling is opt in and HTTP response data and status remain intact", async () => {
  const profile = new DbProfile(false);
  await profile.run("hold", () => profileSql({ async query() { return { rows: [] }; } }).query());
  assert.deepEqual(profile.snapshot(), { phases: {}, operations: {} });
  const response = await profileHttp(true, async () => {
    await profileSql({ async query(_text: string) { return { rows: [] }; } }).query("select 1");
    return new Response("okay", { status: 202, headers: { "x-existing": "yes" } });
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("x-existing"), "yes");
  assert.equal(await response.text(), "okay");
  assert.equal(JSON.parse(response.headers.get("x-pilot-db-profile")!).phases.edge.queries, 1);
  assert.equal((await profileHttp(false, async () => new Response())).headers.has("x-pilot-db-profile"), false);
});


test("statement categories use only fixed schema names and operation labels", () => {
  assert.equal(statementCategory("select * from agents join agent_spend_limits on true where secret='raw-value'"), "select:agent_spend_limits+agents");
  assert.equal(statementCategory("select credential from customer_supplied_table where token=$1"), "select:other");
  assert.equal(statementCategory("insert into usage values ($1)"), "insert:usage");
});
