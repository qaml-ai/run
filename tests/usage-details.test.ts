import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { transaction } from "../src/db.ts";
import { runtime, until } from "./runtime-server.ts";
import { testDatabase } from "./database.ts";
import { groupedUsage, recordUsageDetails, resolveUsageAttribution, pruneUsageDetails, ownsUsageAgent, usageOptions } from "../shared/usage-details.ts";
const day = () => new Date().toISOString().slice(0,10);
const base = () => ({ tenant: "alice", agent: "child", endUser: "reader", timestamp: Date.now(), day: day(), model: "p/m",
  responses: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.2, platformResponses: 1, platformCost: 0.2 });

test("daily aggregates retain a call's attribution for reconciliation after deletion", async () => {
  const { db } = await testDatabase();
  const header = { parent: { agentId: "parent", chain: ["root", "parent"] }, definition: { id: "def_original" } };
  await db.query("insert into agents (id,tenant,header,revision,name,type,model) values ('child','alice',$1,1,'child','agent','model')", [JSON.stringify(header)]);
  const row = base(), attribution = await resolveUsageAttribution(db, row);
  await recordUsageDetails(db, [{ ...row, attribution }]);
  await db.query("delete from agents where id='child'");
  await recordUsageDetails(db, [{ ...row, attribution, responses: 0, input: 0, output: 0, cost: -0.05, platformResponses: 0, platformCost: -0.05 }]);
  const report = await groupedUsage(db, "alice", 0, { dimensions: ["agent","definition","endUser"], rollup: true }, "root");
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].agent, "root");
  assert.equal(report.groups[0].definition, "def_original");
  assert.equal(report.groups[0].endUser, "reader");
  assert.equal(report.totals.responses, 1);
  assert.ok(Math.abs(report.totals.cost - 0.15) < 1e-9);
  assert.equal((await db.query("select count(*)::int n from usage_details")).rows[0].n, 1);
  assert.equal(await ownsUsageAgent(db, "alice", "child"), true);
  assert.equal(await ownsUsageAgent(db, "bob", "child"), false);
});

test("null dimensions aggregate, pagination is complete, totals cover all pages, and retention expires data", async () => {
  const { db } = await testDatabase();
  await recordUsageDetails(db, [{ ...base(), agent: "" }, { ...base(), agent: "" }, ...["a", "b", "c"].map(agent => ({ ...base(), agent }))]);
  assert.equal((await db.query("select count(*)::int n from usage_details")).rows[0].n, 4);
  const groups: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await groupedUsage(db, "alice", 0, { dimensions: ["agent"], rollup: false, limit: 1, cursor });
    assert.equal(page.groups.length, 1);
    assert.equal(page.totals.responses, 5);
    groups.push(...page.groups);
    cursor = page.next;
  } while (cursor);
  assert.equal(new Set(groups.map(g => g.agent)).size, 4);
  assert.equal(groups.find(g => g.agent === null).responses, 2);
  const first = await groupedUsage(db, "alice", 0, { dimensions: ["agent"], rollup: false, limit: 1 });
  await assert.rejects(groupedUsage(db, "bob", 0, { dimensions: ["agent"], rollup: false, limit: 1, cursor: first.next }), /Invalid cursor/);
  assert.throws(() => usageOptions(new URLSearchParams("limit=0")), /limit/);
  assert.throws(() => usageOptions(new URLSearchParams("limit=501")), /limit/);
  const expired = new Date(Date.now() - 400 * 86400000).toISOString().slice(0,10);
  await db.query("insert into usage_details (tenant,day,model,totals) values ('alice',$1,'expired',$2)", [expired, JSON.stringify({responses: 1})]);
  assert.equal((await groupedUsage(db, "alice", 0, { dimensions: ["model"], rollup: false })).groups.some((g: any) => g.model === "expired"), false);
  await pruneUsageDetails(db);
  assert.equal((await db.query("select count(*)::int n from usage_details where model='expired'")).rows[0].n, 0);
});

test("migration folds old call rows and preserves attribution for later corrections", async () => {
  const { db } = await testDatabase();
  await db.query("drop table usage_details");
  await db.query(`create table usage_details (
    tenant text not null, agent text, root_agent text, definition text, end_user text, workspace text,
    occurred_at bigint not null, day date not null, model text not null, totals jsonb not null
  )`);
  const row = base();
  await db.query(`insert into model_attempts (id,tenant,agent,provider,model,kind,platform,catalog_priced,prepaid,started_at,updated_at,next_check_at)
    values ('00000000-0000-4000-8000-000000000001','alice','child','p','p/m','response',false,false,false,$1,$1,$1)`, [row.timestamp]);
  for (let i = 0; i < 2; i++) await db.query(`insert into usage_details (tenant,agent,root_agent,definition,occurred_at,day,model,totals)
    values ('alice','child','root','original',$1,$2,'p/m',$3)`, [row.timestamp, row.day, JSON.stringify(row)]);
  await db.query(readFileSync(new URL("../migrations/127_usage_details.sql", import.meta.url), "utf8"));
  const rows = (await db.query("select * from usage_details")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].totals.responses, 2);
  assert.equal(rows[0].totals.cost, 0.4);
  assert.deepEqual((await db.query("select context from model_attempts")).rows[0].context.usageAttribution,
    { root: "root", definition: "original", workspace: null });
  await recordUsageDetails(db, [{ ...row, endUser: null, attribution: { root: "root", definition: "original", workspace: null } }]);
  assert.equal((await db.query("select count(*)::int n from usage_details")).rows[0].n, 1);
});


test("daily bucket grouping retains corrections and includes missing buckets and subjects", async () => {
  const { db } = await testDatabase();
  const rows = [
    { ...base(), bucket: "bot:1", cost: 0.3 },
    { ...base(), bucket: "bot:2", cost: 0.4 },
    { ...base(), bucket: null, endUser: null, cost: 0.5 },
  ];
  await recordUsageDetails(db, rows);
  await recordUsageDetails(db, [{ ...rows[0], cost: -0.1, responses: 0 }]);
  const options = usageOptions(new URLSearchParams("groupBy=day,bucket,endUser"));
  const report = await groupedUsage(db, "alice", 0, options);
  assert.equal(report.groups.length, 3);
  assert.ok(Math.abs(report.totals.cost - 1.1) < 1e-9);
  assert.ok(Math.abs(report.groups.find((row: any) => row.bucket === "bot:1").cost - 0.2) < 1e-9);
  assert.equal(report.groups.find((row: any) => row.bucket === null).endUser, null);
  assert.equal((await groupedUsage(db, "other", 0, options)).groups.length, 0);
});

test("older writers keep their conflict key and their usage stays visible alongside bucket totals", async () => {
  const { db } = await testDatabase();
  await transaction(db, sql => recordUsageDetails(sql, [{ ...base(), bucket: "bot:1" }]));
  // The pre-upgrade writer only updates usage_details, using its original conflict key.
  await db.query(`insert into usage_details (tenant,day,agent,root_agent,definition,end_user,model,workspace,totals)
    select tenant,day,agent,root_agent,definition,end_user,model,workspace,totals from usage_details
    on conflict (tenant,day,agent,root_agent,definition,end_user,model,workspace)
    do update set totals=jsonb_build_object('responses',2,'input',20,'output',10,'cacheRead',0,'cacheWrite',0,'cost',0.4,'platformResponses',2,'platformCost',0.4)`);
  const report = await groupedUsage(db, "alice", 0, { dimensions: ["bucket"], rollup: false });
  assert.equal(report.groups.length, 2);
  assert.equal(report.groups.find((row: any) => row.bucket === null).responses, 1);
  assert.equal(report.groups.find((row: any) => row.bucket === "bot:1").responses, 1);
  assert.equal(report.totals.cost, 0.4);
  assert.equal((await groupedUsage(db, "alice", 0, { dimensions: ["model"], rollup: false })).totals.cost, 0.4);
  await assert.rejects(transaction(db, async sql => {
    await recordUsageDetails(sql, [{ ...base(), bucket: "bot:2" }]);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal((await groupedUsage(db, "alice", 0, { dimensions: ["bucket"], rollup: false })).totals.responses, 2);
});

test("run bucket attribution reaches the account and agent usage APIs without a subject", async t => {
  const r = await runtime(t, () => ({ content: "ok", usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.1 } }));
  const made = await r.call("/v1/agents", { body: { name: "bucket-report" } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.id;
  for (const bucket of ["bot:1", "bot:2"]) {
    const run = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "hello", bucket } });
    assert.equal(run.status, 202, run.text);
    await until(async () => (await r.call(`/v1/agents/${id}/requests/${run.json.id}`)).json.state === "completed", "run completed");
  }
  await until(async () => (await r.call("/v1/usage?groupBy=bucket")).json.totals.responses === 2, "bucket usage flushed");
  for (const path of ["/v1/usage?groupBy=bucket", `/v1/agents/${id}/usage?groupBy=bucket`]) {
    const report = await r.call(path);
    assert.equal(report.status, 200, report.text);
    assert.deepEqual(report.json.groups.map((row: any) => row.bucket).sort(), ["bot:1", "bot:2"]);
    assert.equal(report.json.totals.responses, 2);
  }
});
