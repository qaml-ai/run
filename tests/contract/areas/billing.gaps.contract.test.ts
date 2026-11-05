import {portedTest} from '../ported.ts';
const test = portedTest("billing", "tests/billing.test.ts");
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {micros} from '../../../src/pricing.ts';
import {signWebhook} from '../../../src/stripe.ts';
import {attachSilently,listen,runtime,toolCall,until} from '../support.ts';

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const PAYG = "payg-operator-token-at-least-24-chars";

const OPS = "ops-operator-token-at-least-24-chars";

const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    ops: { tokenSha256: sha(OPS), apiKeys: { anthropic: "ops-admin-key", openrouter: "ops-admin-key" } },
  },
  platformKeys: { anthropic: "fixture-platform-key", openrouter: "fixture-platform-key" },
};

const DAY = 86_400_000;

const WEBHOOK_SECRET = "whsec_fixture_signing_secret";

async function fakeStripe(t: { after(fn: () => void | Promise<void>): void }) {
  const requests: { path: string; params: URLSearchParams; idempotencyKey?: string; authorization?: string }[] = [];
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    requests.push({ path: req.url!, params, idempotencyKey: req.headers["idempotency-key"] as string | undefined, authorization: req.headers.authorization });
    const count = requests.length;
    const reply = req.url === "/v1/customers" ? { id: `cus_${params.get("metadata[tenant]")}`, livemode: false }
      : req.url === "/v1/checkout/sessions" ? { id: `cs_test_${count}`, url: `https://checkout.stripe.test/c/pay/cs_test_${count}`, status: "open", livemode: false, mode: "payment", currency: "usd", customer: params.get("customer"), client_reference_id: params.get("client_reference_id"), metadata: { order: params.get("metadata[order]") }, amount_total: Number(params.get("line_items[0][price_data][unit_amount]")) + Number(params.get("line_items[1][price_data][unit_amount]")), expires_at: Math.floor(Date.now()/1000)+86400 }
      : undefined;
    res.writeHead(reply ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(reply ?? { error: { message: "No such route" } }));
  });
  return { url, requests };
}

test("credit is bought through Stripe Checkout with the fee on top, added once the webhook reports payment, and refunds take it back", async t => {
  const stripeApi = await fakeStripe(t);
  const { call } = await runtime(t, () => ({ role: "assistant", content: "hi" }), {
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, AGENT_STRIPE_API_URL: stripeApi.url,
  }, tenantsFile);
  const webhook = (event: object, signature?: string) => {
    const payload = JSON.stringify(event);
    return call("/v1/billing/stripe/webhook", { body: event, token: null, headers: { "Stripe-Signature": signature ?? signWebhook(WEBHOOK_SECRET, payload) } });
  };
  assert.equal((await call("/v1/billing", { token: PAYG })).json.checkout, true);
  for (const amountUsd of [4.99, 10.001, 1001, "10"]) assert.equal((await call("/v1/billing/checkout", { body: { amountUsd }, token: PAYG })).status, 400, String(amountUsd));
  assert.equal((await call("/v1/billing/checkout", { body: { amountUsd: 10 }, token: OPS })).status, 400, "unbilled tenants do not buy credit");

  const checkout = await call("/v1/billing/checkout", { body: { amountUsd: 10 }, token: PAYG });
  assert.equal(checkout.status, 201);
  assert.deepEqual(checkout.json, { id: "cs_test_2", url: "https://checkout.stripe.test/c/pay/cs_test_2", amount: 10_000_000, fee: 550_000, total: 10_550_000 });
  const [customer, session] = stripeApi.requests;
  assert.equal(customer.path, "/v1/customers");
  assert.match(customer.idempotencyKey!, /^camelrun:customer:/);
  assert.equal(customer.authorization, "Bearer sk_test_fixture");
  const params = Object.fromEntries(session.params);
  assert.equal(params.mode, "payment");
  assert.equal(params.customer, "cus_payg");
  assert.equal(params.client_reference_id, params["metadata[order]"]);
  assert.equal(params["invoice_creation[enabled]"], "true");
  assert.equal(params["line_items[0][price_data][unit_amount]"], "1000");
  assert.equal(params["line_items[1][price_data][unit_amount]"], "55");
  assert.equal(params["line_items[1][price_data][product_data][name]"], "Processing fee (5.5%)");
  assert.equal(params["metadata[credit]"], "10000000");
  assert.equal(params["payment_intent_data[metadata][tenant]"], "payg");
  assert.equal(params.success_url, "https://agents.example.test/console/billing?checkout=success&session={CHECKOUT_SESSION_ID}");
  // A second checkout reuses the customer.
  await call("/v1/billing/checkout", { body: { amountUsd: 5.5 }, token: PAYG });
  assert.deepEqual(stripeApi.requests.map(request => request.path), ["/v1/customers", "/v1/checkout/sessions", "/v1/checkout/sessions"]);

  const completed = (id: string, extra: object = {}) => ({
    id: `evt_${id}`, type: "checkout.session.completed",
    data: { object: { id, created: 1, livemode: false, mode: "payment", client_reference_id: params["metadata[order]"], object: "checkout.session", payment_status: "paid", payment_intent: `pi_${id}`, customer: "cus_payg", amount_total: 1055, currency: "usd", metadata: { purpose: "agent-runtime-credit", tenant: "payg", credit: "10000000", order: params["metadata[order]"] }, ...extra } },
  });
  const balance = async () => (await call("/v1/billing", { token: PAYG })).json.balance;
  assert.equal((await webhook(completed("cs_test_2"), "t=1,v1=bad")).status, 400);
  assert.equal((await webhook(completed("cs_test_2"), signWebhook("whsec_wrong", JSON.stringify(completed("cs_test_2"))))).status, 400);
  assert.equal(await balance(), 0);
  assert.equal((await webhook(completed("cs_test_2", { payment_status: "unpaid" }))).json.handled, "awaiting payment");
  assert.equal((await webhook(completed("cs_test_2"))).json.handled, "purchase");
  assert.equal((await webhook(completed("cs_test_2"))).status, 200, "Stripe redelivers; it is acknowledged");
  assert.equal((await webhook({ ...completed("cs_test_2"), id: "evt_async", type: "checkout.session.async_payment_succeeded" })).status, 200);
  assert.equal(await balance(), 10_000_000, "credited once, without the fee");
  assert.equal((await call("/v1/billing", { token: PAYG })).json.freeCredit, false);
  // Sessions other products on the same Stripe account created are none of ours.
  assert.equal((await webhook(completed("cs_other", { metadata: { tenant: "payg", credit: "99000000" } }))).json.handled, "ignored");
  assert.equal((await webhook({ id: "evt_x", type: "invoice.paid", data: { object: {} } })).json.handled, "ignored");

  // Refunds are cumulative on the charge: a quarter, a repeat of it, then the rest.
  const refunded = (amountRefunded: number) => ({ id: `evt_r${amountRefunded}`, type: "charge.refunded", data: { object: { id: "ch_1", object: "charge", payment_intent: "pi_cs_test_2", amount: 1055, amount_refunded: amountRefunded } } });
  assert.equal((await webhook(refunded(264))).json.handled, "refund");
  assert.equal((await webhook(refunded(264))).status, 200);
  assert.equal(await balance(), 10_000_000 - Math.round(10_000_000 * 264 / 1055));
  await Promise.all([webhook(refunded(1055)), webhook(refunded(1055))]);
  assert.equal(await balance(), 0);
  assert.equal((await webhook({ ...refunded(1055), data: { object: { ...refunded(1055).data.object, id: "ch_2", payment_intent: "pi_unknown" } } })).json.handled, "pending refund");
  const kinds = (await call("/v1/billing/ledger", { token: PAYG })).json.entries.map((entry: any) => [entry.kind, entry.amount]);
  assert.deepEqual(kinds, [["refund", -(10_000_000 - Math.round(10_000_000 * 264 / 1055))], ["refund", -Math.round(10_000_000 * 264 / 1055)], ["purchase", 10_000_000]]);
  assert.equal((await call("/v1/billing", { token: PAYG })).json.freeCredit, true, "fully refunded: back on free credit");
});

async function fakeGithub(t: { after(fn: () => void | Promise<void>): void }) {
  const accounts = new Map<number, { login: string; createdAt: number }>();
  let missingDates = 0;
  let current = 0;
  const url = await listen(t, async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const path = new URL(req.url!, "http://github.test").pathname;
    const account = accounts.get(Number((req.headers.authorization ?? "").replace("Bearer gho_", "")));
    const reply = path === "/login/oauth/access_token" ? { access_token: `gho_${current}` }
      : path === "/user" && account ? { login: account.login, id: current, ...(missingDates-- > 0 ? {} : { created_at: new Date(account.createdAt).toISOString() }) }
      : undefined;
    res.writeHead(reply ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(reply ?? { message: "Not Found" }));
  });
  return {
    url,
    account(id: number, login: string, ageDays: number) { accounts.set(id, { login, createdAt: Date.now() - ageDays * DAY }); },
    rename(id: number, login: string) { accounts.get(id)!.login = login; },
    omitDates(count: number) { missingDates = count; },
    /** Complete the OAuth dance as account `id`; the session cookie, or the error the console is sent. */
    async signIn(base: string, id: number) {
      current = id;
      const start = await fetch(`${base}/console/auth/github`, { redirect: "manual" });
      const authorize = new URL(start.headers.get("location")!);
      const state = start.headers.get("set-cookie")!.split(";")[0];
      const callback = await fetch(`${base}/console/auth/callback?code=c&state=${authorize.searchParams.get("state")}`, { redirect: "manual", headers: { Cookie: state } });
      const cookie = callback.headers.getSetCookie().find(value => value.startsWith("ar_session="))?.split(";")[0];
      return { authorize, cookie, error: new URL(callback.headers.get("location")!, base).searchParams.get("error") };
    },
  };
}

const githubEnv = (github: string) => ({ GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret", AGENT_GITHUB_WEB_URL: github, AGENT_GITHUB_API_URL: github, AGENT_OPEN_SIGNUP: "true", AGENT_SIGNUP_MIN_ACCOUNT_DAYS: "7" });

const consoleCall = (call: (path: string, init?: any) => Promise<any>, cookie: string) =>
  (path: string, init: { method?: string; body?: unknown } = {}) => call(path, { ...init, token: null, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin" } });

test("open sign-up admits any GitHub account; starting credit is once per account id and uses the configured signup policy; a renamed login keeps its tenant", async t => {
  const github = await fakeGithub(t);
  const stripeApi = await fakeStripe(t);
  const { call, base } = await runtime(t, () => ({ role: "assistant", content: "hi" }), {
    ...githubEnv(github.url), AGENT_VERIFY_KEYS: "false", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, AGENT_STRIPE_API_URL: stripeApi.url,
  }, tenantsFile);
  assert.deepEqual((await call("/console/auth/methods", { token: null })).json, { github: true, google: false, password: true, open: true });

  // Not eligible at signup, but can sign in and buy credit.
  github.account(2001, "Newbie", 5);
  const newbie = await github.signIn(base, 2001);
  assert.equal(newbie.authorize.searchParams.get("scope"), null, "only the public profile");
  assert.equal(newbie.authorize.searchParams.get("allow_signup"), "true");
  const asNewbie = consoleCall(call, newbie.cookie!);
  assert.equal((await asNewbie("/v1/me")).json.tenant, "newbie");
  const newbieBilling = (await asNewbie("/v1/billing")).json;
  assert.deepEqual([newbieBilling.billing, newbieBilling.balance, newbieBilling.freeCredit], ["prepaid", 0, true]);
  assert.deepEqual(newbieBilling.startingCredit, { status: "not_eligible", amount: 0, cardCheck: { amount: 5_000_000 } }, "a young account can still unlock credit with a card check");
  assert.equal((await asNewbie("/v1/providers/anthropic/key", { method: "PUT", body: { apiKey: "sk-ant-newbie-1234" } })).status, 200);
  assert.equal((await asNewbie("/v1/billing/checkout", { body: { amountUsd: 5 } })).status, 201);

  // An old enough account gets $5, once, however often it signs in.
  github.account(3001, "Dave", 400);
  const dave = await github.signIn(base, 3001);
  const asDave = consoleCall(call, dave.cookie!);
  assert.equal((await asDave("/v1/billing")).json.balance, micros(5));
  await github.signIn(base, 3001);
  // Renamed on GitHub: the same account, the same tenant, no second grant.
  github.rename(3001, "David");
  const david = await github.signIn(base, 3001);
  const asDavid = consoleCall(call, david.cookie!);
  assert.deepEqual([(await asDavid("/v1/me")).json.tenant, (await asDavid("/v1/me")).json.login], ["dave", "David"]);
  assert.equal((await asDavid("/v1/billing")).json.balance, micros(5));
  assert.deepEqual((await asDavid("/v1/billing/ledger")).json.entries.map((entry: any) => entry.kind), ["grant"]);
  // Someone else now has the login "Dave": another account, so another tenant and its own grant.
  github.account(4001, "Dave", 90);
  const other = await github.signIn(base, 4001);
  const asOther = consoleCall(call, other.cookie!);
  assert.equal((await asOther("/v1/me")).json.tenant, "dave-4001");
  assert.equal((await asOther("/v1/billing")).json.balance, micros(5));
});

test("signup retries an incomplete profile before creating an account, and does not block an existing login", async t => {
  const github = await fakeGithub(t);
  const { base, call } = await runtime(t, () => ({ role: "assistant", content: "hi" }), githubEnv(github.url), tenantsFile);
  github.account(6001, "ProfileRetry", 100);
  github.omitDates(2);
  const incomplete = await github.signIn(base, 6001);
  assert.equal(incomplete.cookie, undefined);
  assert.match(incomplete.error!, /details are unavailable/);
  // The private pre-signup identity row assertion remains in the source suite.
  github.omitDates(1);
  const retried = await github.signIn(base, 6001);
  assert.ok(retried.cookie);
  assert.deepEqual((await consoleCall(call, retried.cookie!)("/v1/billing")).json.startingCredit, { status: "granted", amount: micros(5) });
  github.omitDates(2);
  assert.ok((await github.signIn(base, 6001)).cookie, "existing account does not require a new eligibility decision");
});

test("only a billing-admin operator can issue the one-time support grant", async t => {
  const github = await fakeGithub(t);
  const { base, call } = await runtime(t, () => ({ role: "assistant", content: "hi" }), {
    ...githubEnv(github.url), AGENT_BILLING_ADMINS: "ops",
  }, tenantsFile);
  github.account(6002, "SupportReview", 1);
  const login = await github.signIn(base, 6002);
  const user = consoleCall(call, login.cookie!);
  const path = "/v1/billing/starting-credit/grant";
  const body = { tenant: "supportreview", amountUsd: 8, reason: "Private review evidence" };
  assert.equal((await user(path, { body })).status, 403);
  assert.equal((await call(path, { body, token: PAYG })).status, 403);
  assert.equal((await call(path, { body, token: null })).status, 401);
  assert.equal((await call(path, { body: { ...body, amountUsd: 0 }, token: OPS })).status, 400);
  for (const amountUsd of [0.99, 100.01, 5.001, "5"]) assert.equal((await call(path, { body: { ...body, amountUsd }, token: OPS })).status, 400);
  assert.equal((await call(path, { body: { tenant: body.tenant, amount: 5, reason: body.reason }, token: OPS })).status, 400, "micro-USD input is no longer accepted");
  const issued = await call(path, { body, token: OPS });
  assert.equal(issued.status, 201, issued.text);
  assert.equal((await call(path, { body, token: OPS })).json.id, issued.json.id);
  assert.equal((await call(path, { body: { ...body, amountUsd: 9 }, token: OPS })).status, 409);
  const summary = (await user("/v1/billing")).json;
  assert.deepEqual(summary.startingCredit, { status: "granted", amount: micros(8) });
  assert.equal(summary.balance, micros(8));
  assert.equal(summary.freeCredit, true, "support credit does not lift purchase-only limits");
  assert.deepEqual((await user("/v1/billing/ledger")).json.entries[0].metadata, { reason: "Starting credit" });
});

test("free credit brings fewer busy agents (its usage tier) and an hourly spend limit, both lifted by the first purchase", async t => {
  const github = await fakeGithub(t);
  const { call, base, model } = await runtime(t, (_body, index) => ({
    ...(index < 2 ? toolCall("codemode", { code: `return ${index}` }, `call_${index}`) : { role: "assistant", content: "finished" }),
    usage: { prompt_tokens: 5000, completion_tokens: 0 },
  }), {
    ...githubEnv(github.url), AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_PRICE_AGENT_HOUR_USD: "0",
    AGENT_USAGE_TIERS: JSON.stringify([{ name: "Free", paidUsd: 0, busyAgents: 2 }, { name: "Paid", paidUsd: 5, busyAgents: 5 }]), AGENT_FREE_HOURLY_SPEND_USD: "0.2", AGENT_MAX_AGENTS_PER_TENANT: "1",
    // The held calls are never answered: shut down without draining them.
    AGENT_DRAIN_TIMEOUT_MS: "0",
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, AGENT_STRIPE_API_URL: "http://127.0.0.1:9",
  }, tenantsFile);
  github.account(5001, "Erin", 365);
  const session = await github.signIn(base, 5001);
  const token = (await consoleCall(call, session.cookie!)("/v1/tokens", { body: { name: "test" } })).json.token;
  assert.equal((await call("/v1/billing", { token })).json.freeCredit, true);

  // Two agents kept busy by calls that are never answered, so neither is idle and can be stopped to make room for a third.
  const hold = { name: "hold", description: "Never answered", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  const busy: { id: string; token: string }[] = [];
  for (const key of ["a", "b"]) {
    const created = await call("/v1/agents", { token, body: { mcp: { tools: [hold] } }, headers: { "Idempotency-Key": key } });
    assert.equal(created.status, 201, created.text);
    busy.push(created.json);
    const app = await attachSilently(t, base, created.json.id, created.json.token);
    assert.equal((await call(`/clients/${created.json.id}/requests`, { token: created.json.token, body: { id: "hold", method: "execute", params: { code: "return await tools.hold({})" } } })).status, 202);
    await until(() => app.calls.length > 0, "the held call to be sent");
  }
  assert.equal((await call("/v1/agents", { body: {}, token, headers: { "Idempotency-Key": "c" } })).status, 429, "two agents at once on free credit");
  assert.deepEqual((await call("/v1/billing", { token })).json.busyAgents, { busy: 2, limit: 2, source: "tier", tier: "Free", paid: 0, next: { tier: "Paid", paid: micros(5), limit: 5 } });
  assert.equal((await call(`/v1/agents/${busy[1].id}`, { method: "DELETE", token })).status, 200);
  const created = await call("/v1/agents", { body: {}, token, headers: { "Idempotency-Key": "c" } });
  assert.equal(created.status, 201, "deleting one makes room");
  const agent = created.json;

  const first = await prompt(call, agent.id, token);
  assert.equal(first.result.stopped, "spend_limit");
  assert.match(first.result.error, /reached its spending limit on free credit: .* of \$0\.20 an hour/);
  assert.equal(model.bodies.length, 2, "the turn ended after the response that reached the hourly limit");
  const limited = await call(`/v1/agents/${agent.id}/prompt`, { body: { text: "again" }, token });
  assert.equal(limited.status, 429);
  assert.match(limited.json.error, /try again later$/);
  assert.doesNotMatch(limited.json.error, /console|buy/i);

  // The first purchase lifts both limits at once.
  const event = { id: "evt_buy", type: "checkout.session.completed", data: { object: { id: "cs_erin", created: 1, livemode: false, payment_status: "paid", payment_intent: "pi_erin", metadata: { purpose: "agent-runtime-credit", tenant: "erin", credit: "5000000" } } } };
  assert.equal((await call("/v1/billing/stripe/webhook", { body: event, token: null, headers: { "Stripe-Signature": signWebhook(WEBHOOK_SECRET, JSON.stringify(event)) } })).status, 200);
  assert.equal((await call("/v1/billing", { token })).json.freeCredit, false);
  assert.deepEqual((await call("/v1/billing", { token })).json.busyAgents, { busy: 1, limit: 5, source: "tier", tier: "Paid", paid: micros(5) });
  assert.equal((await prompt(call, agent.id, token)).result.reply, "finished");
  assert.equal((await call("/v1/agents", { body: {}, token, headers: { "Idempotency-Key": "d" } })).status, 201, "a third agent while the other two are busy");
});

async function prompt(call: (path: string, init?: any) => Promise<any>, agent: string, token: string) {
  const accepted = await call(`/v1/agents/${agent}/prompt`, { body: { text: "go" }, token });
  assert.equal(accepted.status, 202, accepted.text);
  return (await until(async () => {
    const record = (await call(`/v1/agents/${agent}/requests/${accepted.json.id}`, { token })).json;
    return record.state === "completed" && record;
  }, "the turn to end")).outcome;
}

test("disabled card credit is absent from billing and its start endpoint refuses while GitHub grants remain", async t => {
  const github = await fakeGithub(t);
  const stripeApi = await fakeStripe(t);
  const { call, base } = await runtime(t, () => ({ role: "assistant", content: "hi" }), {
    ...githubEnv(github.url), AGENT_CARD_CREDIT_USD: "0", AGENT_VERIFY_KEYS: "false",
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, AGENT_STRIPE_API_URL: stripeApi.url,
  }, tenantsFile);
  github.account(2091, "NoCardCredit", 1);
  const newcomer = await github.signIn(base, 2091);
  const asNewcomer = consoleCall(call, newcomer.cookie!);
  assert.deepEqual((await asNewcomer("/v1/billing")).json.startingCredit, { status: "not_eligible", amount: 0 });
  const refused = await asNewcomer("/v1/billing/card-check", { body: {} });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "CARD_CREDIT_UNAVAILABLE");
  assert.equal(refused.json.error, "Free credit for verifying a card is not offered; add credit to start");
  assert.equal(stripeApi.requests.length, 0, "disabled card checks never contact Stripe");
  github.account(2092, "GitHubCredit", 400);
  const veteran = await github.signIn(base, 2092);
  assert.deepEqual((await consoleCall(call, veteran.cookie!)("/v1/billing")).json.startingCredit, { status: "granted", amount: micros(5) });
});
