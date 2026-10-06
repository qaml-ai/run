import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { listen, runtime, until, type T } from "./runtime-server.ts";
import { unzip } from "./unzip.ts";

const SECRET = `whsec_${Buffer.from("journey-server-test-key-0123456789").toString("base64")}`;
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const HANDOFF = "0c7d0a52-3f0e-4a55-8a0d-7f7a7a1b2c3d";

/** A console build with only its shell, and a store that takes whatever it is sent. */
async function fixture(t: T, journey: boolean, env: Record<string, string> = {}) {
  const consoleDir = mkdtempSync(join(tmpdir(), "journey-console-"));
  writeFileSync(join(consoleDir, "index.html"), "<!doctype html><html><head><title>Console</title></head><body><div id=\"root\"></div></body></html>");
  const events: any[] = [], touches: any[] = [];
  const store = await listen(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/marketing-attribution/resolve") { touches.push(body); return void res.end(JSON.stringify({ attribution_id: body.attribution_id })); }
      if (req.url === "/api/journey/consent-controls") return void res.end(JSON.stringify({ accepted: [body.control_id], duplicates: [] }));
      // The account's export: what this store was sent of it, in one page, with what it would copy to Google of each.
      if (req.url === "/api/journey/account-export") {
        const records = body.kind === "events" ? events.filter(event => event.account_ref === body.account_ref) : [];
        return void res.end(JSON.stringify({ schema_version: 1, kind: body.kind, status: "ok", account: { account_ref: body.account_ref, capture_quality: "complete" }, consent: { last_refused_at: "2026-10-01T00:00:00.000Z" },
          events: body.kind === "events" ? records : [], touches: [], ga4_copies: records.map(event => ({ event_id: event.event_id, status: "skipped_unmapped", prepared_at: null, payload: null })), next_cursor: null }));
      }
      events.push(...body.events);
      res.end(JSON.stringify({ accepted: body.events.map((event: any) => event.event_id), duplicates: [] }));
    });
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), {
    AGENT_CONSOLE_DIR: consoleDir, ...env,
    ...(journey ? { AGENT_JOURNEY_URL: store, AGENT_JOURNEY_SECRET: SECRET, AGENT_JOURNEY_VISITOR_COOKIE: "camel_attribution_id", AGENT_JOURNEY_VISITOR_COOKIE_DOMAIN: "example.test", AGENT_JOURNEY_CONSENT_COOKIE: "camel_consent", AGENT_JOURNEY_RETRY_MS: "100" } : {}),
  });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${r.base}${path}`, { redirect: "manual", headers: { "user-agent": CHROME, "sec-fetch-dest": "document", ...headers } });
  return { r, events, touches, get };
}

test("a runtime with journey events off serves the console as ever: no tag, no cookie, no endpoint", async t => {
  const { r, get } = await fixture(t, false);
  const page = await get("/console/", { cookie: "camel_consent=granted", referer: "https://github.com/qaml-ai/run" });
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes("agent-runtime-journey"));
  assert.equal(page.headers.get("set-cookie"), null);
  const post = await fetch(`${r.base}/api/journey/events`, { method: "POST", headers: { "content-type": "application/json", "x-agent-runtime-console": "1", origin: "https://agents.example.test" }, body: "{}" });
  assert.equal(post.status, 404);
  for (const table of ["journey_outbox", "journey_accounts", "journey_state"]) assert.equal((await r.db.query(`select 1 from ${table}`)).rowCount, 0, table);
});

test("with journey events on, an arrival is noted through the redirect, the browser gets its visitor id, and the console's pages reach the store", async t => {
  const { r, events, touches, get } = await fixture(t, true);
  // The link from the operator's site: /console, with what says where the visitor came from. The redirect keeps it.
  const redirect = await get(`/console?camel_handoff=${HANDOFF}&utm_source=newsletter`, { cookie: "camel_consent=granted", referer: "https://example.test/run" });
  assert.deepEqual([redirect.status, redirect.headers.get("location")], [302, `/console/?camel_handoff=${HANDOFF}&utm_source=newsletter`]);
  const page = await get(redirect.headers.get("location")!, { cookie: "camel_consent=granted", referer: "https://example.test/run" });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('<meta name="agent-runtime-journey" content="1"></head>'));
  const visitor = /^camel_attribution_id=([0-9a-f-]{36}); Domain=example\.test; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$/.exec(page.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(visitor, page.headers.get("set-cookie") ?? "no cookie");

  // The console, in that browser, says which page it is on.
  const view = { event_id: crypto.randomUUID(), name: "page_viewed", occurred_at: new Date().toISOString(), page_path: "/console/agents/client_0123456789abcdef", referrer_host: null };
  const post = await fetch(`${r.base}/api/journey/events`, {
    method: "POST", headers: { "content-type": "application/json", "x-agent-runtime-console": "1", origin: "https://agents.example.test", cookie: `camel_consent=granted; camel_attribution_id=${visitor}` },
    body: JSON.stringify({ schema_version: 1, events: [view] }),
  });
  assert.deepEqual([post.status, await post.json()], [200, { accepted: [view.event_id], rejected: [] }]);

  await until(() => events.length >= 2 && touches.length >= 1, "the store to be sent the arrival, its touch and the page");
  assert.deepEqual(events.map(event => [event.name, event.visitor_id, event.page_host, event.page_path, event.properties]).sort(), [
    ["page_viewed", visitor, "agents.example.test", "/console/agents/:agent_id", { page_type: "console", product_context: "run" }],
    ["run_arrived", visitor, null, null, { entry_channel: "sales_site_link", landing_path: "/console", handoff_id: HANDOFF }],
  ]);
  assert.deepEqual(touches.map(touch => [touch.attribution_id, touch.touch.page_host, touch.touch.page_path, touch.touch.campaign]), [[visitor, "agents.example.test", "/console", { utm_source: "newsletter" }]]);
  await until(async () => (await r.db.query("select 1 from journey_outbox")).rowCount === 0, "the outbox to empty");

  // An asset is not a page, and a browser that has not agreed is left alone.
  assert.equal((await get("/console/", { referer: "https://github.com/qaml-ai/run" })).headers.get("set-cookie"), null);
});

test("with journey events on, making an agent and running it tells the store of the agent, the day's activity and the account's first run", { timeout: 120_000 }, async t => {
  const { r, events } = await fixture(t, true);
  // Carol signed up with GitHub while journey events were on, from a browser that agreed.
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db: r.db, pricing: { startingGrant: 5_000_000 } as never });
  const tenant = await accounts.tenantForGithub({ login: "carol", id: 4242, createdAt: Date.now() - 365 * 86_400_000 }, { minAccountAgeMs: 0 });
  const accountRef = crypto.randomUUID();
  await r.db.query("insert into journey_accounts (tenant, account_ref, since_signup, consent, created_at) values ($1, $2, true, 'granted', $3)", [tenant, accountRef, Date.now()]);
  const { token } = await accounts.createToken(tenant, "script");
  const as = (path: string, init: Parameters<typeof r.call>[1] = {}) => r.call(path, { ...init, token });
  assert.equal((await as("/v1/providers/openrouter/key", { method: "PUT", body: { apiKey: "sk-or-carol-own-key" } })).status, 200);

  const made = await as("/v1/agents", { body: { name: "diary" }, headers: { "Idempotency-Key": "diary" } });
  assert.equal(made.status, 201);
  // The same key again is the same agent, reconfigured: no second event.
  assert.equal((await as("/v1/agents", { body: { name: "diary" }, headers: { "Idempotency-Key": "diary" } })).status, 201);
  await r.prompt(made.json.id, "Say ok", token);
  await r.prompt(made.json.id, "Say ok again", token);

  const mine = () => events.filter(event => event.account_ref === accountRef);
  await until(() => mine().length >= 3, "the agent, the day and the first run to reach the store");
  await new Promise(resolve => setTimeout(resolve, 600));
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(mine().map(event => [event.name, event.visitor_id, event.analytics_consent, event.is_internal]).sort(), [
    ["run_active_day", null, "granted", false], ["run_agent_created", null, "granted", false], ["run_first_execution_completed", null, "granted", false],
  ]);
  const byName = Object.fromEntries(mine().map(event => [event.name, event.properties]));
  assert.deepEqual(byName.run_agent_created, { is_first: true, created_via: "api" });
  assert.deepEqual(byName.run_active_day, { activity_date: today });
  assert.ok(Number.isSafeInteger(byName.run_first_execution_completed.seconds_since_signup) && byName.run_first_execution_completed.seconds_since_signup >= 0);
  assert.ok(!JSON.stringify(mine()).includes("carol") && !JSON.stringify(mine()).includes(made.json.id));
});

test("an account's export holds its journey: what this runtime kept and what the store holds; an account journey never knew has none", { timeout: 120_000 }, async t => {
  const { r, events } = await fixture(t, true);
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db: r.db, pricing: { startingGrant: 0 } as never });
  const tenant = await accounts.tenantForGithub({ login: "carol", id: 4242, createdAt: Date.now() - 365 * 86_400_000 }, { minAccountAgeMs: 0 });
  const accountRef = crypto.randomUUID();
  await r.db.query("insert into journey_accounts (tenant, account_ref, since_signup, consent, created_at) values ($1, $2, true, 'granted', $3)", [tenant, accountRef, Date.now()]);
  const { token } = await accounts.createToken(tenant, "script");
  // Minting a token through the API is an event; the store has it before the export asks.
  assert.equal((await r.call("/v1/tokens", { token, body: { name: "another" } })).status, 201);
  await until(() => events.some(event => event.account_ref === accountRef && event.name === "run_token_created"), "the token's event to reach the store");

  const exported = await fetch(`${r.base}/v1/account/export`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(exported.status, 200);
  const files = unzip(Buffer.from(await exported.arrayBuffer()));
  const read = (name: string) => JSON.parse(files.get(name)!.toString("utf8"));
  const kept = read("analytics/account.json");
  assert.deepEqual([kept.accountRef, kept.consent, kept.seenSinceSignup, kept.milestones.map((milestone: { name: string }) => milestone.name)], [accountRef, "granted", true, ["run_token_created"]]);
  assert.deepEqual(read("analytics/summary.json"), { status: "ok", account: { account_ref: accountRef, capture_quality: "complete" }, consent: { last_refused_at: "2026-10-01T00:00:00.000Z" } });
  assert.deepEqual(read("analytics/google-copies-00001.json").map((copy: { status: string; payload: unknown }) => [copy.status, copy.payload]), [["skipped_unmapped", null]]);
  assert.deepEqual(read("analytics/events-00001.json").map((event: { name: string; properties: unknown }) => [event.name, event.properties]), [["run_token_created", { is_first: true }]]);
  assert.ok(files.get("README.txt")!.toString("utf8").includes("analytics/account.json"));

  // Another account, which journey never knew: its export is as it ever was.
  const other = await accounts.tenantForGithub({ login: "dave", id: 4243, createdAt: Date.now() - 365 * 86_400_000 }, { minAccountAgeMs: 0 });
  const plain = unzip(Buffer.from(await (await fetch(`${r.base}/v1/account/export`, { headers: { Authorization: `Bearer ${(await accounts.createToken(other, "script")).token}` } })).arrayBuffer()));
  assert.ok(![...plain.keys()].some(name => name.startsWith("analytics/")));
});

test("an email sign-up is an account made when its mailed link is finished, in the browser that finishes it", { timeout: 120_000 }, async t => {
  const mails: string[] = [];
  // A stand-in for Amazon SES that keeps each message's text.
  const ses = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST" || req.url !== "/v2/email/outbound-emails") return void res.writeHead(404).end();
    mails.push(JSON.parse(text).Content.Simple.Body.Text.Data);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ MessageId: `m-${mails.length}` }));
  });
  const { r, events } = await fixture(t, true, {
    AGENT_ACCOUNT_EMAIL_FROM: "accounts@mail.example.test", AGENT_ACCOUNT_EMAIL_CONFIGURATION_SET: "camelai-agent-runtime-mail", AGENT_OPEN_SIGNUP: "true",
    AWS_ENDPOINT_URL_SESV2: ses, AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "fixture-access-key", AWS_SECRET_ACCESS_KEY: "fixture-secret-key",
  });
  const visitor = "3f2b8a6e-1c4d-4e5f-8a9b-0c1d2e3f4a5b", password = "a long and unusual passphrase";
  const post = (path: string, body: unknown) => fetch(r.base + path, { method: "POST", redirect: "manual", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin", cookie: `camel_consent=granted; camel_attribution_id=${visitor}` } });
  assert.equal((await post("/console/auth/signup", { email: "ada@elsewhere.test", password })).status, 202);
  await until(() => mails.length >= 1, "the sign-up's mail");
  // Asking for the link is the start of a sign-in, and no account yet.
  assert.equal((await r.db.query("select 1 from journey_accounts")).rowCount, 0);
  const token = /\/console\/verify#([A-Za-z0-9_-]{43})/.exec(mails[0]!)![1];
  const verified = await post("/console/auth/verify", { token, password });
  assert.equal(verified.status, 200);
  await until(() => events.some(event => event.name === "run_account_created"), "the sign-up to reach the store");
  const accountRef = (await r.db.query("select account_ref, signup_visitor, since_signup, consent from journey_accounts")).rows[0];
  assert.deepEqual([accountRef.signup_visitor, accountRef.since_signup, accountRef.consent], [visitor, true, "granted"]);
  assert.deepEqual(events.filter(event => event.name.startsWith("run_")).map(event => [event.name, event.visitor_id, event.account_ref, event.properties]).sort(), [
    ["run_account_created", visitor, accountRef.account_ref, { method: "password", auth_surface: "console" }],
    ["run_auth_started", visitor, null, { method: "password", auth_surface: "console" }],
  ]);
  // The address is in no event.
  assert.ok(!JSON.stringify(events).includes("ada") && !JSON.stringify(events).includes("elsewhere"));
});
