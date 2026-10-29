import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { openPiStorage, remotePiStorage, storageRequest } from "../src/pi-durable/storage.ts";
import { seedJournal } from "../src/pi-durable/seed.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { testDatabase } from "./database.ts";
import { OPERATOR, runtime, until } from "./runtime-server.ts";

const imported = ["claude-sonnet-5", "claude-opus-4-1", "gpt-4o"].flatMap((model, index) => [
  { role: "user" as const, content: `Old question ${index}`, timestamp: index * 2 + 1 },
  { role: "assistant" as const, content: [{ type: "text" as const, text: `Old answer ${index}` }],
    api: index === 2 ? "openai-completions" as const : "anthropic-messages" as const,
    provider: index === 2 ? "openai" : "anthropic", model, stopReason: "stop" as const, timestamp: index * 2 + 2,
    usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 400, totalTokens: 820,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } } },
]);

for (const mode of ["sqlite", "postgres", "remote-postgres"]) test(`seed commits never invoke effects; later responses still do (${mode})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "seed-billing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const effects: string[] = [];
  const local = await openPiStorage({ directory, sessionId: randomUUID(),
    ...(mode === "sqlite" ? {} : { db: (await testDatabase()).db }),
    committing: async entry => { effects.push(entry.kind); } });
  t.after(() => local.close(context));
  const storage = mode === "remote-postgres" ? remotePiStorage(async request => {
    const answer = await storageRequest(local, JSON.parse(JSON.stringify(request)));
    return answer === undefined ? undefined : JSON.parse(JSON.stringify(answer));
  }) : local;
  const options = { storage, sessionId: "import", model: [], messages: imported, before: { total: imported.length }, archive: { messages: imported, turns: [0, 2, 4] } };
  await seedJournal(options);
  await seedJournal(options);
  assert.deepEqual(effects, [], "imports, archives, checkpoints and seed retries have no commit effects");
  for (const kind of ["camel.message", "pi.assistant", "camel.compaction.usage"]) {
    await storage.commit([{ type: "entry", value: { id: await storage.mintId(), conversationId: 1 as never, kind,
      model: [imported[1]] as never } }], () => {}, context);
  }
  assert.deepEqual(effects, ["camel.message", "pi.assistant", "camel.compaction.usage"]);
});

for (const hosting of ["inline", "process"]) test(`imported usage and forks are free; the next real turn is billed once (${hosting})`, async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "done", usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } }),
    { AGENT_HOSTING: hosting }, { tenants: { alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), apiKeys: {} } },
      platformKeys: { openrouter: "fixture-platform-key" } });
  assert.equal((await r.call("/v1/webhooks", { body: { url: "https://hooks.example.test/usage", events: ["usage.recorded"] } })).status, 201);
  const initialMessages = [...imported.slice(0, 2), { role: "compactionSummary", summary: "The first old question was answered.", tokensBefore: 820, timestamp: 2 }, ...imported.slice(2)];
  const created = await r.call("/v1/agents", { body: { codeMode: false, initialMessages, spendLimit: { usd: 100 } } });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;
  // Creation starts the host in the background. The header loses initialMessages only after seeding finishes.
  await until(async () => (await r.db.query("select header from agents where id=$1", [id])).rows[0]?.header.config.initialMessages === undefined, "the import to finish");
  const history = (await r.call(`/v1/agents/${id}/history`)).json.messages;
  assert.deepEqual(history, imported, "keep original usage for context accounting");
  const noCharge = async (agent: string) => {
    await r.call("/v1/usage");
    assert.equal(Number((await r.db.query("select count(*) from pi_usage_receipts where session_id=$1", [agent])).rows[0].count), 0);
    assert.equal((await r.call(`/v1/agents/${agent}`)).json.spendLimit.spent, 0);
    assert.equal(Number((await r.db.query("select count(*) from webhook_deliveries where body->>'type'='usage.recorded' and body->'data'->>'agentId'=$1", [agent])).rows[0].count), 0);
  };
  await noCharge(id);
  assert.equal(r.model.bodies.length, 0, "importing makes no provider call");
  assert.equal(Number((await r.db.query("select coalesce(sum(responses), 0) as n from usage")).rows[0].n), 0);

  const forked = await r.call(`/v1/agents/${id}/fork`, { body: { key: "import-fork" } });
  assert.equal(forked.status, 201, forked.text);
  assert.deepEqual((await r.call(`/v1/agents/${forked.json.id}/history`)).json.messages, imported);
  await noCharge(forked.json.id);

  const reset = await r.call(`/v1/agents/${id}/context/reset`, { body: { keepMessages: 4 } });
  assert.equal(reset.status, 200, reset.text);
  await noCharge(id);
  assert.deepEqual((await r.call(`/v1/agents/${id}/history`)).json.messages, imported);

  await r.prompt(id, "A new question");
  await r.call("/v1/usage");
  assert.equal(r.model.bodies.length, 1);
  const totals = (await r.db.query("select sum(responses) as responses, sum(cost) as cost from usage")).rows[0];
  assert.equal(Number(totals.responses), 1);
  assert.equal(Number(totals.cost), 0.01);
  assert.equal((await r.call(`/v1/agents/${id}`)).json.spendLimit.spent, 0.01);
  assert.equal(Number((await r.db.query("select count(*) from model_attempts where agent=$1 and state='settled'", [id])).rows[0].count), 1);
  assert.equal(Number((await r.db.query("select count(*) from pi_usage_receipts where session_id=$1", [id])).rows[0].count), 0);
  await until(async () => Number((await r.db.query("select count(*) from webhook_deliveries where body->>'type'='usage.recorded' and body->'data'->>'agentId'=$1", [id])).rows[0].count) === 1, "the real response's usage event");
});

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
  await storage.commit([{ type: "conversation", value: { id: 1 as any } }], () => {}, context);
  await db.query("alter table pi_usage_receipts add constraint rejected check (false)");
  const id = await storage.mintId<any>();
  await assert.rejects(storage.commit([{ type: "entry", value: { id, conversationId: 1 as any, kind: "pi.assistant" } }], () => {}, context), /rejected/);
  assert.equal(await storage.entry(id, context), undefined);
  await storage.close(context);
});

for (const hosting of ["inline", "process"]) test(`actual native response uses existing durable attempts and counts usage once (${hosting})`, async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "done", usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } }),
    { AGENT_HOSTING: hosting });
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
