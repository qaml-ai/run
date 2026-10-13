import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { ModelAttempts } from "../src/model-attempts.ts";
import type { Db } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { fixture } from "./client-fixture.ts";
import { until } from "./runtime-server.ts";
import { getModel } from "../src/pi-catalog.ts";
import { createServer } from "node:http";
import { once } from "node:events";

const KEY = "fixture-only";
const keyHash = createHash("sha256").update(KEY).digest("hex");
async function accounts(db: Db, tenant = "payg") {
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
const total = async (db: Db, tenant = "payg") => Number((await db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0]?.balance ?? 0);
const finish = (id: string, cost: number) => ({ type: "finish" as const, id, usage: { input:100,output:10,providerCost:cost,providerCreditCost:0 }, chars:40, completed:true });

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

test("reconciliation survives a lost host, includes BYOK cost, and runs concurrently without double billing", async () => {
  const { db, account, attempts } = await setup();
  const id = await begin(attempts);
  await attempts.event("payg","agent",true,true,{ type:"generation",id,generation:"gen-recovery-fixture" });
  await db.query("update model_attempts set next_check_at=0 where id=$1",[id]);
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"),`Bearer ${KEY}`);
    return Response.json({data:{ id:"gen-recovery-fixture", total_cost:0.01,is_byok:true,upstream_inference_cost:0.2,generation_time:150,provider_responses:[{status:499}],native_tokens_prompt:100,native_tokens_completion:30 }});
  };
  await Promise.all([new ModelAttempts(db,account,fetcher).reconcile(),new ModelAttempts(db,await accounts(db),fetcher).reconcile()]);
  assert.equal(await total(db),-210550); // funding applies only to $0.01 of OpenRouter credits
  await attempts.event("payg","agent",true,true,finish(id,0.001)); // delayed host cannot lower final provider cost
  assert.equal(await total(db),-210550);
  assert.equal((await db.query("select state from model_attempts where id=$1",[id])).rows[0].state,"settled");
});

test("authoritative reconciliation posts only the difference, including a refund; uncertainty stays pending", async () => {
  const { db, attempts } = await setup();
  const id = await begin(attempts);
  await attempts.event("payg","agent",true,true,{...finish(id,0.2),completed:false});
  assert.equal(await total(db),-200000);
  await Promise.all([attempts.settle(id,"payg","agent",{input:100,output:10,providerCost:0.1,providerCreditCost:0},0,true,true),attempts.settle(id,"payg","agent",{input:100,output:10,providerCost:0.1,providerCreditCost:0},0,true,true)]);
  assert.equal(await total(db),-100000);
  const usage=(await db.query("select responses,cost from usage")).rows[0];
  assert.equal(usage.responses,1);assert.ok(Math.abs(usage.cost-0.1)<1e-12);
  const pending = await begin(attempts);
  await attempts.event("payg","agent",true,true,{type:"finish",id:pending,usage:{},chars:0,completed:false});
  await db.query("update model_attempts set next_check_at=0 where id=$1",[pending]);
  await attempts.reconcile();
  const row=(await db.query("select state,last_error from model_attempts where id=$1",[pending])).rows[0];
  assert.equal(row.state,"pending");assert.match(row.last_error,/Awaiting provider evidence/);
  assert.equal(await total(db),-100000);
});

test("deleting a streaming agent preserves its generation and billed output before killing its host", async t => {
  const f = await fixture(t);
  const account = await accounts(f.db,"default");
  const attempts = new ModelAttempts(f.db,account);
  f.sessions.options.apiKeyFor = () => ({key:KEY,platform:true});
  f.sessions.options.catalogPriced = async () => true;
  f.sessions.options.modelAttempt = (...args) => attempts.event(...args);
  f.sessions.options.onUsage = (tenant,agent,message) => account.recordUsage(tenant,agent,message);
  const provider = createServer(async(req,res)=>{
    for await(const _ of req) {}
    assert.equal(Number((await f.db.query("select count(*) n from model_attempts")).rows[0].n),1,"attempt is durable before provider dispatch");
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    res.write(`data: ${JSON.stringify({id:"gen-durable-stream",usage:{prompt_tokens:1000,completion_tokens:2},choices:[{index:0,delta:{role:"assistant",content:"a".repeat(2000)},finish_reason:null}]})}\n\n`);
  });
  provider.listen(0,"127.0.0.1");await once(provider,"listening");
  t.after(async()=>{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));});
  f.setModel({...getModel("openrouter","anthropic/claude-opus-4.1")!,api:"openai-completions",baseUrl:`http://127.0.0.1:${(provider.address() as any).port}/v1`});
  let streamed=false;
  const agent=await f.start({}, {onEvent:event=>{if(event.type==="message_update")streamed=true;}});
  const run=agent.prompt("go").catch(error=>error);
  await until(()=>streamed,"partial output");
  assert.equal((await f.db.query("select generation_id from model_attempts")).rows[0].generation_id,"gen-durable-stream");
  await f.sessions.destroyAgent(agent.session.id,"default");await run;
  const row=(await f.db.query("select * from model_attempts")).rows[0];
  assert.equal(row.state,"estimated");assert.ok(row.totals.output>2);assert.ok(Number(row.charge)>0);
  await account.flushUsage();
  assert.equal((await f.db.query("select responses from usage")).rows[0].responses,1);
  assert.equal(await total(f.db,"default"),-Number(row.charge));
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
  await db.query("update model_attempts set next_check_at=0");
  await new ModelAttempts(db,account,async()=>new Response(null,{status:404})).reconcile();
  assert.equal((await db.query("select state from model_attempts")).rows[0].state,"pending");
  await db.query("update model_attempts set next_check_at=0,key_hash=$1",["0".repeat(64)]);
  await new ModelAttempts(db,account,async()=>{throw new Error("must not use a different key");}).reconcile();
  assert.match((await db.query("select last_error from model_attempts")).rows[0].last_error,/key changed/);
  assert.equal(await total(db),0);
});
