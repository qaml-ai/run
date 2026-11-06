import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { apiRequest, createAdmission, runAdmission, admissionHeaders, admissionError, RateLimited, errorHeaders, sweepAdmission } from "../src/admission.ts";
import { keyServices } from "../src/security-services.ts";
import { testDatabase } from "./billing-database.ts";

async function fixture(extra: Record<string, string> = {}) {
  const { db, url } = await testDatabase();
  const token = "fake-operator-token-with-at-least-32-characters";
  const env = { HYPERDRIVE: { connectionString: url }, API_TOKEN: "fake-platform-token-with-at-least-32-characters",
    // src/rate-limits.ts only trusts Cloudflare headers when explicitly enabled.
    AGENT_PUBLIC_URL: "https://runtime.example.test", AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_API_PER_IP: "2",
    AGENT_TENANTS_JSON: JSON.stringify({ tenants: { operator: { tokenSha256: createHash("sha256").update(token).digest("hex"), tier: "internal" } } }), ...extra };
  await db.query("insert into tenants(id, billing, limits, created_at) values ('subject', 'none', $1, $2)", [JSON.stringify({ agentCreatesPerMinute: 2, runsPerMinute: 2 }), Date.now()]);
  return { db, env, token };
}

test("Workers API admission keeps source IP limits and authenticated admin exemptions", async () => {
  const { env, token } = await fixture();
  const request = (authorization?: string) => new Request("https://runtime.example.test/v1/providers", { headers: {
    "cf-connecting-ip": "8.8.8.8", ...(authorization ? { authorization } : {}),
  } });
  await apiRequest(request(), env);
  await apiRequest(request(), env);
  await assert.rejects(apiRequest(request("Bearer invalid"), env), (error: any) => error instanceof RateLimited && error.limit.name === "api_requests");
  // A real operator's requests do not consume the exhausted public bucket.
  await apiRequest(request(`Bearer ${token}`), env);
  await apiRequest(new Request("https://runtime.example.test/health", { headers: { "cf-connecting-ip": "8.8.8.8" } }), env);
});

test("Workers API admission groups source IPv6 /64 and identifies Worker zones", async () => {
  const { env } = await fixture({ AGENT_RATE_LIMIT_API_PER_IP: "1" });
  const request = (address: string, zone?: string) => new Request("https://runtime.example.test/v1/providers", { headers: {
    "cf-connecting-ip": address, ...(zone ? { "cf-worker": zone } : {}),
  } });
  await apiRequest(request("2001:db8:1:2::1"), env);
  await assert.rejects(apiRequest(request("2001:db8:1:2::2"), env), RateLimited);
  await apiRequest(request("2a06:98c0:3600::103", "first.test"), env);
  await apiRequest(request("2a06:98c0:3600::103", "second.test"), env);
  await assert.rejects(apiRequest(request("2a06:98c0:3600::103", "first.test"), env), RateLimited);
});

test("create and run counters are shared in Postgres, and replays consume nothing", async () => {
  const { db, env } = await fixture();
  const first = await createAdmission(env, "subject");
  assert.equal(first?.remaining, 1);
  assert.equal(admissionHeaders(first)["X-RateLimit-Limit"], "2");
  await createAdmission({ ...env }, "subject");
  await assert.rejects(createAdmission({ ...env }, "subject"), RateLimited);
  assert.equal((await createAdmission({ ...env }, "subject", false))?.remaining, 0);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => runAdmission({ ...env }, "subject")));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 2);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof RateLimited).length, 2);
  assert.equal(await runAdmission(env, "subject", false), undefined);
  const row = (await db.query("select count from rate_limits where key = 'runs:subject'")).rows[0];
  assert.equal(row.count, 4);
  // Admin internal-tier requests have no counter unless their configuration overrides it.
  assert.equal(await runAdmission(env, "operator"), undefined);
  assert.equal((await db.query("select 1 from rate_limits where key = 'runs:operator'")).rowCount, 0);
});

test("rate errors preserve source body, retry headers, and bounded counter lifetime", async () => {
  const { db, env } = await fixture();
  await runAdmission(env, "subject"); await runAdmission(env, "subject");
  let refused: unknown;
  try { await runAdmission(env, "subject"); } catch (error) { refused = error; }
  const response = admissionError(refused);
  assert.equal(response?.status, 429);
  const body = await response!.json() as any;
  assert.equal(body.code, "RATE_LIMITED");
  assert.deepEqual(body.limit, { name: "runs", scope: "tenant", max: 2, windowSeconds: 60 });
  assert.equal(response!.headers.get("X-RateLimit-Remaining"), "0");
  assert.ok(Number(response!.headers.get("Retry-After")) >= 1);
  assert.deepEqual(errorHeaders(Object.assign(new Error("serialization failure"), { code: "40001" })), { "Retry-After": "1" });
  assert.equal(admissionError(new Error("other")), undefined);
  await db.query("insert into rate_limits values ('expired-fixture', 0, 1, 1)");
  await sweepAdmission(env);
  assert.equal((await db.query("select 1 from rate_limits where key = 'expired-fixture'")).rowCount, 0);
});

test("source pricing environment config reaches Accounts billing and its tier policy", async () => {
  const { env } = await fixture({ AGENT_PRICE_AGENT_HOUR_USD: "0.12", AGENT_FREE_HOURLY_SPEND_USD: "0.25", AGENT_CREDIT_GRANT_USD: "3",
    AGENT_MAX_AGENTS: "16", AGENT_USAGE_TIERS: '[{"name":"Entry","paidUsd":0,"busyAgents":7,"runsPerMinute":9}]' });
  const { accounts } = await keyServices(env);
  assert.equal(accounts.billing.pricing.agentHour, 120_000);
  assert.equal(accounts.billing.pricing.free.hourlySpend, 250_000);
  assert.equal(accounts.billing.pricing.startingGrant, 3_000_000);
  assert.equal(accounts.billing.pricing.tiers[0].runsPerMinute, 9);
  assert.equal((await accounts.billing.busyLimit("subject")).limit, 8);
  await assert.rejects(keyServices({ ...env, AGENT_CREDIT_MIN_PURCHASE_USD: "0.01" }), /at least 0.50/);
});
