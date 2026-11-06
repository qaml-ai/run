import {portedTest} from "../ported.ts";
const test=portedTest("accounts","tests/account.test.ts");
import assert from "node:assert/strict";
import {unzip} from "../../unzip.ts";
import {listen,OPERATOR,OTHER_OPERATOR,passwordSession,runtime,until,type T} from "../support.ts";

async function fakeStripe(t: T) {
  const calls: string[] = [];
  const url = await listen(t, (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/v1/customers/cus_gone") return void res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { code: "resource_missing", message: "No such customer" } }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "x", deleted: true }));
  });
  return { url, calls };
}

async function fakeGithub(t:T) {
  return listen(t, async (req,res)=>{
    for await (const _ of req) { /* drain */ }
    const path = new URL(req.url!,"http://github.test").pathname;
    const value = path === "/login/oauth/access_token" ? {access_token:"gho_carol"}
      : path === "/user" ? {login:"carol",id:4242,created_at:"2015-01-01T00:00:00Z"}
      : path === "/user/memberships/orgs/qaml-ai" ? {state:"active"} : undefined;
    res.writeHead(value?200:404,{"Content-Type":"application/json"}).end(JSON.stringify(value??{}));
  });
}

test("an account exports everything it stores, then deletes it all but the ledger, and its identity signs up afresh without new credit", { timeout: 120_000 }, async t => {
  const stripe = await fakeStripe(t);
  const github = await fakeGithub(t);
  const ses = await listen(t, async (req, res) => { for await (const _ of req) { /* drain */ } res.writeHead(200, {"Content-Type":"application/json"}).end(JSON.stringify({MessageId:"fixture"})); });
  const r = await runtime(t, () => ({ role: "assistant", content: "Noted: the launch code is 4321." }), {
    AGENT_VERIFY_KEYS: "false", AGENT_BILLING_ADMINS: "alice", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture", AGENT_STRIPE_API_URL: stripe.url,
    AGENT_PURGE_INTERVAL_MS: "1000", AGENT_CREDIT_GRANT_USD: "5",
    GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret", GITHUB_ORG: "qaml-ai", AGENT_GITHUB_WEB_URL: github, AGENT_GITHUB_API_URL: github, AGENT_SIGNUP_MIN_ACCOUNT_DAYS: "0",
    AGENT_BILLING_EMAIL_FROM: "billing@example.test", AGENT_BILLING_EMAIL_CONFIGURATION_SET: "billing", AGENT_BILLING_EMAIL_SNS_TOPICS: "arn:aws:sns:us-west-2:123456789012:billing",
    AWS_REGION:"us-west-2", AWS_ACCESS_KEY_ID:"fixture", AWS_SECRET_ACCESS_KEY:"fixture", AWS_ENDPOINT_URL_SESV2:ses,
  });
  // Public GitHub sign-in creates the same identity and starting credit as the source's Accounts setup.
  const signIn = async () => {
    const start = await r.call("/console/auth/github", { token: null });
    const authorize = new URL(start.headers.get("location")!);
    const cookies = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const callback = await r.call(`/console/auth/callback?code=abc&state=${authorize.searchParams.get("state")}`, { token: null, headers: {Cookie:cookies} });
    assert.equal(callback.status, 302);
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith("ar_session="))?.split(";")[0];
    assert.ok(cookie, callback.headers.get("location") ?? "missing session");
    return cookie;
  };
  const initialSession = await signIn();
  const sessionHeaders = (cookie:string) => ({Cookie:cookie,"X-Agent-Runtime-Console":"1","Sec-Fetch-Site":"same-origin"});
  const tenant = (await r.call("/v1/me", {token:null,headers:sessionHeaders(initialSession)})).json.tenant;
  assert.equal(tenant, "carol");
  const token = (await r.call("/v1/tokens", {token:null,headers:sessionHeaders(initialSession),body:{name:"script"}})).json.token;
  const as = (path: string, init: Parameters<typeof r.call>[1] = {}) => r.call(path, { ...init, token });
  assert.equal((await as("/v1/providers/openrouter/key", { method: "PUT", body: { apiKey: "sk-or-carol-own-key" } })).status, 200);

  // An agent with a history and a schedule, a volume with a file, a definition, a webhook, and a Stripe customer.
  const agent = (await as("/v1/agents", { body: { name: "diary" }, headers: { "Idempotency-Key": "diary" } })).json.id;
  await r.prompt(agent, "Remember the launch code 4321", token);
  assert.equal((await as(`/v1/agents/${agent}/schedules`, { body: { text: "check in", inSeconds: 3600 } })).status, 201);
  const volume = (await as("/v1/volumes", { body: { name: "notes" } })).json.id;
  const put = await fetch(`${r.base}/v1/volumes/${volume}/files/plans/secret.txt`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" }, body: "the secret plan" });
  assert.equal(put.status, 201);
  const definition = await as("/v1/definitions", { body: { name: "helper", systemPrompt: "Be brief" } });
  assert.equal(definition.status, 201);
  assert.equal((await as("/v1/webhooks", { body: { url: "https://hooks.example.com/runs", events: ["run.completed"] } })).status, 201);
  await r.seedStripeCustomer(tenant, {customer:"cus_carol",legacyCustomer:"cus_gone"});
  assert.equal((await as("/v1/billing/alerts/recipients", {body:{email:"carol@example.com"}})).status, 201);

  // Managed Discord metadata belongs to the deliberately out-of-scope channels contract.
  // The export: a zip of all of it, streamed.
  const exported = await fetch(`${r.base}/v1/account/export`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("content-type"), "application/zip");
  assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="camelrun-carol-\d{4}-\d{2}-\d{2}\.zip"$/);
  const files = unzip(Buffer.from(await exported.arrayBuffer()));
  const text = (name: string) => { const file = files.get(name); assert.ok(file, `${name} in ${[...files.keys()].join(", ")}`); return file.toString("utf8"); };
  assert.deepEqual(JSON.parse(text("account.json")).tenant, "carol");
  const config = JSON.parse(text(`agents/${agent}/agent.json`));
  assert.equal(config.name, "diary");
  assert.equal(config.schedules[0].text, "check in");
  const history = [...files].filter(([name]) => name.startsWith(`agents/${agent}/history/`)).map(([, data]) => data.toString()).join("");
  assert.match(history, /Remember the launch code 4321/);
  assert.match(history, /the launch code is 4321/);
  assert.equal(text(`volumes/${volume}/files/plans/secret.txt`), "the secret plan");
  assert.equal(JSON.parse(text("definitions.json"))[0].name, "helper");
  assert.equal(JSON.parse(text("webhooks.json"))[0].url, "https://hooks.example.com/runs");
  assert.match(text("billing/ledger.jsonl"), /"kind":"grant"/);
  const attempts = text("billing/attempts.jsonl").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.ok(attempts.length > 0);
  assert.ok(attempts.every(attempt => !Object.hasOwn(attempt, "key_hash") && !Object.hasOwn(attempt, "prepaid")));
  assert.ok(!files.has("keys.json") || !text("keys.json").includes("sk-or-carol-own-key"), "keys never leave");
  assert.ok(!text("tokens.json").includes(token), "tokens never leave");
  // Deletion is the console's, signed in, with the account named; admin tenants and other operators cannot.
  assert.equal((await as("/v1/account", { method: "DELETE", body: { confirm: tenant } })).status, 403, "not with an API token");
  const asSession = (cookie: string) => (path: string, init: { method?: string; body?: unknown } = {}) => r.call(path, { ...init, token: null, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin" } });
  // An API token cannot give its account a password, which would make it a person's console session; the platform operator can.
  assert.equal((await as("/v1/tenants/carol/password", { method: "PUT", body: { email: "carol@example.com", password: "carol-password-1234" } })).status, 403);
  const byPassword = asSession(await passwordSession(r.base, OPERATOR, tenant, "carol@example.com"));
  assert.equal((await byPassword("/v1/me")).json.signIn, "password");
  // Sign in through the same public callback used by a browser.
  const console_ = asSession(await signIn());
  assert.equal((await console_("/v1/account", { method: "DELETE", body: { confirm: "someone-else" } })).status, 400);
  assert.equal((await r.call("/v1/tenants/bob", { method: "DELETE" })).status, 403, "an admin tenant is never deleted");
  assert.equal((await r.call("/v1/tenants/carol", { method: "DELETE", token: OTHER_OPERATOR })).status, 403, "only the platform operator deletes others");
  const deleting = await console_("/v1/account", { method: "DELETE", body: { confirm: tenant } });
  assert.equal(deleting.status, 202);
  assert.equal(deleting.json.state, "deleting");
  // At once: nothing authenticates as the account any more.
  assert.equal((await as("/v1/me")).status, 401);
  assert.equal((await console_("/v1/me")).status, 401);
  assert.equal((await byPassword("/v1/me")).status, 401);

  const done = await until(async () => { const status = await r.call("/v1/tenants/carol/deletion", { token: OPERATOR }); return status.json.state === "deleted" && status.json; }, "the deletion to finish", 60_000);
  assert.ok(done.completedAt >= done.requestedAt);
  assert.deepEqual(stripe.calls.filter(call => call.startsWith("DELETE")).sort(), ["DELETE /v1/customers/cus_carol", "DELETE /v1/customers/cus_gone"]);

  // Private row, storage and tombstone checks remain in tests/account.test.ts.
  // Revoked API, password and GitHub sessions above are the public deletion boundary.
  // The same GitHub account signs up again: a new, empty tenant under a new id, with no second starting credit.
  const againSession = await signIn();
  const again = (await r.call("/v1/me", {token:null,headers:sessionHeaders(againSession)})).json.tenant;
  assert.notEqual(again, tenant);
  assert.equal((await r.call("/v1/billing/ledger", {token:null,headers:sessionHeaders(againSession)})).json.entries.length, 0);
  // A repeated request only reports the deletion.
  assert.equal((await r.call("/v1/tenants/carol", { method: "DELETE", token: OPERATOR })).json.state, "deleted");
});
