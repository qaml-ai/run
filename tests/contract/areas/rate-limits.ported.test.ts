import { portedTest } from '../ported.ts';
const test = portedTest("quotas", "tests/rate-limits.test.ts");

import assert from "node:assert/strict";

import { createHash } from "node:crypto";



import { freshWindow, OPERATOR, OTHER_OPERATOR, runtime, until } from "../support.ts";

const headers = (values: Record<string, string>) => (name: string) => values[name];

const sha = (value: string) => createHash("sha256").update(value).digest("hex");


test("creates and runs answer with X-RateLimit-* headers; an upsert that changes nothing is not a create, and gives the same configHash", { timeout: 180_000 }, async t => {
  // A prepaid tenant's per-minute limits are its usage tier's.
  const tiers = [{ name: "Free", paidUsd: 0, busyAgents: 20, agentCreatesPerMinute: 3, runsPerMinute: 240 }, { name: "Tier 1", paidUsd: 5, busyAgents: 50, runsPerMinute: 600 }];
  const r = await runtime(t, () => ({ content: "ok" }), { AGENT_USAGE_TIERS: JSON.stringify(tiers), AGENT_BILLING_ADMINS: "alice" }, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, maxRunsPerMinute: 2 },
  } });
  const carol = (await r.call("/v1/tenants", { body: { id: "carol" } })).json.token.token as string;
  const dave = (await r.call("/v1/tenants", { body: { id: "dave" } })).json.token.token as string;
  const limitsOf = (headers: Headers) => ({ limit: headers.get("x-ratelimit-limit"), remaining: headers.get("x-ratelimit-remaining"), reset: Number(headers.get("x-ratelimit-reset")) });
  const upsert = (key: string, body: object, token = carol) => r.call("/v1/agents", { body, token, headers: { "Idempotency-Key": key } });
  await freshWindow(60, 20_000);

  // The tier's limits: busy agents and runs on free credit, and what buying credit raises them to; creates only against abuse.
  const billing = (await r.call("/v1/billing", { token: carol })).json;
  assert.deepEqual(billing.runsPerMinute, { limit: 240, afterPurchase: 600 });
  assert.deepEqual({ limit: billing.busyAgents.limit, next: billing.busyAgents.next }, { limit: 20, next: { tier: "Tier 1", paid: 5_000_000, limit: 50 } });
  // GET /v1/limits: the tier, every limit with its source, and the tiers. Tier 1 leaves creates to the default.
  const limits = (await r.call("/v1/limits", { token: carol })).json;
  assert.deepEqual(limits.tier, { name: "Free", paid: 0, next: { name: "Tier 1", paid: 5_000_000 } });
  assert.deepEqual(limits.limits.runsPerMinute, { limit: 240, source: "tier", tier: "Free", paid: 0, next: { tier: "Tier 1", paid: 5_000_000, limit: 600 } });
  assert.deepEqual(limits.limits.agentCreatesPerMinute, { limit: 3, source: "tier", tier: "Free", paid: 0 });
  assert.deepEqual({ ...limits.limits.busyAgents, busy: undefined }, { busy: undefined, limit: 20, source: "tier", tier: "Free", paid: 0, next: { tier: "Tier 1", paid: 5_000_000, limit: 50 } });
  assert.deepEqual(limits.limits.codeConcurrency, { limit: 2, source: "default" }, "a tier without codeConcurrency: free credit's default");
  assert.deepEqual(limits.limits.decisionConcurrency, { limit: 16, source: "default" });
  assert.equal(limits.tiers.length, 2);
  // An admin tenant without a tier has no per-minute limit.
  assert.deepEqual((await r.call("/v1/limits")).json.limits.runsPerMinute, { limit: null, source: "default" });
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

// Runtime log assertions stay in the source test; every HTTP assertion below is retained.
test("the server answers 429 RATE_LIMITED with Retry-After and the limit: per address behind Cloudflare, per tenant for creates and runs", async t => {
  const r = await runtime(t, () => ({ content: "ok" }), {
    AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_API_PER_IP: "4", AGENT_BILLING_ADMINS: "alice",
    AGENT_USAGE_TIERS: JSON.stringify([{ name: "Free", paidUsd: 0, busyAgents: 20, agentCreatesPerMinute: 2, runsPerMinute: 2 }, { name: "Tier 1", paidUsd: 5, busyAgents: 50, runsPerMinute: 600 }]),
  }, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, maxAgentCreatesPerMinute: 3 },
  } });
  // A self-serve tenant (prepaid, on free credit) and its API token.
  const carol = (await r.call("/v1/tenants", { body: { id: "carol" } })).json.token.token as string;
  // Creates and runs are counted in fixed clock minutes: the counting below stays in one.
  await freshWindow(60, 20_000);
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
  assert.match(refused.json.error, /usage tier Free/);
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
  assert.match(third.json.error, /Too many runs started: at most 2 a minute for this account \(usage tier Free; \$5 more of credit unlocks Tier 1: 600 a minute\)/);
  // The operator raises this self-serve tenant's run limit (tenants.limits); null returns it to the plan's.
  const raised = await r.call("/v1/tenants/carol/limits", { method: "PUT", body: { runsPerMinute: 4 } });
  assert.deepEqual(raised.json, { tenant: "carol", limits: { runsPerMinute: 4 } });
  assert.notEqual((await run(created[1], "run-4")).status, 429);
  assert.deepEqual((await run(created[1], "run-5")).json.limit, { name: "runs", scope: "tenant", max: 4, windowSeconds: 60 });
  assert.deepEqual((await r.call("/v1/tenants/carol/limits", { method: "PUT", body: { runsPerMinute: null, agentCreatesPerMinute: 50 } })).json, { tenant: "carol", limits: { agentCreatesPerMinute: 50 } });
  assert.equal((await r.call("/v1/agents", { body: {}, token: carol })).status, 201);

  // Decision concurrency is set and cleared the same way, and GET /v1/limits says where it comes from.
  const decisions = await r.call("/v1/tenants/carol/limits", { method: "PUT", body: { decisionConcurrency: 48 } });
  assert.deepEqual(decisions.json, { tenant: "carol", limits: { agentCreatesPerMinute: 50, decisionConcurrency: 48 } });
  assert.deepEqual((await r.call("/v1/limits", { token: carol })).json.limits.decisionConcurrency, { limit: 48, source: "tenant" });
  assert.deepEqual((await r.call("/v1/tenants/carol/limits", { method: "PUT", body: { decisionConcurrency: 500 } })).json.limits.decisionConcurrency, 500);
  assert.deepEqual((await r.call("/v1/limits", { token: carol })).json.limits.decisionConcurrency, { limit: 64, source: "tenant" }, "at most the node's");
  assert.deepEqual((await r.call("/v1/tenants/carol/limits", { method: "PUT", body: { decisionConcurrency: null } })).json.limits, { agentCreatesPerMinute: 50 });
  assert.deepEqual((await r.call("/v1/limits", { token: carol })).json.limits.decisionConcurrency, { limit: 16, source: "default" });
  assert.equal((await r.call("/v1/tenants/carol/limits", { method: "PUT", body: { decisionConcurrency: 0 } })).status, 400);
  // An admin tenant's is in the tenants file.
  assert.equal((await r.call("/v1/tenants/bob/limits", { method: "PUT", body: { decisionConcurrency: 48 } })).status, 409);
});

