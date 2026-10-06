import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { transaction } from "../src/db.ts";
import { clientAddress, clientKey, loopback, RateLimited, RateLimits, rateLimitConfig, rateLimitHeaders, type RateLimitConfig } from "../src/rate-limits.ts";
import { errorHeaders } from "../src/http.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { OPERATOR, OTHER_OPERATOR, runtime, until } from "./runtime-server.ts";
import { cluster, token as clusterToken } from "./cluster-helpers.ts";

const headers = (values: Record<string, string>) => (name: string) => values[name];
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("the client's address: CF-Connecting-IP only when Cloudflare is trusted, else the load balancer's last X-Forwarded-For entry, else the socket", () => {
  const behindCloudflare = headers({ "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.66, 162.158.1.1" });
  assert.equal(clientAddress(behindCloudflare, "10.0.0.9", true), "203.0.113.5");
  // Untrusted, the header is anyone's to send: the last X-Forwarded-For entry is the hop the load balancer saw (here, Cloudflare's edge).
  assert.equal(clientAddress(behindCloudflare, "10.0.0.9", false), "162.158.1.1");
  assert.equal(clientAddress(headers({ "cf-connecting-ip": "not an address", "x-forwarded-for": "198.51.100.7" }), "10.0.0.9", true), "198.51.100.7");
  assert.equal(clientAddress(headers({}), "10.0.0.9", true), "10.0.0.9");
  assert.equal(clientAddress(headers({}), undefined, false), undefined);
});

test("per-address limits count an IPv6 /64 as one client, Workers by their zone, and never the runtime's own loopback calls", () => {
  const none = headers({});
  assert.equal(clientKey(none, "203.0.113.5", true), "203.0.113.5");
  assert.equal(clientKey(none, "::ffff:203.0.113.9", false), "203.0.113.9");
  assert.equal(clientKey(none, "2001:db8:abcd:12:1::5", true), "2001:db8:abcd:12::/64");
  assert.equal(clientKey(none, "2001:DB8::1", true), "2001:db8:0:0::/64");
  assert.equal(clientKey(none, "2001:db8:1:2:3:4:1.2.3.4", true), "2001:db8:1:2::/64");
  const worker = headers({ "cf-worker": "Chiridion.Example" });
  assert.equal(clientKey(worker, "2a06:98c0:3600::103", true), "worker:chiridion.example");
  assert.equal(clientKey(worker, "2a06:98c0:3600::103", false), "2a06:98c0:3600:0::/64", "CF-Worker only counts behind Cloudflare");
  assert.equal(clientKey(worker, "203.0.113.5", true), "203.0.113.5", "CF-Worker only counts on Workers' own address");
  for (const address of ["127.0.0.1", "127.8.0.1", "::1", "::ffff:127.0.0.1"]) assert.ok(loopback(address), address);
  for (const address of ["10.0.0.1", "::2", "203.0.113.127"]) assert.ok(!loopback(address), address);
});

test("rate limits are configured from the environment, each 0 for none", () => {
  const defaults = rateLimitConfig({ AGENT_TRUST_CF_CONNECTING_IP: "true" });
  assert.deepEqual({ ...defaults, exempt: [...defaults.exempt] }, {
    cloudflare: true, apiPerIp: 600, authPerIp: 20, signupsPerIp: 5, passwordFailuresPerIp: 20, passwordFailuresPerEmail: 10, emailRequestsPerIp: 10, emailsPerAddress: 5, agentCreates: 600, freeAgentCreates: 600, runs: 600, freeRuns: 240, exempt: [],
  });
  // Without Cloudflare, the address may be a shared proxy's: per-address limits are the operator's to set. Failures per email address stay.
  assert.deepEqual(rateLimitConfig({}), { ...defaults, cloudflare: false, apiPerIp: 0, authPerIp: 0, signupsPerIp: 0, passwordFailuresPerIp: 0, emailRequestsPerIp: 0 });
  assert.equal(rateLimitConfig({ AGENT_RATE_LIMIT_AUTH_PER_IP: "30" }).authPerIp, 30);
  const set = rateLimitConfig({ AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_API_PER_IP: "0", AGENT_RATE_LIMIT_FREE_RUNS: "5", AGENT_RATE_LIMIT_EXEMPT: " worker:Chiridion.Example , 203.0.113.5" });
  assert.equal(set.cloudflare, true);
  assert.equal(set.apiPerIp, 0);
  assert.equal(set.freeRuns, 5);
  assert.deepEqual([...set.exempt], ["worker:chiridion.example", "203.0.113.5"]);
  assert.throws(() => rateLimitConfig({ AGENT_RATE_LIMIT_RUNS: "-1" }), /AGENT_RATE_LIMIT_RUNS must be a non-negative integer/);
  assert.throws(() => rateLimitConfig({ AGENT_RATE_LIMIT_RUNS: "1.5" }), /non-negative integer/);
  assert.throws(() => rateLimitConfig({ AGENT_TRUST_CF_CONNECTING_IP: "yes" }), /true or false/);
});

test("tenants file entries may raise or lower their own per-minute limits", async () => {
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { ops: { tokenSha256: "a".repeat(64), maxAgentCreatesPerMinute: 600, maxRunsPerMinute: 6000 }, plain: { tokenSha256: "b".repeat(64) } } }) });
  await tenants.reload();
  assert.equal(tenants.rateLimit("ops", "agentCreates"), 600);
  assert.equal(tenants.rateLimit("ops", "runs"), 6000);
  assert.equal(tenants.rateLimit("plain", "runs"), undefined);
  const invalid = new Tenants({ read: async () => JSON.stringify({ tenants: { ops: { tokenSha256: "a".repeat(64), maxRunsPerMinute: 0 } } }) });
  await assert.rejects(invalid.reload(), /invalid maxRunsPerMinute/);
});

/** Limits over a test database, at a clock the test moves. */
async function limits(config: Partial<RateLimitConfig> = {}, options: { nodes?: number; free?: (tenant: string) => boolean; override?: (tenant: string, limit: "agentCreates" | "runs") => number | undefined; exempt?: (tenant: string) => boolean } = {}) {
  const { db } = await testDatabase();
  const clock = { now: Date.UTC(2026, 9, 1, 12, 0, 10) };
  let freeChecks = 0;
  const make = () => new RateLimits({
    db, config: { ...rateLimitConfig({}), ...config }, hashKey: "rate-limit-test-hash-key", nodes: () => options.nodes ?? 1, now: () => clock.now,
    free: async tenant => { freeChecks++; return options.free?.(tenant) ?? false; }, override: options.override, exempt: options.exempt,
  });
  return { db, clock, limits: make(), another: make(), freeChecks: () => freeChecks };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, error => error);
  assert.ok(error instanceof RateLimited, `refused: ${error}`);
  assert.equal(error.status, 429);
  assert.equal(error.code, "RATE_LIMITED");
  return error;
}

test("/v1 requests per address: each node holds its share of the minute's budget, refilled continuously", async () => {
  const { clock, limits: one } = await limits({ apiPerIp: 3 });
  for (let i = 0; i < 3; i++) await one.request("/v1/me", "203.0.113.5");
  const refused = await refusal(one.request("/v1/agents", "203.0.113.5"));
  assert.deepEqual(refused.limit, { name: "api_requests", scope: "ip", max: 3, windowSeconds: 60 });
  assert.equal(refused.retryAfter, 20, "one request comes back every 20 s");
  await one.request("/v1/me", "203.0.113.6");
  await one.request("/console/", "203.0.113.5");
  await one.request("/v1/me", undefined);
  clock.now += 20_000;
  await one.request("/v1/me", "203.0.113.5");
  await refusal(one.request("/v1/me", "203.0.113.5"));

  // Three nodes share a budget of 3: one each.
  const { limits: shared } = await limits({ apiPerIp: 3 }, { nodes: 3 });
  await shared.request("/v1/me", "203.0.113.5");
  assert.equal((await refusal(shared.request("/v1/me", "203.0.113.5"))).retryAfter, 60);
  const { limits: exempt } = await limits({ apiPerIp: 1, exempt: new Set(["worker:chiridion.example"]) });
  for (let i = 0; i < 5; i++) await exempt.request("/v1/me", "worker:chiridion.example");
  // An admin tenant's /v1 traffic is never counted per address; its sign-ins are.
  const { limits: trusted } = await limits({ apiPerIp: 1, authPerIp: 1 });
  for (let i = 0; i < 5; i++) await trusted.request("/v1/me", "2a06:98c0:3600:0::/64", async () => true);
  await trusted.request("/v1/me", "2a06:98c0:3600:0::/64");
  await refusal(trusted.request("/v1/me", "2a06:98c0:3600:0::/64"));
  await trusted.request("/oauth/token", "203.0.113.9", async () => true);
  await refusal(trusted.request("/oauth/token", "203.0.113.9", async () => true));
  const { limits: off } = await limits({ apiPerIp: 0 });
  for (let i = 0; i < 5; i++) await off.request("/v1/me", "203.0.113.5");
});

test("sign-in requests per address are counted in Postgres, across nodes, in fixed minutes", async () => {
  const { clock, limits: a, another: b } = await limits({ authPerIp: 3 });
  await a.request("/console/auth/github", "203.0.113.5");
  await b.request("/oauth/token", "203.0.113.5");
  await a.request("/console/auth/callback", "203.0.113.5");
  const refused = await refusal(b.request("/oauth/register", "203.0.113.5"));
  assert.deepEqual(refused.limit, { name: "auth_requests", scope: "ip", max: 3, windowSeconds: 60 });
  assert.equal(refused.retryAfter, 50, "until the minute turns over");
  await a.request("/oauth/token", "203.0.113.6");
  clock.now += 50_000;
  await a.request("/oauth/token", "203.0.113.5");
});

test("agent creates and runs per tenant: lower on free credit, none for admin tenants, an admin's override over both", async () => {
  const { clock, limits: tenantLimits, freeChecks } = await limits({ agentCreates: 3, freeAgentCreates: 1, runs: 2, freeRuns: 1 }, {
    free: tenant => tenant === "free", override: (tenant, limit) => tenant === "ops" && limit === "runs" ? 4 : undefined,
    exempt: tenant => tenant === "ops" || tenant === "chiridion-prod",
  });
  for (let i = 0; i < 50; i++) { await tenantLimits.agentCreate("chiridion-prod"); await tenantLimits.run("chiridion-prod"); }
  for (let i = 0; i < 50; i++) await tenantLimits.agentCreate("ops");
  for (let i = 0; i < 3; i++) await tenantLimits.agentCreate("paid");
  const refused = await refusal(tenantLimits.agentCreate("paid"));
  assert.deepEqual(refused.limit, { name: "agent_creates", scope: "tenant", max: 3, windowSeconds: 60 });
  assert.match(refused.message, /at most 3 a minute for this account \(a limit against abuse\)\. Upsert an agent you have instead of making new ones$/);
  await tenantLimits.agentCreate("free");
  assert.match((await refusal(tenantLimits.agentCreate("free"))).message, /at most 1 a minute for this account \(a limit against abuse, on free credit; buying credit raises it to 3 a minute\)/);

  for (let i = 0; i < 2; i++) await tenantLimits.run("paid");
  assert.deepEqual((await refusal(tenantLimits.run("paid"))).limit, { name: "runs", scope: "tenant", max: 2, windowSeconds: 60 });
  await tenantLimits.run("free");
  assert.match((await refusal(tenantLimits.run("free"))).message, /at most 1 a minute for this account on free credit; buying credit raises it to 2 a minute$/);
  const checked = freeChecks();
  for (let i = 0; i < 4; i++) await tenantLimits.run("ops");
  await refusal(tenantLimits.run("ops"));
  assert.equal(freeChecks(), checked, "an override needs no billing lookup");
  // Creates and runs are counted apart, and each minute starts afresh.
  clock.now += 60_000;
  await tenantLimits.run("paid");
  await tenantLimits.agentCreate("paid");
});

test("a tenant's window as X-RateLimit-* headers: limit, what is left, and seconds until the clock minute turns over; a read counts nothing", async () => {
  const { clock, limits: tenantLimits } = await limits({ agentCreates: 3, runs: 2 }, { exempt: tenant => tenant === "ops" });
  // The clock is 10 s into its minute: windows align to the clock minute, so each resets in 50 s.
  assert.deepEqual(await tenantLimits.agentCreate("paid", false), { limit: 3, remaining: 3, reset: 50 }, "nothing counted yet");
  assert.deepEqual(await tenantLimits.agentCreate("paid"), { limit: 3, remaining: 2, reset: 50 });
  assert.deepEqual(await tenantLimits.agentCreate("paid", false), { limit: 3, remaining: 2, reset: 50 }, "a read counts nothing");
  clock.now += 20_000;
  assert.deepEqual(await tenantLimits.agentCreate("paid"), { limit: 3, remaining: 1, reset: 30 });
  assert.deepEqual(await tenantLimits.agentCreate("paid"), { limit: 3, remaining: 0, reset: 30 });
  const refused = await refusal(tenantLimits.agentCreate("paid"));
  assert.deepEqual(errorHeaders(refused), { "Retry-After": "30", "X-RateLimit-Limit": "3", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "30" });
  // Each tenant sees its own window only, and runs have theirs.
  assert.deepEqual(await tenantLimits.agentCreate("other"), { limit: 3, remaining: 2, reset: 30 });
  assert.deepEqual(await tenantLimits.run("paid"), { limit: 2, remaining: 1, reset: 30 });
  // No limit applies to an admin tenant, nor where the limit is 0: no headers.
  assert.equal(await tenantLimits.agentCreate("ops"), undefined);
  assert.deepEqual(rateLimitHeaders(undefined), {});
  const { limits: unlimited } = await limits({ agentCreates: 0 });
  assert.equal(await unlimited.agentCreate("paid"), undefined);
  // Per-address limits are not the tenant's: their 429s carry Retry-After only.
  const { limits: perAddress } = await limits({ authPerIp: 1 });
  await perAddress.request("/oauth/token", "203.0.113.5");
  assert.deepEqual(Object.keys(errorHeaders(await refusal(perAddress.request("/oauth/token", "203.0.113.5")))), ["Retry-After"]);
  clock.now += 30_000;
  assert.deepEqual(await tenantLimits.agentCreate("paid", false), { limit: 3, remaining: 3, reset: 60 }, "a new minute starts afresh");
});

/** Wait, if the clock minute is about to turn over, for the next one: fixed windows reset with it. */
async function freshMinute() {
  const into = Date.now() % 60_000;
  if (into > 40_000) await sleep(60_000 - into + 200);
}

test("creates and runs answer with X-RateLimit-* headers; an upsert that changes nothing is not a create, and gives the same configHash", { timeout: 180_000 }, async t => {
  const r = await runtime(t, () => ({ content: "ok" }), { AGENT_RATE_LIMIT_FREE_AGENT_CREATES: "3", AGENT_BILLING_ADMINS: "alice" }, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, maxRunsPerMinute: 2 },
  } });
  const carol = (await r.call("/v1/tenants", { body: { id: "carol" } })).json.token.token as string;
  const dave = (await r.call("/v1/tenants", { body: { id: "dave" } })).json.token.token as string;
  const limitsOf = (headers: Headers) => ({ limit: headers.get("x-ratelimit-limit"), remaining: headers.get("x-ratelimit-remaining"), reset: Number(headers.get("x-ratelimit-reset")) });
  const upsert = (key: string, body: object, token = carol) => r.call("/v1/agents", { body, token, headers: { "Idempotency-Key": key } });
  await freshMinute();

  // The default limits: busy agents and runs on free credit, and what buying credit raises them to; creates only against abuse.
  const billing = (await r.call("/v1/billing", { token: carol })).json;
  assert.deepEqual(billing.runsPerMinute, { limit: 240, afterPurchase: 600 });
  assert.deepEqual({ limit: billing.busyAgents.limit, next: billing.busyAgents.next }, { limit: 20, next: { tier: "Tier 1", paid: 5_000_000, limit: 25 } });
  const made = await upsert("triage", { systemPrompt: "Answer yes or no." });
  assert.equal(made.status, 201, made.text);
  assert.match(made.json.configHash, /^[0-9a-f]{64}$/);
  const first = limitsOf(made.headers);
  assert.deepEqual({ ...first, reset: undefined }, { limit: "3", remaining: "2", reset: undefined });
  assert.ok(first.reset >= 1 && first.reset <= 60, `reset ${first.reset}`);
  // The same configuration again, however often: the same agent and hash, nothing counted.
  for (let i = 0; i < 5; i++) {
    const again = await upsert("triage", { systemPrompt: "Answer yes or no." });
    assert.equal(again.status, 201, again.text);
    assert.equal(again.json.id, made.json.id);
    assert.equal(again.json.configHash, made.json.configHash);
    assert.equal(again.headers.get("x-ratelimit-remaining"), "2", "a no-op upsert counts nothing");
  }
  const listed = (await r.call("/v1/agents", { token: carol })).json.find((agent: { id: string }) => agent.id === made.json.id);
  assert.equal(listed.configHash, made.json.configHash);
  assert.equal((await r.call("/v1/agents/triage/credentials", { token: carol })).json.configHash, made.json.configHash);
  // A change is a create: a new hash, which the agent has once its reconfigure applies.
  const changed = await upsert("triage", { systemPrompt: "Answer yes, no or maybe." });
  assert.equal(changed.headers.get("x-ratelimit-remaining"), "1");
  assert.notEqual(changed.json.configHash, made.json.configHash);
  await until(async () => (await r.call(`/v1/agents/${made.json.id}/requests/${changed.json.reconfigured.id}`, { token: carol })).json.state === "completed", "the upsert's reconfigure");
  assert.equal((await r.call(`/v1/agents/${made.json.id}`, { token: carol })).json.configHash, changed.json.configHash);
  assert.equal((await upsert("triage", { systemPrompt: "Answer yes, no or maybe." })).headers.get("x-ratelimit-remaining"), "1");
  assert.equal((await r.call("/v1/agents", { body: {}, token: carol })).headers.get("x-ratelimit-remaining"), "0");
  // Past the limit: 429 with Retry-After and the headers; a no-op upsert still goes through.
  const refused = await upsert("another", {});
  assert.equal(refused.status, 429);
  assert.deepEqual({ ...limitsOf(refused.headers), reset: undefined }, { limit: "3", remaining: "0", reset: undefined });
  assert.equal(refused.headers.get("retry-after"), refused.headers.get("x-ratelimit-reset"));
  const noop = await upsert("triage", { systemPrompt: "Answer yes, no or maybe." });
  assert.equal(noop.status, 201, noop.text);
  assert.equal(noop.headers.get("x-ratelimit-remaining"), "0");
  // Another tenant's window is its own: carol's state never shows in dave's headers.
  assert.equal((await upsert("triage", {}, dave)).headers.get("x-ratelimit-remaining"), "2");

  // Runs, over REST and over the agent's own token (the SDKs' path), by a tenant with a limit of its own and its own model key.
  const agent = (await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR })).json;
  const run = await r.call(`/v1/agents/${agent.id}/prompt`, { body: { text: "Is the sky blue?" }, token: OTHER_OPERATOR });
  assert.equal(run.status, 202, run.text);
  assert.deepEqual({ ...limitsOf(run.headers), reset: undefined }, { limit: "2", remaining: "1", reset: undefined });
  const viaToken = await fetch(`${r.base}/clients/${agent.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "run-2", method: "prompt", params: { text: "Is grass green?" } }) });
  assert.equal(viaToken.status, 202);
  assert.equal(viaToken.headers.get("x-ratelimit-remaining"), "0");
  const over = await r.call(`/v1/agents/${agent.id}/prompt`, { body: { text: "And snow?" }, token: OTHER_OPERATOR });
  assert.equal(over.status, 429);
  assert.equal(over.headers.get("x-ratelimit-remaining"), "0");
  // A retry of an accepted run is not counted again, and says nothing of the window.
  const retried = await fetch(`${r.base}/clients/${agent.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "run-2", method: "prompt", params: { text: "Is grass green?" } }) });
  assert.equal(retried.status, 200);
  assert.equal(retried.headers.get("x-ratelimit-remaining"), null);
  // An admin tenant has no limit, so no headers.
  const admin = await r.call("/v1/agents", { body: {} });
  assert.equal(admin.status, 201);
  assert.equal(admin.headers.get("x-ratelimit-limit"), null);
});

test("sign-ups per address per day count in the transaction that creates the account", async () => {
  const { db, clock, limits: signups } = await limits({ signupsPerIp: 2 });
  await transaction(db, sql => signups.signup(sql, "203.0.113.5"));
  // A sign-up that fails after it was counted counts nothing.
  await assert.rejects(transaction(db, async sql => { await signups.signup(sql, "203.0.113.5"); throw new Error("GitHub said no"); }), /GitHub said no/);
  await transaction(db, sql => signups.signup(sql, "203.0.113.5"));
  const refused = await refusal(transaction(db, sql => signups.signup(sql, "203.0.113.5")));
  assert.deepEqual(refused.limit, { name: "signups", scope: "ip", max: 2, windowSeconds: 86_400 });
  assert.equal(refused.retryAfter, 12 * 3600 - 10, "until the UTC day ends");
  await transaction(db, sql => signups.signup(sql, "203.0.113.6"));
  await transaction(db, sql => signups.signup(sql, undefined));
  clock.now += 12 * 3600_000;
  await transaction(db, sql => signups.signup(sql, "203.0.113.5"));
});

test("ended windows are swept", async () => {
  const { db, clock, limits: swept } = await limits({ authPerIp: 5 });
  await swept.request("/oauth/token", "203.0.113.5");
  await swept.agentCreate("paid");
  await swept.sweep();
  const keys = (await db.query("select key from rate_limits order by key")).rows.map(row => row.key);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], "agent_creates:paid");
  assert.match(keys[1], /^auth:[0-9a-f]{32}$/, "addresses are stored as keyed hashes");
  clock.now += 61_000;
  await swept.sweep();
  assert.equal((await db.query("select count(*)::int as n from rate_limits")).rows[0].n, 0);
});

test("the server answers 429 RATE_LIMITED with Retry-After and the limit: per address behind Cloudflare, per tenant for creates and runs", async t => {
  const r = await runtime(t, () => ({ content: "ok" }), {
    AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_API_PER_IP: "4", AGENT_RATE_LIMIT_FREE_AGENT_CREATES: "2", AGENT_RATE_LIMIT_FREE_RUNS: "2", AGENT_BILLING_ADMINS: "alice",
  }, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, maxAgentCreatesPerMinute: 3 },
  } });
  // A self-serve tenant (prepaid, on free credit) and its API token.
  const carol = (await r.call("/v1/tenants", { body: { id: "carol" } })).json.token.token as string;
  const from = (ip: string, extra: Record<string, string> = {}) => ({ "CF-Connecting-IP": ip, ...extra });
  for (let i = 0; i < 4; i++) assert.equal((await r.call("/v1/me", { token: carol, headers: from("203.0.113.5") })).status, 200);
  // A forged hop header (what peers send) does not skip the count.
  const response = await fetch(`${r.base}/v1/me`, { headers: { Authorization: `Bearer ${carol}`, ...from("203.0.113.5", { "x-agent-runtime-hop": `${Date.now()}.forged` }) } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "15");
  assert.deepEqual(await response.json(), {
    type: "error", code: "RATE_LIMITED", error: "Too many requests from this address: at most 4 a minute to /v1. Retry after Retry-After",
    limit: { name: "api_requests", scope: "ip", max: 4, windowSeconds: 60 },
  });
  assert.equal((await r.call("/v1/me", { token: null, headers: from("203.0.113.5") })).status, 429, "unauthenticated requests count too");
  assert.equal((await r.call("/v1/me", { token: carol, headers: from("203.0.113.6") })).status, 200, "another address has its own budget");
  assert.equal((await r.call("/v1/me", { token: carol, headers: from("2001:db8:1:2::9") })).status, 200);
  // The runtime's own loopback calls (hosted MCP tools) carry no address and are not counted.
  for (let i = 0; i < 6; i++) assert.equal((await r.call("/v1/me", { token: carol })).status, 200);

  const created = [];
  for (let i = 0; i < 2; i++) created.push((await r.call("/v1/agents", { body: {}, token: carol })).json.id);
  const refused = await r.call("/v1/agents", { body: {}, token: carol });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.code, "RATE_LIMITED");
  assert.deepEqual(refused.json.limit, { name: "agent_creates", scope: "tenant", max: 2, windowSeconds: 60 });
  assert.match(refused.json.error, /on free credit/);
  // An admin tenant with a limit of its own in the tenants file is held to it.
  for (let i = 0; i < 3; i++) assert.equal((await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR })).status, 201);
  assert.equal((await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR })).status, 429);

  // Runs are counted when accepted, whatever then refuses them (here, no credit), and never for a retry.
  const run = (agent: string, requestId: string) => r.call(`/v1/agents/${agent}/prompt`, { body: { text: requestId, requestId }, token: carol });
  assert.notEqual((await run(created[0], "run-1")).status, 429);
  assert.notEqual((await run(created[0], "run-2")).status, 429);
  const third = await run(created[1], "run-3");
  assert.equal(third.status, 429);
  assert.deepEqual(third.json.limit, { name: "runs", scope: "tenant", max: 2, windowSeconds: 60 });
  assert.match(third.json.error, /Too many runs started: at most 2 a minute for this account on free credit/);
  // The operator raises this self-serve tenant's run limit (tenants.limits); null returns it to the plan's.
  const raised = await r.call("/v1/tenants/carol/limits", { method: "PUT", body: { runsPerMinute: 4 } });
  assert.deepEqual(raised.json, { tenant: "carol", limits: { runsPerMinute: 4 } });
  assert.notEqual((await run(created[1], "run-4")).status, 429);
  assert.deepEqual((await run(created[1], "run-5")).json.limit, { name: "runs", scope: "tenant", max: 4, windowSeconds: 60 });
  assert.deepEqual((await r.call("/v1/tenants/carol/limits", { method: "PUT", body: { runsPerMinute: null, agentCreatesPerMinute: 50 } })).json, { tenant: "carol", limits: { agentCreatesPerMinute: 50 } });
  assert.equal((await r.call("/v1/agents", { body: {}, token: carol })).status, 201);
});

test("an admin tenant's traffic (camelAI's servers behind a few Cloudflare egress addresses, its users' browser tokens) is never rate limited", async t => {
  // Limits far below what it sends: 5 /v1 requests a minute per address, 3 agent creates and 3 runs a minute per tenant.
  const r = await runtime(t, () => ({ content: "ok" }), {
    AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_API_PER_IP: "5", AGENT_RATE_LIMIT_AGENT_CREATES: "3", AGENT_RATE_LIMIT_RUNS: "3", AGENT_MAX_AGENTS: "32", AGENT_MAX_AGENTS_PER_TENANT: "16",
  });
  // Every Worker subrequest arrives from Cloudflare's one Workers address; containers from a few others.
  const worker = { "CF-Connecting-IP": "2a06:98c0:3600::103", "CF-Worker": "camelai.dev" };
  const container = { "CF-Connecting-IP": "203.0.113.50" };
  const agents: string[] = [];
  for (let i = 0; i < 8; i++) {
    const created = await r.call("/v1/agents", { body: {}, headers: i % 2 ? worker : container });
    assert.equal(created.status, 201, `create ${i}: ${created.text}`);
    agents.push(created.json.id);
  }
  for (let i = 0; i < 8; i++) assert.equal((await r.call(`/v1/agents/${agents[i]}/prompt`, { body: { text: `hi ${i}` }, headers: i % 2 ? worker : container })).status, 202, `run ${i}`);
  for (let i = 0; i < 20; i++) assert.equal((await r.call(`/v1/agents/${agents[0]}/state`, { headers: worker })).status, 200);
  // Its end users' browsers, many behind one corporate NAT, read with browser tokens it minted.
  const minted = (await r.call(`/v1/agents/${agents[0]}/browser-tokens`, { body: {} })).json.token as string;
  for (let i = 0; i < 20; i++) assert.equal((await r.call(`/v1/agents/${agents[0]}/state`, { token: minted, headers: { "CF-Connecting-IP": "198.51.100.77" } })).status, 200);
  // Anyone else at that NAT address is still counted.
  for (let i = 0; i < 5; i++) assert.equal((await r.call("/v1/me", { token: null, headers: { "CF-Connecting-IP": "198.51.100.77" } })).status, 401);
  assert.equal((await r.call("/v1/me", { token: null, headers: { "CF-Connecting-IP": "198.51.100.77" } })).status, 429);
});

test("without AGENT_TRUST_CF_CONNECTING_IP, CF-Connecting-IP is ignored and the load balancer's X-Forwarded-For entry counts", async t => {
  const r = await runtime(t, () => ({ content: "ok" }), { AGENT_RATE_LIMIT_API_PER_IP: "2" });
  const sent = (cf: string, forwarded: string) => r.call("/v1/me", { token: null, headers: { "CF-Connecting-IP": cf, "X-Forwarded-For": forwarded } });
  assert.equal((await sent("203.0.113.1", "198.51.100.1, 10.0.0.7")).status, 401);
  assert.equal((await sent("203.0.113.2", "198.51.100.2, 10.0.0.7")).status, 401);
  assert.equal((await sent("203.0.113.3", "198.51.100.3, 10.0.0.7")).status, 429, "every request came from 10.0.0.7");
  assert.equal((await sent("203.0.113.3", "10.0.0.8")).status, 401);
});

test("a request a peer forwards is counted once, on the node it reached first", { timeout: 60_000 }, async t => {
  const c = await cluster(t);
  const env = { AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_API_PER_IP: "4" };
  // A counts one live node (itself) when it starts, so its share is all 4; B starts beside A, so its share is 2.
  const a = await c.start("a", env);
  const b = await c.start("b", env);
  const agent = (await (await fetch(`${a.url}/v1/agents`, { method: "POST", headers: { Authorization: `Bearer ${clusterToken}`, "Content-Type": "application/json" }, body: "{}" })).json()).id;
  // Unauthenticated (an admin tenant's requests are not counted per address): the owner, A, answers 401.
  const state = (node: { url: string }) => fetch(`${node.url}/v1/agents/${agent}/state`, { headers: { "CF-Connecting-IP": "203.0.113.5" } }).then(response => response.status);
  assert.equal(await state(b), 401);
  assert.equal(await state(b), 401);
  assert.equal(await state(b), 429, "B's share");
  for (let i = 0; i < 4; i++) assert.equal(await state(a), 401, "A did not count what B forwarded");
  assert.equal(await state(a), 429);
});
