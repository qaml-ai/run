import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startFixture } from "./fixture.ts";

test("account route corrections hold through workerd authentication and routing", { timeout: 120_000 }, async t => {
  const origin = "https://runtime.example.test";
  const r = await startFixture({ vars: { AGENT_PUBLIC_URL: origin } });
  t.after(() => r.stop());
  const call = async (path: string, method = "GET", body?: unknown, token = r.token) => {
    const response = await fetch(r.url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  };
  await t.test("OAuth metadata is public and points to the configured canonical origin", async () => {
    const response = await call("/.well-known/oauth-authorization-server", "GET", undefined, "unused");
    assert.equal(response.status, 200);
    assert.equal(response.json.issuer, origin);
    assert.equal(response.json.authorization_endpoint, origin + "/oauth/authorize");
    assert.equal(response.json.token_endpoint, origin + "/oauth/token");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
  await t.test("OAuth may list providers but cannot mint a persistent token", async () => {
    const token = `aro_${"a".repeat(43)}`, id = "oauth-route-fixture";
    await r.db.query("insert into oauth_grants(id,tenant,client_id,client_name,scope,created_at) values ($1,'camelrun-proto-local','fixture-client','Fixture','agents',$2)", [id, Date.now()]);
    await r.db.query("insert into oauth_tokens(sha256,kind,grant_id,expires_at) values ($1,'access',$2,$3)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 60_000]);
    assert.equal((await call("/v1/providers", "GET", undefined, token)).status, 200);
    assert.equal((await call("/v1/tokens", "POST", { name: "forbidden" }, token)).status, 403);
  });
  await t.test("API token cannot revoke itself; another credential revokes it and names its retained webhooks", async () => {
    const created = await call("/v1/tokens", "POST", { name: "route fixture" });
    assert.equal(created.status, 201);
    const token = created.json;
    assert.equal((await call(`/v1/tokens/${token.id}`, "DELETE", undefined, token.token)).status, 400);
    const endpoint = await call("/v1/webhooks", "POST", { url: "http://127.0.0.1:9/no-network", events: ["run.completed"] }, token.token);
    assert.equal(endpoint.status, 201);
    const revoked = await call(`/v1/tokens/${token.id}`, "DELETE");
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.json, { revoked: true, left: [{ kind: "webhook", id: endpoint.json.id, url: "http://127.0.0.1:9/no-network" }] });
    assert.equal((await call(`/v1/tokens/${token.id}`, "DELETE")).status, 404);
    assert.equal((await call("/v1/providers", "GET", undefined, token.token)).status, 401);
  });
});

test("deleting an account removes agent spend limits and keeps its credit ledger", { timeout: 120_000 }, async t => {
  const operator = "account-purge-operator-token-at-least-32-characters";
  const r = await startFixture({ vars: {
    AGENT_TENANTS_JSON: JSON.stringify({ tenants: { ops: { tokenSha256: createHash("sha256").update(operator).digest("hex"), apiKeys: {} } } }),
    AGENT_BILLING_ADMINS: "ops",
  } });
  t.after(() => r.stop());
  const tenant = "camelrun-proto-local";
  const call = async (path: string, method = "GET", body?: unknown, token = r.token) => {
    const response = await fetch(r.url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as any };
  };
  const created = await call("/v1/agents", "POST", { model: "test/echo", spendLimit: { usd: 3 } });
  assert.equal(created.status, 201);
  const id = created.json.id;
  await r.db.query("update agent_spend_limits set spent=1.25 where agent=$1", [id]);
  assert.equal((await r.db.query("select count(*)::int n from agent_spend_limits where agent=$1", [id])).rows[0].n, 1);
  const ledger = (await r.db.query("select * from credit_ledger where tenant=$1 order by id", [tenant])).rows;
  const balance = (await r.db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0].balance;
  assert.ok(ledger.length > 0);
  const accountRef = crypto.randomUUID(), visitor = crypto.randomUUID(), now = Date.now();
  await r.db.query("insert into journey_accounts(tenant,account_ref,signup_visitor,since_signup,consent,created_at) values($1,$2,$3,true,'granted',$4)", [tenant, accountRef, visitor, now]);
  await r.db.query("insert into journey_milestones(account_ref,name,at) values($1,'run_token_created',$2)", [accountRef, now]);
  await r.db.query("insert into journey_lost_signups(tenant,consent,visitor,method,surface,at) values($1,'granted',$2,'password','console',$3)", [tenant, visitor, now]);
  await r.db.query("insert into journey_outbox(id,account_ref,body,due,created_at) values($1,$2,$3,$4,$4)", [crypto.randomUUID(), accountRef, { name: "run_token_created", visitor_id: visitor }, now]);

  // Directory marks the agent revoked before shutdown. A cold DO must still
  // reopen its harness and read the owned spend counter to finish that shutdown.
  await r.worker.stop(true);
  await r.worker.start();
  assert.equal((await call(`/v1/tenants/${tenant}`, "DELETE", undefined, operator)).status, 202);
  let deleted = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await call(`/v1/tenants/${tenant}/deletion`, "GET", undefined, operator);
    assert.equal(status.status, 200);
    if (status.json.state === "deleted") { deleted = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(deleted, "account cleanup completes");
  assert.equal((await r.db.query("select count(*)::int n from agent_spend_limits where agent=$1", [id])).rows[0].n, 0);
  assert.deepEqual((await r.db.query("select * from credit_ledger where tenant=$1 order by id", [tenant])).rows, ledger);
  assert.equal((await r.db.query("select balance from credit_accounts where tenant=$1", [tenant])).rows[0].balance, balance);
  assert.equal((await r.db.query("select count(*)::int n from journey_accounts where tenant=$1", [tenant])).rows[0].n, 0);
  assert.equal((await r.db.query("select count(*)::int n from journey_lost_signups where tenant=$1", [tenant])).rows[0].n, 0);
  assert.equal((await r.db.query("select count(*)::int n from journey_milestones where account_ref=$1", [accountRef])).rows[0].n, 0);
  const events = (await r.db.query("select body from journey_outbox where account_ref=$1", [accountRef])).rows;
  assert.equal(events.length, 1, "only the anonymous deletion notification remains while Journey is off");
  assert.equal(events[0].body.name, "run_account_deleted");
  assert.equal(events[0].body.account_ref, accountRef);
  assert.equal(events[0].body.visitor_id, null);
  assert.ok(!JSON.stringify(events[0].body).includes(tenant));
  assert.ok(!JSON.stringify(events[0].body).includes(visitor));
  assert.equal((await call(`/v1/tenants/${tenant}`, "DELETE", undefined, operator)).status, 202, "repeated deletion remains idempotent");
  assert.deepEqual((await r.db.query("select * from credit_ledger where tenant=$1 order by id", [tenant])).rows, ledger);
  assert.deepEqual((await r.db.query("select body from journey_outbox where account_ref=$1", [accountRef])).rows, events);
});
