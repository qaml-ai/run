import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { testDatabase } from "./database.ts";
import { runtime } from "./runtime-server.ts";

async function accounts(db: any) {
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: {
    tokenSha256: "a".repeat(64), apiKeys: {}, billing: "prepaid",
  } } }) });
  await tenants.reload();
  return new Accounts({ db, tenants });
}

test("receipt consumption is atomic with prepaid accounting and survives concurrent recovery", async () => {
  const { db } = await testDatabase();
  const first = await accounts(db);
  await first.billing.post([{ tenant: "payg", kind: "grant", amount: 1_000_000, key: "grant" }]);
  for (let id = 1; id <= 2; id++) await db.query(`insert into pi_usage_receipts(session_id,entry_id,tenant,message) values ('session',$1,'payg',$2)`,
    [id, JSON.stringify({ provider: "anthropic", model: "fixture", platform: true, usage: { input: 10, output: 1, cost: { total: 0.1 } }, ...(id === 2 ? { kind: "compaction" } : {}) })]);
  await db.query(`create function reject_receipt() returns trigger language plpgsql as $$ begin raise exception 'receipt failure'; end $$`);
  await db.query(`create trigger reject_receipt before update on pi_usage_receipts for each row execute function reject_receipt()`);
  await assert.rejects(first.flushUsage(), /receipt failure/);
  assert.equal(Number((await db.query("select count(*) from usage")).rows[0].count), 0);
  assert.equal(Number((await db.query("select balance from credit_accounts where tenant='payg'")).rows[0].balance), 1_000_000);
  await db.query("drop trigger reject_receipt on pi_usage_receipts");
  const second = await accounts(db);
  await Promise.all([first.flushUsage(), second.flushUsage()]);
  await first.flushUsage();
  const totals = (await db.query("select sum(responses) as responses, sum(cost) as cost from usage")).rows[0];
  assert.equal(Number(totals.responses), 2);
  assert.equal(Number(totals.cost), 0.2);
  assert.equal(Number((await db.query("select balance from credit_accounts where tenant='payg'")).rows[0].balance), 800_000);
  assert.equal(Number((await db.query("select count(*) from pi_usage_receipts where accounted")).rows[0].count), 2);
  const next = { provider: "anthropic", model: "fixture", platform: true, usage: { cost: { total: 1 } } };
  await db.query("insert into pi_usage_receipts(session_id,entry_id,tenant,message) values ('session',3,'payg',$1)", [JSON.stringify(next)]);
  first.recordUsage("payg", "session", { ...next, durableReceipt: true });
  assert.equal((await first.runLimit("payg") as any)?.status, 402, "a pending receipt counts before admitting the next model call");
});

test("a rejected receipt rolls back the canonical response in the same Postgres transaction", async () => {
  const { db } = await testDatabase();
  const storage = await openPiStorage({ db, sessionId: randomUUID(), directory: tmpdir(), committing: async (entry, sql) => {
    if (entry.kind === "pi.assistant") await sql!.query("insert into pi_usage_receipts(session_id,entry_id,tenant,message) values ('session',$1,'payg','{}')", [entry.id]);
  } });
  await storage.commit([{ type: "conversation", value: { id: 1 as any } }], context);
  await db.query("alter table pi_usage_receipts add constraint rejected check (false)");
  const id = await storage.mintId<any>();
  await assert.rejects(storage.commit([{ type: "entry", value: { id, conversationId: 1 as any, kind: "pi.assistant" } }], context), /rejected/);
  assert.equal(await storage.entry(id, context), undefined);
  await storage.close(context);
});

for (const hosting of ["inline", "process"]) test(`actual native response uses existing durable attempts and counts usage once (${hosting})`, async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "done", usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } }),
    { AGENT_ENGINE: "pi-durable", AGENT_HOSTING: hosting });
  const created = await r.call("/v1/agents", { body: { codeMode: false } });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;
  await r.prompt(id, "test receipts");
  const receipts = (await r.db.query("select * from pi_usage_receipts where session_id=$1", [id])).rows;
  assert.equal(receipts.length, 0, "tracked model attempts must not also enter the fallback receipt ledger");
  await r.call("/v1/usage");
  const totals = (await r.db.query("select sum(responses) as responses from usage")).rows[0];
  assert.equal(Number(totals.responses), 1);
  assert.equal(Number((await r.db.query("select count(*) as n from model_attempts where agent=$1 and state='settled'", [id])).rows[0].n), 1);
});
