// Ported from tests/model-attempts.test.ts. Included assertions and test bodies are unchanged.
// Only service imports and the isolated Postgres fixture differ; see money-policy-port.json for excluded ECS fixtures.
import { Workspaces } from "../src/workspaces.ts";

import { test } from "node:test";

import assert from "node:assert/strict";

import { createHash, randomUUID } from "node:crypto";

import { Accounts } from "../src/accounts.ts";

import { EndUserCredits } from "../src/end-user-credits.ts";

import { Tenants } from "../src/tenants.ts";

import { ATTEMPT_STALE_MS, ModelAttempts } from "../src/model-attempts.ts";

import type { Db } from "../src/postgres.ts";

import { testDatabase } from "./billing-database.ts";

import { getModel } from "../src/model-catalog.ts";

import { createServer } from "node:http";

import { once } from "node:events";

const KEY = "fixture-only";

const keyHash = createHash("sha256").update(KEY).digest("hex");

const FUNDS = 1_000_000_000;

async function accounts(db: Db, tenant = "payg") {
  await db.query("insert into credit_accounts (tenant, balance, purchased) values ($1, $2, $2) on conflict (tenant) do nothing", [tenant, FUNDS]);
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { [tenant]: { tokenSha256: keyHash, billing: "prepaid" } }, platformKeys: { openrouter: KEY } }) });
  await tenants.reload();
  return new Accounts({ tenants, db });
}

async function setup() {
  const { db } = await testDatabase();
  const account = await accounts(db);
  return { db, account, attempts: new ModelAttempts(db, account) };
}

async function begin(attempts: ModelAttempts, id = randomUUID(), tenant = "payg") {
  await attempts.event(tenant, "agent", true, true, { type: "begin", id, provider: "openrouter", model: "anthropic/claude-opus-4.1", kind: "response", at: Date.now(), keyHash });
  return id;
}

const total = async (db: Db, tenant = "payg") => Number((await db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0]?.balance ?? FUNDS) - FUNDS;

const finish = (id: string, cost: number) => ({ type: "finish" as const, id, usage: { input:100,output:10,providerCost:cost,providerCreditCost:0 }, chars:40, completed:true });

test("concurrent attempt begins retain one identity and reject changed replay identities", async () => {
  const { db, attempts } = await setup();
  const id = randomUUID();
  await Promise.all(Array.from({ length: 8 }, () => begin(attempts, id)));
  assert.equal(Number((await db.query("select count(*) n from model_attempts where id=$1", [id])).rows[0].n), 1);
  const event = { type: "begin" as const, id, provider: "openrouter", model: "anthropic/claude-opus-4.1", kind: "response" as const, at: Date.now(), keyHash };
  await assert.rejects(attempts.event("other", "agent", true, true, event), /identity mismatch/);
  await assert.rejects(attempts.event("payg", "other", true, true, event), /identity mismatch/);
  await assert.rejects(attempts.event("payg", "agent", true, true, { ...event, model: "another-model" }), /identity mismatch/);
  const row = (await db.query("select tenant,agent,provider,model from model_attempts where id=$1", [id])).rows[0];
  assert.deepEqual(row, { tenant: "payg", agent: "agent", provider: "openrouter", model: event.model });
});

test("one provider attempt charges once across duplicate delivery, concurrent owners and usage callbacks", async () => {
  const { db, account, attempts } = await setup();
  const id = await begin(attempts);
  const peer = new ModelAttempts(db, await accounts(db));
  await Promise.all([attempts.event("payg","agent",true,true,finish(id,0.1)), peer.event("payg","agent",true,true,finish(id,0.1))]);
  account.recordUsage("payg","agent", { provider:"openrouter",model:"anthropic/claude-opus-4.1",platform:true,usage:{ providerCost:0.1,billingAttemptId:id } });
  await account.flushUsage();
  assert.equal(await total(db),-100000);
  assert.equal(Number((await db.query("select sum(responses) as n from usage")).rows[0].n),1);
  assert.equal(Number((await db.query("select count(*) n from credit_ledger where kind='usage'")).rows[0].n),1);
  await assert.rejects(peer.event("someone-else","agent",true,true,finish(id,0.1)), /Unknown model attempt/);
});

test("a lost commit acknowledgement can be delivered again without a second debit", async () => {
  const { db, attempts } = await setup();
  const id = await begin(attempts);
  let once = true;
  const faulty = new Proxy(db, { get(target, property) {
    if (property !== "connect") return Reflect.get(target, property);
    return async () => {
      const client = await db.connect();
      return new Proxy(client, { get(target, prop) {
        if (prop !== "query") { const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          const result = await (client.query as any)(...args);
          if (args[0] === "commit" && once) { once=false; throw Object.assign(new Error("lost commit acknowledgement"), {code:"ECONNRESET"}); }
          return result;
        };
      } });
    };
  } }) as Db;
  const flaky = new ModelAttempts(faulty, await accounts(db));
  await assert.rejects(flaky.event("payg","agent",true,true,finish(id,0.1)), /lost commit/);
  await attempts.event("payg","agent",true,true,finish(id,0.1));
  assert.equal(await total(db),-100000);
  once = true;
  const second = await begin(attempts);
  await new ModelAttempts(faulty, await accounts(db), undefined, 1_000).event("payg","agent",true,true,finish(second,0.1));
  assert.equal(await total(db),-200000,"automatic delivery retry also commits each attempt once");
});

test("end-user settlement rolls back and charges once after a lost commit acknowledgement", async () => {
  const { db, account } = await setup();
  const credits = new EndUserCredits(db);
  await credits.setSettings("payg", { enabled: true, markupBps: 2_000 });
  await credits.post("payg", "person", { kind: "grant", amount: 1_000_000, key: "funds" });
  const workspaces = new Workspaces(db);
  const original = await workspaces.create("payg", "Original"), later = await workspaces.create("payg", "Later");
  await workspaces.assign("payg", "agent", "agent", original.id);
  const attempts = new ModelAttempts(db, account, undefined, 0, undefined, credits);
  const id = randomUUID();
  await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: "anthropic/claude-opus-4.1", kind: "response", at: Date.now(), keyHash,
    estimate: { inputTokens: 100, maxOutputTokens: 100, rates: { input: 5, output: 20 } }, endUser: { id: "person", bucket: "default" } });
  await new Promise(resolve => setTimeout(resolve, 2));
  await workspaces.assign("payg", "agent", "agent", later.id);
  let seam: "before" | "after" | undefined = "before";
  const faulty = new Proxy(db, { get(target, property) {
    if (property !== "connect") return Reflect.get(target, property);
    return async () => {
      const client = await db.connect();
      return new Proxy(client, { get(target, prop) {
        if (prop !== "query") { const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => {
          if (args[0] === "commit" && seam === "before") { seam = undefined; throw new Error("crash before commit"); }
          const result = await (client.query as any)(...args);
          if (args[0] === "commit" && seam === "after") { seam = undefined; throw new Error("lost commit acknowledgement"); }
          return result;
        };
      } });
    };
  } }) as Db;
  const delivery = new ModelAttempts(faulty, account, undefined, 0, undefined, credits);
  await assert.rejects(delivery.event("payg", "agent", true, true, finish(id, 0.1)), /crash before commit/);
  assert.equal(await total(db), 0);
  assert.equal((await credits.get("payg", "person")).balance, 1_000_000);
  seam = "after";
  await assert.rejects(delivery.event("payg", "agent", true, true, finish(id, 0.1)), /lost commit acknowledgement/);
  await Promise.all(Array.from({ length: 8 }, () => attempts.event("payg", "agent", true, true, finish(id, 0.1))));
  assert.equal(await total(db), -100_000);
  assert.equal((await credits.get("payg", "person")).balance, 880_000);
  assert.equal(Number((await db.query("select count(*) n from end_user_ledger where kind='usage'")).rows[0].n), 1);
  const rows = (await db.query("select workspace, responses, cost from workspace_usage")).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { workspace: original.id, responses: 1, cost: 0.1 });
});

test("reconciliation survives a lost host, includes BYOK cost, and runs concurrently without double billing", async () => {
  const { db, account, attempts } = await setup();
  const id = await begin(attempts);
  await attempts.event("payg","agent",true,true,{ type:"generation",id,generation:"gen-recovery-fixture" });
  await db.query("update model_attempts set updated_at=0,next_check_at=0 where id=$1",[id]);
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"),`Bearer ${KEY}`);
    return Response.json({data:{ id:"gen-recovery-fixture", total_cost:0.01,is_byok:true,upstream_inference_cost:0.2,generation_time:150,cancelled:true,provider_responses:[{status:499}],native_tokens_prompt:100,native_tokens_completion:30 }});
  };
  await Promise.all([new ModelAttempts(db,account,fetcher).reconcile(),new ModelAttempts(db,await accounts(db),fetcher).reconcile()]);
  assert.equal(await total(db),-210550); // funding applies only to $0.01 of OpenRouter credits
  await attempts.event("payg","agent",true,true,finish(id,0.001)); // delayed host cannot lower final provider cost
  assert.equal(await total(db),-210550);
  assert.equal((await db.query("select state from model_attempts where id=$1",[id])).rows[0].state,"settled");
});

test("authoritative reconciliation posts only the difference, including a refund; stale failures without evidence settle", async () => {
  const { db, attempts } = await setup();
  const workspaces = new Workspaces(db);
  const original = await workspaces.create("payg", "Original"), moved = await workspaces.create("payg", "Moved");
  await workspaces.assign("payg", "agent", "agent", original.id);
  const id = await begin(attempts);
  await attempts.event("payg","agent",true,true,{...finish(id,0.2),completed:false});
  assert.equal(await total(db),-200000);
  await new Promise(resolve => setTimeout(resolve, 2));
  await workspaces.assign("payg", "agent", "agent", moved.id);
  await Promise.all([attempts.settle(id,"payg","agent",{input:100,output:10,providerCost:0.1,providerCreditCost:0},0,true,true),attempts.settle(id,"payg","agent",{input:100,output:10,providerCost:0.1,providerCreditCost:0},0,true,true)]);
  assert.equal(await total(db),-100000);
  const usage=(await db.query("select responses,cost from usage")).rows[0];
  assert.equal(usage.responses,1);assert.ok(Math.abs(usage.cost-0.1)<1e-12);
  const attributed = (await db.query("select workspace, cost, responses from workspace_usage")).rows;
  assert.equal(attributed.length, 1);
  assert.equal(attributed[0].workspace, original.id);
  assert.equal(attributed[0].responses, 1);
  assert.ok(Math.abs(attributed[0].cost - 0.1) < 1e-12);
  const pending = await begin(attempts);
  await attempts.event("payg","agent",true,true,{type:"finish",id:pending,usage:{},chars:0,completed:false});
  await db.query("update model_attempts set updated_at=0,next_check_at=0 where id=$1",[pending]);
  await attempts.reconcile();
  const row=(await db.query("select state,last_error from model_attempts where id=$1",[pending])).rows[0];
  assert.equal(row.state,"settled");assert.equal(row.last_error,null);
  assert.equal(await total(db),-100000);
});

test("a failed durable begin never dispatches a provider request", async () => {
  const { attemptStream } = await import("../src/model-attempt-stream.ts");
  let dispatched = false;
  await assert.rejects(attemptStream(getModel("openrouter","anthropic/claude-opus-4.1")!,KEY,"response",async()=>{throw new Error("database unavailable");},()=>{dispatched=true;throw new Error("must not dispatch");}));
  assert.equal(dispatched,false);
});

test("settlement rollback leaves the attempt pending, then replay and webhook corrections conserve cost", async () => {
  const { db, attempts } = await setup();
  await db.query("insert into usage_webhooks (tenant,url,secret,created_at) values ('payg','https://example.test','{}',0)");
  const id = await begin(attempts);
  await db.query("alter table usage_webhook_outbox rename to unavailable_outbox");
  await assert.rejects(attempts.event("payg","agent",true,true,{...finish(id,0.2),completed:false}));
  assert.equal(await total(db),0);
  assert.equal((await db.query("select state from model_attempts where id=$1",[id])).rows[0].state,"pending");
  await db.query("alter table unavailable_outbox rename to usage_webhook_outbox");
  await attempts.event("payg","agent",true,true,{...finish(id,0.2),completed:false});
  await attempts.settle(id,"payg","agent",{input:0,output:0,providerCost:0,providerCreditCost:0},0,true,true);
  assert.equal(await total(db),0,"authoritative zero refunds the whole estimate");
  const events=(await db.query("select body from usage_webhook_outbox order by (body->>'revision')::int")).rows.map(r=>r.body);
  assert.equal(events.length,2);
  assert.equal(events[0].cost.usd,0.2);assert.equal(events[1].cost.usd,-0.2);
  assert.equal(events[1].correction,true);assert.equal(events[1].attemptId,id);
  assert.equal((await db.query("select responses from usage")).rows[0].responses,1);
  const second = await begin(attempts);
  await attempts.event("payg","agent",true,true,finish(second,0.1));
  assert.equal(await total(db),-100000,"a genuinely separate provider attempt charges separately");
});

test("missing provider records and rotated keys never finalize an unknown charge as zero", async () => {
  const { db, account, attempts } = await setup();
  const id=await begin(attempts);
  await attempts.event("payg","agent",true,true,{type:"generation",id,generation:"gen-unavailable-fixture"});
  await db.query("update model_attempts set updated_at=0,next_check_at=0");
  await new ModelAttempts(db,account,async()=>new Response(null,{status:404})).reconcile();
  assert.equal((await db.query("select state from model_attempts")).rows[0].state,"pending");
  await db.query("update model_attempts set updated_at=0,next_check_at=0,key_hash=$1",["0".repeat(64)]);
  await new ModelAttempts(db,account,async()=>{throw new Error("must not use a different key");}).reconcile();
  assert.match((await db.query("select last_error from model_attempts")).rows[0].last_error,/Original provider credential is unavailable/);
  assert.equal(await total(db),0);
});

test("tenant-owned OpenRouter usage reconciles with its original key without charging platform credits", async () => {
  const { db } = await testDatabase();
  const tenants = new Tenants({read: async () => JSON.stringify({tenants:{own:{tokenSha256:keyHash,apiKeys:{openrouter:KEY},platformKeys:false}}})});
  await tenants.reload();
  const account = new Accounts({tenants,db});
  const attempts = new ModelAttempts(db,account,async (_url,init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${KEY}`);
    return Response.json({data:{id:"gen-tenant-fixture",total_cost:0.02,generation_time:100,finish_reason:"stop",native_tokens_prompt:10,native_tokens_completion:5}});
  });
  const id=randomUUID();
  await attempts.event("own","agent",false,false,{type:"begin",id,provider:"openrouter",model:"openai/gpt-6-luna",kind:"response",at:Date.now(),keyHash});
  await attempts.event("own","agent",false,false,{type:"generation",id,generation:"gen-tenant-fixture"});
  await db.query("update model_attempts set updated_at=0,next_check_at=0");
  await attempts.reconcile();
  const row=(await db.query("select state,totals,charge from model_attempts")).rows[0];
  assert.equal(row.state,"settled");assert.equal(row.totals.cost,0.02);assert.equal(Number(row.charge),0);
});

test("a late completed delivery upgrades an estimate once without counting a second response", async () => {
  const {db,attempts}=await setup(); const id=await begin(attempts);
  await attempts.event("payg","agent",true,true,{...finish(id,0.2),completed:false});
  await attempts.event("payg","agent",true,true,finish(id,0.1));
  await attempts.event("payg","agent",true,true,finish(id,0.1));
  assert.equal(await total(db),-100000);
  assert.equal((await db.query("select responses from usage")).rows[0].responses,1);
  assert.equal((await db.query("select state from model_attempts")).rows[0].state,"settled");
});

test("HTTP success alone does not finalize a still-running generation", async () => {
  const {db,account,attempts}=await setup(); const id=await begin(attempts);
  await attempts.event("payg","agent",true,true,{type:"generation",id,generation:"gen-running"});
  await db.query("update model_attempts set updated_at=0,next_check_at=0");
  await new ModelAttempts(db,account,async()=>Response.json({data:{id:"gen-running",total_cost:0,generation_time:0,provider_responses:[{status:200}]}})).reconcile();
  const row=(await db.query("select state,last_error from model_attempts")).rows[0];
  assert.equal(row.state,"pending"); assert.match(row.last_error,/terminal evidence/);
});

test("scoped OpenRouter reconciliation selects only a fingerprint-matching key", async () => {
  const {db,account,attempts}=await setup(); const id=await begin(attempts);
  const scopeKey="scope-fixture-only";
  await attempts.event("payg","agent",true,true,{type:"generation",id,generation:"gen-scoped"});
  await db.query("update model_attempts set updated_at=0,next_check_at=0,context=$1,key_hash=$2",[JSON.stringify({keyScope:"customer"}),createHash("sha256").update(scopeKey).digest("hex")]);
  await new ModelAttempts(db,account,async(_url,init)=>{
    assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${scopeKey}`);
    return Response.json({data:{id:"gen-scoped",total_cost:0.01,generation_time:1,finish_reason:"stop"}});
  },0,async(tenant,scope)=>{assert.equal(tenant,"payg");assert.equal(scope,"customer");return scopeKey;}).reconcile();
  assert.equal((await db.query("select state from model_attempts")).rows[0].state,"settled");
});

test("duplicate no-evidence finishes never bill or emit a correction webhook", async () => {
  const {db,attempts}=await setup(); const id=await begin(attempts);
  const empty={type:"finish" as const,id,usage:{},chars:0,completed:true};
  await attempts.event("payg","agent",true,true,empty);
  await attempts.event("payg","agent",true,true,empty);
  const row=(await db.query("select state,revision from model_attempts")).rows[0];
  assert.equal(row.state,"pending");assert.equal(row.revision,0);
});

test("recoverable generations are not crowded out by unsupported provider records", async () => {
  const {db,account,attempts}=await setup();
  for(let i=0;i<25;i++) {
    const id=await begin(attempts);
    await db.query("update model_attempts set updated_at=0,provider='anthropic',next_check_at=0 where id=$1",[id]);
  }
  const id=await begin(attempts);
  await attempts.event("payg","agent",true,true,{type:"generation",id,generation:"gen-priority"});
  await db.query("update model_attempts set updated_at=0,next_check_at=1 where id=$1",[id]);
  await new ModelAttempts(db,account,async()=>Response.json({data:{id:"gen-priority",total_cost:0.01,generation_time:1,finish_reason:"stop"}})).reconcile();
  assert.equal((await db.query("select state from model_attempts where id=$1",[id])).rows[0].state,"settled");
});

test("gateway and empty-key attempts finalize estimates; existing gateway rows stop reconciliation", async () => {
  const { db, account, attempts } = await setup();
  let lookups = 0;
  const worker = new ModelAttempts(db, account, async () => { lookups++; throw new Error("gateway credentials must not reach OpenRouter"); }, 0,
    async () => ({ baseUrl: "https://gateway.example/v1" }));
  for (const legacy of [false, "empty", "gateway"]) {
    const id = randomUUID();
    await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: "anthropic/claude-opus-4.1", kind: "response", at: Date.now(),
      keyHash: legacy === "gateway" ? keyHash : createHash("sha256").update("").digest("hex"), context: { keyScope: "hosted" }, ...(legacy === "gateway" ? { reconciliationDisabled: "Gateway credential has no direct reconciliation" } : {}),
      estimate: { inputTokens: 100, maxOutputTokens: 100, rates: { input: 15, output: 75 } } });
    await attempts.event("payg", "agent", true, true, { type: "generation", id, generation: `gen-gateway-${legacy}` });
    await attempts.event("payg", "agent", true, true, { type: "finish", id, usage: {}, chars: 80, completed: true });
    assert.equal((await db.query("select state from model_attempts where id=$1", [id])).rows[0].state, "settled");
    if (legacy === "gateway") await db.query("update model_attempts set platform=false where id=$1", [id]);
    if (legacy) await db.query("update model_attempts set updated_at=0,state='estimated',context=context-'reconciliationDisabled',next_check_at=0 where id=$1", [id]);
    const before = await total(db);
    await worker.reconcile();
    const row = (await db.query("select state,last_error,checks from model_attempts where id=$1", [id])).rows[0];
    assert.equal(row.state, "settled");
    assert.equal(row.last_error, null);
    assert.equal(await total(db), before, "the existing estimate is preserved");
    await db.query("update model_attempts set updated_at=0,next_check_at=0 where id=$1", [id]);
    await worker.reconcile();
    assert.equal((await db.query("select checks from model_attempts where id=$1", [id])).rows[0].checks, row.checks);
  }
  assert.equal(lookups, 0);
});

test("platform Azure Luna refusals never bill estimated input", async () => {
  const { db, attempts } = await setup();
  const id = randomUUID();
  await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "azure", model: "gpt-6-luna", kind: "response", at: Date.now(), keyHash,
    estimate: { inputTokens: 400_000, maxOutputTokens: 100, rates: { input: 5, output: 20 } } });
  await attempts.event("payg", "agent", true, true, { type: "finish", id, usage: { input: 0, output: 0 }, chars: 0, completed: false });
  assert.equal(await total(db), 0);
  await db.query("update model_attempts set updated_at=0,next_check_at=0 where id=$1", [id]);
  await attempts.reconcile();
  const row = (await db.query("select state,charge,last_error from model_attempts where id=$1", [id])).rows[0];
  assert.equal(row.state, "settled");
  assert.equal(Number(row.charge), 0);
  assert.equal(row.last_error, null);
});

test("a gateway refusal settles at zero and is never polled", async () => {
  const { db, attempts } = await setup();
  const id = randomUUID();
  await attempts.event("payg", "agent", false, false, { type: "begin", id, provider: "openrouter", model: "openai/gpt-6-luna", kind: "response", at: Date.now(), keyHash,
    reconciliationDisabled: "Gateway credential", estimate: { inputTokens: 400_000, maxOutputTokens: 100, rates: { input: 5, output: 20 } } });
  await attempts.event("payg", "agent", false, false, { type: "finish", id, usage: {}, chars: 0, completed: false });
  await db.query("update model_attempts set updated_at=0,next_check_at=0 where id=$1", [id]);
  await attempts.reconcile();
  const row = (await db.query("select state,charge,checks from model_attempts where id=$1", [id])).rows[0];
  assert.equal(row.state, "settled");
  assert.equal(Number(row.charge), 0);
  assert.equal(row.checks, 0);
});

test("reconciliation leaves an in-flight attempt for its real full-usage finish", async () => {
  const { db, account, attempts } = await setup();
  const id = await begin(attempts);
  await attempts.event("payg", "agent", true, true, { type: "generation", id, generation: "gen-inflight" });
  await db.query("update model_attempts set next_check_at=0,updated_at=$2 where id=$1", [id, Date.now() - ATTEMPT_STALE_MS + 60_000]);
  await new ModelAttempts(db, account, async () => { throw new Error("in-flight lookup"); }).reconcile();
  assert.equal((await db.query("select checks from model_attempts where id=$1", [id])).rows[0].checks, 0);
  await attempts.event("payg", "agent", true, true, finish(id, 0.25));
  assert.equal(await total(db), -250000);
});

test("real provider reconciliation can increase an end user's charge after the call", async () => {
  const { EndUserCredits } = await import("../src/end-user-credits.ts");
  const { db, account } = await setup();
  const credits = new EndUserCredits(db);
  await credits.setSettings("payg", { enabled: true, allowances: { default: 1_000_000 } });
  const attempts = new ModelAttempts(db, account, undefined, 0, undefined, credits);
  const id = randomUUID();
  await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: "openai/gpt-6-luna", kind: "response", at: Date.now(), keyHash,
    endUser: { id: "person", bucket: "default" }, estimate: { inputTokens: 100, maxOutputTokens: 100, rates: { input: 5, output: 20 } } });
  await attempts.event("payg", "agent", true, true, { ...finish(id, 0.01), completed: false });
  const before = (await db.query("select end_user_raw from model_attempts where id=$1", [id])).rows[0].end_user_raw;
  await attempts.event("payg", "agent", true, true, { type: "generation", id, generation: "gen-end-user-correction" });
  await db.query("update model_attempts set updated_at=0,next_check_at=0 where id=$1", [id]);
  await new ModelAttempts(db, account, async () => Response.json({ data: {
    id: "gen-end-user-correction", total_cost: 0.2, generation_time: 1, finish_reason: "stop", native_tokens_prompt: 100, native_tokens_completion: 10,
  } }), 0, undefined, credits).reconcile();
  const after = (await db.query("select end_user_raw,charge from model_attempts where id=$1", [id])).rows[0];
  assert.ok(Number(after.end_user_raw) > Number(before));
  assert.equal(Number(after.charge), 211_000, "provider cost plus platform funding");
  assert.equal(Number(after.end_user_raw), Number(after.charge));
});

test("a recorded direct credential is not reclassified when its scope becomes a gateway", async () => {
  const { db, account, attempts } = await setup();
  const id = randomUUID();
  await attempts.event("payg", "agent", false, false, { type: "begin", id, provider: "openrouter", model: "openai/gpt-6-luna", kind: "response", at: Date.now(), keyHash,
    reconciliationEligible: true, context: { keyScope: "changed" } });
  await attempts.event("payg", "agent", false, false, { type: "generation", id, generation: "gen-old-direct" });
  await db.query("update model_attempts set updated_at=0,next_check_at=0 where id=$1", [id]);
  let fetched = false;
  await new ModelAttempts(db, account, async () => {
    fetched = true;
    return Response.json({ data: { id: "gen-old-direct", total_cost: 0.01, generation_time: 1, finish_reason: "stop" } });
  }, 0, async () => ({ baseUrl: "https://gateway.example" })).reconcile();
  assert.equal(fetched, true);
  assert.equal((await db.query("select totals from model_attempts where id=$1", [id])).rows[0].totals.cost, 0.01);
});

test("a stale direct OpenRouter failure without generation or usage settles at zero", async () => {
  const { db, account, attempts } = await setup();
  const id = await begin(attempts);
  await attempts.event("payg", "agent", true, true, { type: "finish", id, usage: {}, chars: 0, completed: false });
  const reconciler = new ModelAttempts(db, account, async () => { throw new Error("must not poll without a generation"); });
  await reconciler.reconcile();
  assert.equal((await db.query("select state from model_attempts where id=$1", [id])).rows[0].state, "pending", "wait for stale cutoff");
  await db.query("update model_attempts set updated_at=0,next_check_at=0 where id=$1", [id]);
  await reconciler.reconcile();
  const row = (await db.query("select state,charge,last_error from model_attempts where id=$1", [id])).rows[0];
  assert.equal(row.state, "settled");
  assert.equal(Number(row.charge), 0);
  assert.equal(row.last_error, null);
  assert.equal(await total(db), 0);
});

test("a served service tier is kept with the attempt in settle's own write: no extra query per call", async () => {
  const { db, account } = await setup();
  let queries = 0;
  const counted = new Proxy(db, { get(target, property) {
    if (property === "query") return async (...args: any[]) => { queries++; return (db.query as any)(...args); };
    if (property !== "connect") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
    return async () => {
      const client = await db.connect();
      return new Proxy(client, { get(target, prop) {
        if (prop !== "query") { const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value; }
        return async (...args: any[]) => { queries++; return (client.query as any)(...args); };
      } });
    };
  } }) as Db;
  const attempts = new ModelAttempts(counted, account);
  const settled = async (usage: Record<string, unknown>) => {
    const id = await begin(attempts);
    queries = 0;
    await attempts.event("payg", "agent", true, true, { ...finish(id, 0.1), usage: { ...finish(id, 0.1).usage, ...usage } });
    return { id, queries };
  };
  const plain = await settled({});
  const tiered = await settled({ serviceTier: "default" });
  const flex = await settled({ serviceTier: "flex", requestedServiceTier: "flex" });
  assert.equal(tiered.queries, plain.queries, "a response that names its tier costs no extra query");
  assert.equal(flex.queries, plain.queries);
  const context = async (id: string) => (await db.query("select context from model_attempts where id=$1", [id])).rows[0].context;
  assert.equal((await context(plain.id)).serviceTier, undefined);
  assert.equal((await context(tiered.id)).serviceTier, "default");
  assert.deepEqual([(await context(flex.id)).serviceTier, (await context(flex.id)).requestedServiceTier], ["flex", "flex"]);
});
