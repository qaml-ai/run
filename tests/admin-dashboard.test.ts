import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { adminWindow } from "../src/admin-accounts.ts";
import { adminAcquisition } from "../src/admin-acquisition.ts";
import { adminGrowth } from "../src/admin-growth.ts";
import { adminHealth } from "../src/admin-health.ts";
import { adminRevenue, freeCreditBucket } from "../src/admin-revenue.ts";
import { adminSite, adminSiteFromEnvironment, OPS_ICON, type AdminSiteOptions } from "../src/admin-site.ts";
import { adminAccount, adminUsage, maskSecrets } from "../src/admin-usage.ts";
import type { Sql } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { listen, type T } from "./runtime-server.ts";

const at = (iso: string) => Date.parse(iso);
/** A Friday afternoon: the 7-day window is March 14 to 20, the one before it March 7 to 13. */
const NOW = at("2026-03-20T15:00:00Z");
const STAFF = ["camelai.com"];
const USD = 1_000_000;
const TEAM = "https://fixture.cloudflareaccess.example";
const AUD = "fixture-access-audience";

type Tenant = { id: string; created: string; github?: number; google?: string; email?: boolean; billing?: "prepaid" | "none" };

/**
 * Accounts with something of everything: three people who signed up (Ann and Bea this week, Cat the week before), one
 * from long ago, staff, an erased account, one an operator made, and an admin tenant (a camelBot: no `tenants` row).
 */
async function seed(db: Sql) {
  const tenants: Tenant[] = [
    { id: "ann", created: "2026-03-15T10:00:00Z", github: 1 },
    { id: "bea", created: "2026-03-16T09:00:00Z", google: "bea@example.test" },
    { id: "cat", created: "2026-03-10T12:00:00Z", email: true },
    { id: "old", created: "2026-02-01T08:00:00Z", github: 9 },
    { id: "dan", created: "2026-03-17T08:00:00Z", google: "dan@camelai.com" },
    { id: "eve", created: "2026-03-18T08:00:00Z", github: 5 },
    { id: "ops-made", created: "2026-03-15T08:00:00Z", billing: "none" },
  ];
  for (const t of tenants) {
    await db.query("insert into tenants (id, github, github_id, google_sub, google_email, email_signup, created_at, billing) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [t.id, t.github ? t.id : null, t.github ?? null, t.google ? `sub-${t.id}` : null, t.google ?? null, !!t.email, at(t.created), t.billing ?? "prepaid"]);
  }
  await db.query("insert into account_deletions (tenant, requested_at, requested_by) values ('eve', $1, 'self')", [at("2026-03-19T00:00:00Z")]);

  const usage = (tenant: string, day: string, model: string, responses: number, cost: number, platform = true) => db.query(
    "insert into usage (tenant, day, model, responses, cost, platform_responses, platform_cost) values ($1, $2, $3, $4, $5, $6, $7)",
    [tenant, day, model, responses, cost, platform ? responses : 0, platform ? cost : 0]);
  await usage("ann", "2026-03-15", "anthropic/claude-sonnet-4-5", 3, 0.3);
  await usage("ann", "2026-03-18", "anthropic/claude-sonnet-4-5", 2, 0.2);
  await usage("ann", "2026-03-18", "brave/web_search", 4, 0.02);
  await usage("cat", "2026-03-12", "openai/gpt-5-mini", 1, 0.01);
  await usage("cat", "2026-03-19", "openai/gpt-5-mini", 4, 0.04, false);
  await usage("cat", "2026-03-19", "compaction:openai/gpt-5-mini", 1, 0.01);
  await usage("old", "2026-03-02", "openai/gpt-5-mini", 1, 0.01);
  await usage("dan", "2026-03-18", "openai/gpt-5", 9, 0.9);
  await usage("camelbot", "2026-03-19", "openrouter/openai/gpt-5", 100, 2);
  await usage("camelbot", "2026-03-19", "transcription:openai/gpt-4o-transcribe", 3, 0.03);

  const agent = (id: string, tenant: string, model: string, header: object, extra: { revoked?: boolean } = {}) => db.query(
    "insert into agents (id, tenant, header, revision, name, type, model, revoked) values ($1, $2, $3, 1, $4, 'general', $5, $6)",
    [id, tenant, JSON.stringify({ version: 3, id, tenant, ...header }), `${id}-name`, model, !!extra.revoked]);
  await agent("ann-bot", "ann", "anthropic/claude-sonnet-4-5", {
    config: { systemPrompt: `You are Ann's research helper. ${"Read carefully. ".repeat(200)}` },
    sources: { builtins: ["web_search", "schedule"], mcpServers: [{ name: "notes", url: "https://mcp.example.test/sse?token=do-not-show" }] },
    definitions: [],
  });
  await agent("ann-old", "ann", "openai/gpt-5-mini", { config: {} }, { revoked: true });
  await agent("bot-1", "camelbot", "openrouter/openai/gpt-5", { config: { codeMode: false }, sources: { builtins: ["web_fetch"] }, definitions: [{ name: "reply" }] });
  await agent("bot-2", "camelbot", "openrouter/openai/gpt-5", { config: {}, definition: { id: "def_bot", revision: 1 } });
  await agent("run-1", "camelbot", "openrouter/openai/gpt-5", { config: {}, run: { retentionMs: 1, fingerprint: "x" } });

  const attempt = (tenant: string, agentId: string, iso: string, endUser: string | null = null) => db.query(`
    insert into model_attempts (id, tenant, agent, provider, model, kind, platform, catalog_priced, prepaid, state, started_at, updated_at, next_check_at, end_user)
    values ($1, $2, $3, 'anthropic', 'm', 'response', true, true, true, 'settled', $4, $4, $4, $5)`, [randomUUID(), tenant, agentId, at(iso), endUser]);
  for (let i = 0; i < 5; i++) await attempt("ann", "ann-bot", `2026-03-1${5 + (i % 2) * 3}T12:00:00Z`, i === 0 ? "ann-user" : null);
  for (const user of ["u1", "u2", "u3", "u1"]) await attempt("camelbot", "bot-1", "2026-03-19T12:00:00Z", user);
  await attempt("camelbot", "bot-2", "2026-03-19T13:00:00Z", "u1");
  await attempt("camelbot", "bot-2", "2026-03-10T13:00:00Z", "u9");
  await db.query(`
    insert into model_attempts (id, tenant, agent, provider, model, kind, platform, catalog_priced, prepaid, state, started_at, updated_at, next_check_at)
    values ($1, 'ann', 'ann-bot', 'openrouter', 'm', 'response', true, false, true, 'pending', $2, $2, $2)`, [randomUUID(), at("2026-03-20T10:00:00Z")]);

  const ledger = (tenant: string, kind: string, amount: number, key: string, iso: string) => db.query(
    "insert into credit_ledger (tenant, kind, amount, idempotency_key, created_at) values ($1, $2, $3, $4, $5)", [tenant, kind, amount, key, at(iso)]);
  await ledger("ann", "grant", 5 * USD, "grant:github:1", "2026-03-15T10:00:01Z");
  await ledger("ann", "usage", -0.6 * USD, "usage:ann:1", "2026-03-18T10:00:00Z");
  await ledger("cat", "grant", 5 * USD, "grant:card:live:fp", "2026-03-10T12:30:00Z");
  await ledger("cat", "purchase", 20 * USD, "purchase:cat:1", "2026-03-19T09:00:00Z");
  await ledger("cat", "usage", -6 * USD, "usage:cat:1", "2026-03-19T10:00:00Z");
  await ledger("eve", "grant", 5 * USD, "grant:github:5", "2026-03-18T08:00:01Z");
  await ledger("dan", "purchase", 50 * USD, "purchase:dan:1", "2026-03-18T09:00:00Z");
  for (const [tenant, balance, purchased] of [["ann", 4.4 * USD, 0], ["cat", 19 * USD, 20 * USD], ["eve", 5 * USD, 0], ["dan", 50 * USD, 50 * USD]] as const) {
    await db.query("insert into credit_accounts (tenant, balance, purchased) values ($1, $2, $3)", [tenant, balance, purchased]);
  }
  await db.query("insert into starting_credit_decisions (github_id, tenant, decision, offered_amount, signup_at, decided_at) values (9, 'old', 'ineligible', 0, $1, $1)", [at("2026-02-01T08:00:00Z")]);

  await db.query("insert into schedules (id, agent, tenant, text, due_at, created_at) values ($1, 'ann-bot', 'ann', 'check', $2, $2)", [randomUUID(), NOW - 60 * 60_000]);
  await db.query("insert into channels (id, tenant, channel, created_at) values ('ch-1', 'camelbot', $1, $2)", [JSON.stringify({ type: "discord-managed", name: "Camel" }), NOW]);
  await db.query("insert into channel_agents (agent, channel, tenant, conversation) values ('bot-1', 'ch-1', 'camelbot', 'c1')");
  await db.query("insert into provider_keys (tenant, provider, sealed, last4, set_at) values ('cat', 'openai', '{}', 'abcd', $1)", [NOW]);
  await db.query("insert into oauth_grants (id, tenant, client_id, client_name, scope, created_at) values ('g1', 'ann', 'c', 'Claude', 'agents', $1)", [NOW]);
}

async function seeded() {
  const { db } = await testDatabase();
  await seed(db);
  return db;
}

test("a window is the days that end today in UTC, and only a whole number of days from 1 to 365", () => {
  assert.deepEqual({ ...adminWindow(7, NOW) }, {
    days: 7, start_date: "2026-03-14", end_date: "2026-03-20", previous_start_date: "2026-03-07", incomplete_date: "2026-03-20", time_zone: "UTC",
    from: at("2026-03-14T00:00:00Z"), previousFrom: at("2026-03-07T00:00:00Z"), until: at("2026-03-21T00:00:00Z"),
  });
  assert.equal(adminWindow("30", NOW).days, 30);
  for (const refused of [0, 366, 1.5, "7.0", "", "-1", "1e2", null, undefined]) assert.throws(() => adminWindow(refused, NOW), /whole number from 1 to 365/);
});

test("growth counts self-serve sign-ups that are not staff or erased, who did work, and who came back", async () => {
  const db = await seeded();
  const growth = await adminGrowth(db, { days: 7, now: NOW, internalDomains: STAFF });
  assert.equal(growth.accounts, 4, "Ann, Bea, Cat and the old account: not Dan (staff), Eve (erased) or the operator's");
  assert.deepEqual(growth.tiles, {
    signups: { current: 2, previous: 1 },
    activated: { current: 1, previous: 1 },
    // The 7 whole days before today (March 13 to 19), and the 7 before those.
    weekly_active: { current: 2, previous: 1 },
    weekly_returning: { current: 1, previous: 0 },
  });
  assert.deepEqual(growth.funnel, { signed_up: 2, made_agent: 1, ran_model: 1, came_back: 1 });
  assert.deepEqual(growth.previous_funnel, { signed_up: 1, made_agent: 1, ran_model: 1, came_back: 1 });
  assert.deepEqual(growth.sign_in, { github: 1, google: 1, email: 0 });
  assert.equal(growth.median_days_to_first_run, 0);
  assert.equal(growth.daily.length, 7);
  assert.deepEqual(growth.daily.find(day => day.date === "2026-03-15"), { date: "2026-03-15", signups: 1, github: 1, google: 0, email: 0, active_new: 1, active_returning: 0, accounts: 3 });
  assert.equal(growth.daily.find(day => day.date === "2026-03-19")!.active_returning, 1);
  assert.equal(growth.daily.at(-1)!.accounts, 4);

  // Twelve Monday weeks; Ann (a Sunday) and Cat signed up the week of March 9, and both did work then and the week after.
  assert.equal(growth.cohorts.length, 12);
  assert.equal(growth.cohorts.at(-1)!.week, "2026-03-16");
  assert.deepEqual(growth.cohorts.at(-2), { week: "2026-03-09", size: 2, active: [2, 2] });
  assert.deepEqual(growth.cohorts.at(-1), { week: "2026-03-16", size: 1, active: [0] });
  assert.deepEqual(growth.cohorts.find(cohort => cohort.week === "2026-01-26"), { week: "2026-01-26", size: 1, active: [0, 0, 0, 0, 0, 1, 0, 0] });

  // Without the staff domain, Dan counts.
  assert.equal((await adminGrowth(db, { days: 7, now: NOW })).tiles.signups.current, 3);
});

test("usage keeps admin tenants apart, and says which models and features agents use", async () => {
  const db = await seeded();
  const usage = await adminUsage(db, { days: 7, now: NOW, internalDomains: STAFF });
  assert.deepEqual(usage.tiles.active_accounts, { current: 2, previous: 1 });
  assert.deepEqual(usage.tiles.self_serve_responses, { current: 9, previous: 1 }, "model responses only: no web searches or compactions");
  assert.deepEqual(usage.tiles.responses, { current: 118, previous: 1 }, "with camelBot's and Dan's");
  assert.deepEqual(usage.tiles.agents_ran, { current: 3, previous: 1 });
  assert.deepEqual(usage.tiles.self_serve_agents_ran, { current: 1, previous: 0 });
  assert.deepEqual(usage.tiles.end_users, { current: 4, previous: 1 });
  assert.deepEqual(usage.tiles.self_serve_end_users, { current: 1, previous: 0 });
  assert.equal(usage.tiles.live_agents, 3, "not the deleted agent or the stateless run");
  assert.equal(usage.tiles.self_serve_live_agents, 1);
  assert.equal(usage.attempts_since, "2026-03-10T13:00:00.000Z", "per-agent figures begin at the first model attempt kept");
  assert.deepEqual(usage.daily.find(day => day.date === "2026-03-19"), { date: "2026-03-19", self_serve: 4, operator: 100, other: 0 });
  assert.deepEqual(usage.daily.find(day => day.date === "2026-03-18"), { date: "2026-03-18", self_serve: 2, operator: 0, other: 9 });

  assert.deepEqual(usage.models.map(model => [model.model, model.responses, model.self_serve_responses]),
    [["openrouter/openai/gpt-5", 100, 0], ["openai/gpt-5", 9, 0], ["anthropic/claude-sonnet-4-5", 5, 5], ["openai/gpt-5-mini", 4, 4]]);
  assert.deepEqual(usage.configured_models, [
    { model: "openrouter/openai/gpt-5", agents: 2, accounts: 1, self_serve_agents: 0, self_serve_accounts: 0 },
    { model: "anthropic/claude-sonnet-4-5", agents: 1, accounts: 1, self_serve_agents: 1, self_serve_accounts: 1 },
  ]);
  const feature = (key: string) => usage.features.find(feature => feature.key === key)!;
  assert.deepEqual([feature("web_search").agents, feature("web_search").self_serve_agents], [1, 1]);
  assert.deepEqual([feature("mcp").agents, feature("schedules").agents, feature("channel").agents], [1, 1, 1]);
  assert.deepEqual([feature("app_tools").agents, feature("definition").agents, feature("no_code_mode").agents, feature("web_fetch").self_serve_agents], [1, 1, 1, 0]);
  const integration = (key: string) => usage.integrations.find(integration => integration.key === key)!;
  assert.deepEqual(integration("discord-managed"), { key: "discord-managed", label: "Discord (managed Camel app)", accounts: 1, self_serve_accounts: 0 });
  assert.deepEqual([integration("provider_keys").self_serve_accounts, integration("mcp_clients").self_serve_accounts], [1, 1]);
  assert.deepEqual(usage.mcp_clients, [{ client: "Claude", accounts: 1 }]);

  assert.deepEqual(usage.accounts.map(account => [account.tenant, account.kind, account.staff, account.responses]),
    [["camelbot", "operator", false, 100], ["dan", "self_serve", true, 9], ["ann", "self_serve", false, 5], ["cat", "self_serve", false, 4]]);
  const ann = usage.accounts.find(account => account.tenant === "ann")!;
  assert.deepEqual([ann.name, ann.agents, ann.active_days, ann.last_active, ann.models, ann.balance], ["ann", 1, 2, "2026-03-18", ["anthropic/claude-sonnet-4-5"], 4.4 * USD]);
  assert.equal(usage.accounts.find(account => account.tenant === "dan")!.name, "dan@camelai.com");
  assert.deepEqual(usage.agents.map(agent => [agent.agent, agent.responses, agent.end_users, agent.kind, agent.account.kind]),
    [["ann-bot", 6, 1, "agent", "self_serve"], ["bot-1", 4, 3, "agent", "operator"], ["bot-2", 1, 1, "agent", "operator"]]);
});

test("an account's drill-down shows its agents' setup and the start of their prompts, never an MCP server's full address", async () => {
  const db = await seeded();
  const ann = (await adminAccount(db, "ann", { days: 7, now: NOW, internalDomains: STAFF }))!;
  assert.deepEqual(ann.account, {
    tenant: "ann", name: "ann", kind: "self_serve", sign_in: "github", signed_up_at: "2026-03-15T10:00:00.000Z",
    staff: false, deleted: false, billing: "prepaid", balance: 4.4 * USD, purchased: 0, granted: 5 * USD,
  });
  assert.deepEqual(ann.usage.models, [{ model: "anthropic/claude-sonnet-4-5", responses: 5, cost: 0.5 }]);
  assert.equal(ann.usage.responses, 5);
  assert.equal(ann.live_agents, 1);
  const [bot] = ann.agents;
  assert.deepEqual({ ...bot, system_prompt: bot.system_prompt.length }, {
    agent: "ann-bot", name: "ann-bot-name", type: "general", model: "anthropic/claude-sonnet-4-5", definition: null,
    builtins: ["web_search", "schedule"], mcp_servers: ["mcp.example.test"], openapi: 0, app_tools: 0, code_mode: true,
    schedules: 1, channel: null, responses: 6, end_users: 1, last_at: "2026-03-20T10:00:00.000Z",
    system_prompt: 1500, system_prompt_length: 3231,
  });
  assert.ok(!JSON.stringify(ann).includes("do-not-show"));
  assert.deepEqual(ann.mcp_clients, ["Claude"]);
  assert.equal((await adminAccount(db, "camelbot", { days: 7, now: NOW }))!.account.kind, "operator");
  assert.equal(await adminAccount(db, "nobody", { days: 7, now: NOW }), undefined);
});

test("a prompt's excerpt hides what looks like a credential, keeping its first characters", () => {
  const masked = maskSecrets([
    "Use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv and sk-proj-1234567890abcdefXYZ for models.",
    "GitHub: ghp_abcdefghijklmnopqrstuvwxyz0123; Slack xoxb-1234567890-abcdefghij; AWS AKIAIOSFODNN7EXAMPLE.",
    "Stripe sk_live_51HxYzAbCdEfGhIj; camelRun art_0123456789abcdef0123456789abcdef; whsec_dGhpcyBpcyBhIHNlY3JldA==",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    "Keep this: be kind, answer in English, and keep it short.",
  ].join("\n"));
  for (const secret of ["AbCdEfGhIjKl", "1234567890abcdef", "abcdefghijklmnopqrstuvwxyz0123", "1234567890-abcdefghij", "IOSFODNN7EXAMPLE", "51HxYzAbCdEfGhIj", "0123456789abcdef0123", "dGhpcyBpcyBh", "abcdefghijklmnopqrstuvwxyz012345", "MIIEow"]) {
    assert.ok(!masked.includes(secret), secret);
  }
  assert.match(masked, /sk-a…\[hidden\]/);
  assert.match(masked, /Bearer \[hidden\]/);
  assert.match(masked, /\[private key hidden\]/);
  assert.match(masked, /Keep this: be kind, answer in English, and keep it short\./);
});

test("revenue counts purchases but not staff's, and who used how much of their free credit", async () => {
  const db = await seeded();
  const revenue = await adminRevenue(db, { days: 7, now: NOW, internalDomains: STAFF });
  assert.deepEqual(revenue.tiles, {
    revenue: { current: 20 * USD, previous: 0 }, refunds: { current: 0, previous: 0 }, buyers: { current: 1, previous: 0 },
    first_purchases: { current: 1, previous: 0 }, paying_accounts: 1, auto_topup: 0,
    // Ann holds $4.40 of free credit; Cat $19 of what she bought (her free credit went first).
    outstanding_purchased: 19 * USD, outstanding_free: 4.4 * USD,
  });
  assert.equal(revenue.daily.find(day => day.date === "2026-03-19")!.amount, 20 * USD);
  assert.equal(revenue.monthly.length, 12);
  assert.deepEqual(revenue.monthly.at(-1), { month: "2026-03", amount: 20 * USD, refunds: 0, buyers: 1 });
  assert.deepEqual(revenue.spend, { paying_charged: 6 * USD, paying_provider_cost: 0.01, free_charged: 0.6 * USD, free_provider_cost: 0.52 });

  const free = revenue.free_credit;
  assert.deepEqual({ ...free, rows: free.rows.map(row => [row.tenant, row.via, row.given, row.used, row.left, row.bucket, row.purchased]) }, {
    accounts: 2, given: 10 * USD, used: 5.6 * USD,
    buckets: { untouched: 0, tried: 1, using: 0, nearly_out: 0, used_up: 1 },
    used_any: 2, bought: 1, without: 2,
    decisions: { eligible: 0, ineligible: 1, disabled: 0, legacy: 0, card_unlocked: 0 },
    // Ann's and the old account's: neither ever bought credit.
    provider_cost: 0.53,
    rows: [["cat", "card", 5 * USD, 5 * USD, 0, "used_up", 20 * USD], ["ann", "github", 5 * USD, 0.6 * USD, 4.4 * USD, "tried", 0]],
  });
  assert.deepEqual([freeCreditBucket(5 * USD, 0), freeCreditBucket(5 * USD, 2 * USD), freeCreditBucket(5 * USD, 4 * USD), freeCreditBucket(5 * USD, 4.995 * USD)], ["untouched", "using", "nearly_out", "used_up"]);
});

test("health says what the platform spent, for whom, and what is waiting longer than it should", async () => {
  const db = await seeded();
  await db.query("insert into runtime_nodes (node, session, expires_at) values ('node-a', $1, now() + interval '1 minute')", [randomUUID()]);
  const health = await adminHealth(db, { days: 7, now: NOW, internalDomains: STAFF });
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);
  close(health.spend.window.current, 0.3 + 0.2 + 0.02 + 0.01 + 0.9 + 2 + 0.03);
  close(health.spend.window.previous, 0.01);
  close(health.spend.by_payer.operator, 2.03);
  close(health.spend.by_payer.staff, 0.9);
  close(health.spend.by_payer.free, 0.52);
  close(health.spend.by_payer.paying, 0.01);
  close(health.spend.daily.find(day => day.date === "2026-03-18")!.web, 0.02);
  close(health.spend.daily.find(day => day.date === "2026-03-19")!.voice, 0.03);
  assert.deepEqual(health.spend.by_provider.map(row => row.provider), ["openrouter", "openai", "anthropic", "brave"]);
  assert.equal(health.spend.top_accounts[0].tenant, "camelbot");
  assert.equal(health.spend.top_accounts[0].payer, "operator");
  assert.equal(health.spend.own_key_responses, 4);
  close(health.spend.month_to_date, 0.3 + 0.2 + 0.02 + 0.01 + 0.04 * 0 + 0.01 + 0.01 + 0.9 + 2 + 0.03);
  const check = (key: string) => health.checks.find(check => check.key === key)!;
  assert.equal(check("nodes").status, "ok");
  assert.equal(check("schedules").status, "bad", "a schedule an hour late");
  assert.match(check("schedules").detail, /oldest for 60 min/);
  assert.equal(check("attempts").status, "warn", "a call five hours old the provider has not confirmed");
  assert.equal(check("help").status, "ok");
  // This fixture's agents are rows with no Pi storage: each counts, and any at all warns (they cannot be opened).
  assert.match(check("pi_migration").value, /^\d+ agents?$/);
  assert.equal(check("pi_migration").status, check("pi_migration").value.startsWith("0 ") ? "ok" : "warn");
  assert.equal(health.nodes.length, 1);
});

test("where sign-ups came from is read from the journey store's accounts, page by page", async t => {
  const pages: unknown[] = [];
  const item = (signup: string, source: string | null, extra: object = {}) => ({
    account_ref: randomUUID(), signup_at: signup, activated_at: null, payments: 0, events_in_range: 1, last_active_at: signup, display_name: null, email: null, summary: "",
    acquisition: { source, medium: source === "google" ? "organic" : null, campaign: null, landing_path: "/run", handoff_status: "none", capture_quality: "full" }, ...extra,
  });
  const store = await listen(t, (req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk).on("end", () => {
      const asked = JSON.parse(raw);
      pages.push(asked);
      const items = asked.cursor ? [item("2026-03-16T00:00:00Z", null), item("2026-03-01T00:00:00Z", "google")]
        : [item("2026-03-15T00:00:00Z", "google", { activated_at: "2026-03-15T01:00:00Z" }), item("2026-03-15T02:00:00Z", "google"),
          item("2026-03-17T00:00:00Z", "news.ycombinator.com", { payments: 1, acquisition: { source: "news.ycombinator.com", medium: "referral", campaign: "launch", landing_path: "/", handoff_status: "none", capture_quality: "full" } }),
          item("2026-03-18T00:00:00Z", null, { acquisition: { source: null, medium: null, campaign: null, landing_path: null, handoff_status: "none", capture_quality: "not_applicable" } })];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        schema_version: 1, kind: "journeys", range: { start_date: asked.start_date, end_date: asked.end_date, time_zone: asked.time_zone },
        generated_at: new Date(NOW).toISOString(), coverage: { first_event_at: "2026-03-01T00:00:00Z", last_event_at: "2026-03-20T00:00:00Z" },
        items, next_cursor: asked.cursor ? null : "page-2",
      }));
    });
  });
  const source = { url: `${store}/api/journey/admin-report`, secret: `whsec_${Buffer.from("admin-test-report-signing-key-012").toString("base64")}` };
  const acquisition = await adminAcquisition(source, { days: 7, now: NOW });
  assert.deepEqual(pages.map(page => (page as { cursor?: string }).cursor ?? null), [null, "page-2"]);
  assert.deepEqual((pages[0] as object), { schema_version: 1, kind: "journeys", start_date: "2026-03-14", end_date: "2026-03-20", time_zone: "UTC" });
  assert.equal(acquisition.status, "ok");
  assert.equal(acquisition.tracked_signups, 5, "not the account that signed up before the window");
  assert.deepEqual(acquisition.sources, [
    { source: "google", medium: "organic", signups: 2, activated: 1, paying: 0 },
    { source: "news.ycombinator.com", medium: "referral", signups: 1, activated: 0, paying: 1 },
    { source: "No browser (API or MCP)", medium: null, signups: 1, activated: 0, paying: 0 },
    { source: "Not captured", medium: null, signups: 1, activated: 0, paying: 0 },
  ]);
  assert.deepEqual(acquisition.campaigns, [{ campaign: "launch", signups: 1 }]);
  assert.deepEqual(acquisition.landing_pages, [{ path: "/run", signups: 3 }, { path: "/", signups: 1 }]);
  assert.equal(acquisition.truncated, false);

  assert.equal((await adminAcquisition(undefined, { days: 7, now: NOW })).status, "not_configured");
  assert.equal((await adminAcquisition({ ...source, url: "http://127.0.0.1:9/api/journey/admin-report" }, { days: 7, now: NOW })).status, "unavailable");
});

/** The site as the runtime mounts it, before the runtime's own routes (which answer "runtime" here). */
async function ops(t: T, options: Partial<AdminSiteOptions> = {}) {
  const { db } = await testDatabase();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "RS256" }] });
  const consoleDir = await mkdtemp(join(tmpdir(), "admin-ops-"));
  await writeFile(join(consoleDir, "admin.html"), "<html><head><title>ops</title></head></html>");
  await writeFile(join(consoleDir, OPS_ICON), "<svg/>");
  const app = new Hono();
  app.use(adminSite({ host: "run.example.test", path: "/ops", team: TEAM, audience: AUD, db, consoleDir, keys, ...options }));
  app.all("*", c => c.text("runtime"));
  const token = (claims: { aud?: string } = {}) => new SignJWT({ email: "ops@example.test" }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(TEAM).setAudience(claims.aud ?? AUD).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const call = async (path: string, init: { token?: string | null; host?: string; method?: string; headers?: Record<string, string> } = {}) => {
    const signedIn = init.token === null ? undefined : init.token ?? await token();
    const response = await app.request(`http://${init.host ?? "run.example.test"}${path}`, {
      method: init.method ?? "GET", headers: { host: init.host ?? "run.example.test", ...(signedIn ? { "cf-access-jwt-assertion": signedIn } : {}), ...init.headers }, redirect: "manual",
    });
    return {
      status: response.status, text: await response.text(), location: response.headers.get("location"), type: response.headers.get("content-type"),
      cache: response.headers.get("cache-control"), nosniff: response.headers.get("x-content-type-options"),
    };
  };
  return { db, call, token, privateKey };
}

test("on a path of the runtime's hostname, the site is that path alone, and all of it needs Access's token", async t => {
  const { call, token, db, privateKey } = await ops(t);
  await seed(db);
  // Access always sets an expiry: a token without one is not taken.
  const lasting = await new SignJWT({ email: "ops@example.test" }).setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer(TEAM).setAudience(AUD).setIssuedAt().sign(privateKey);
  assert.equal((await call("/ops/api/me", { token: lasting })).status, 401);
  const paths = ["/ops", "/ops/", "/ops/api/growth", "/ops/api/usage", "/ops/api/mcp", "/ops/api/revenue", "/ops/api/health", "/ops/api/acquisition", "/ops/api/account?tenant=ann", "/ops/api/me", "/ops/favicon.svg", "/ops/anything"];
  for (const path of paths) {
    assert.equal((await call(path, { token: null })).status, 401, path);
    assert.equal((await call(path, { token: await token({ aud: "another-application" }) })).status, 401, path);
  }
  // The runtime's own paths, including ones that only look like the site's, stay the runtime's, signed in or not.
  for (const path of ["/", "/api/growth", "/opsx", "/ops.json", "/OPS/api/growth", "/console/assets/admin.js", "/console/ops-favicon.svg"]) assert.equal((await call(path)).text, "runtime", path);
  // And the site is not on the runtime's other hostnames.
  assert.equal((await call("/ops/api/growth", { host: "agents.example.test" })).text, "runtime");

  const redirect = await call("/ops?tab=usage");
  assert.deepEqual([redirect.status, redirect.location], [308, "/ops/?tab=usage"]);
  const page = await call("/ops/");
  assert.equal(page.text, '<html><head><title>ops</title><meta name="admin-base" content="/ops"></head></html>');
  assert.equal((await call("/ops/usage")).text, page.text, "any other page address is the page");
  assert.equal((await call("/ops/favicon.svg")).text, "<svg/>");
  assert.equal(JSON.parse((await call("/ops/api/me")).text).viewer, "ops@example.test");
  for (const tab of ["growth", "usage", "revenue", "health", "mcp"]) {
    const answer = await call(`/ops/api/${tab}?days=7`);
    assert.equal(answer.status, 200, tab);
    assert.equal(JSON.parse(answer.text).range.days, 7);
    assert.equal((await call(`/ops/api/${tab}?days=0`)).status, 400);
  }
  const mcp = JSON.parse((await call("/ops/api/mcp?days=7")).text);
  assert.equal(mcp.schema_version, 1);
  assert.equal(mcp.daily.length, 28);
  assert.deepEqual(mcp.funnel.map((row: { kind: string }) => row.kind), ["chatgpt", "codex", "claude", "other"]);
  assert.equal(mcp.limitations.length, 4);
  assert.equal(JSON.parse((await call("/ops/api/acquisition")).text).status, "not_configured");
  assert.equal(JSON.parse((await call("/ops/api/account?tenant=ann&days=7")).text).account.tenant, "ann");
  assert.equal((await call("/ops/api/account?tenant=nobody")).status, 404);
  assert.equal((await call("/ops/api/account?tenant=a%20b")).status, 400);
  assert.equal((await call("/ops/api/nothing")).status, 404);
  assert.equal((await call("/ops/api/growth", { method: "DELETE" })).status, 404);

  // Another site's page cannot have an admin's browser ask for figures; the site's own page, or an address typed in, can.
  for (const site of ["cross-site", "same-site"]) assert.equal((await call("/ops/api/growth", { headers: { "sec-fetch-site": site } })).status, 403, site);
  for (const site of ["same-origin", "none"]) assert.equal((await call("/ops/api/me", { headers: { "sec-fetch-site": site } })).status, 200, site);
  assert.equal((await call("/ops/", { headers: { "sec-fetch-site": "cross-site" } })).status, 200, "a link to the page from elsewhere opens it");
  // Nothing it answers is cached, but its icon; and nothing is sniffed.
  for (const path of ["/ops", "/ops/", "/ops/api/me", "/ops/api/nothing", "/ops/api/growth?days=0"]) {
    const answered = await call(path);
    assert.deepEqual([answered.cache, answered.nosniff], ["no-store", "nosniff"], path);
  }
  assert.deepEqual([(await call("/ops/favicon.svg")).cache, (await call("/ops", { token: null })).cache], ["public, max-age=3600", "no-store"]);
});

test("where the deployment names its admins, Access signing someone else in opens nothing", async t => {
  const { call, token, privateKey } = await ops(t, { admins: ["ops@example.test", "second@example.test"] });
  const as = (email: string) => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "fixture" }).setIssuer(TEAM).setAudience(AUD).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  for (const path of ["/ops/", "/ops/api/me", "/ops/api/growth", "/ops/api/account?tenant=ann", "/ops/favicon.svg"]) {
    for (const email of ["intruder@example.test", "support@example.test", "ops@example.test.evil", "ops@example.test "]) {
      const refused = await call(path, { token: await as(email) });
      assert.deepEqual([refused.status, refused.cache], [403, "no-store"], `${email} ${path}`);
    }
  }
  assert.equal(JSON.parse((await call("/ops/api/me", { token: await token() })).text).viewer, "ops@example.test");
  assert.equal((await call("/ops/api/me", { token: await as("Second@Example.test") })).status, 200, "addresses match whatever their case");
  assert.equal((await call("/api/me", { token: await as("intruder@example.test") })).text, "runtime", "the runtime's own paths are not the site's to refuse");
});

test("the site's address is checked, and the runtime's hostname is never the site's whole", () => {
  const access = { AGENT_ADMIN_ACCESS_TEAM: TEAM, AGENT_ADMIN_ACCESS_AUD: AUD };
  const context = { db: undefined as never, consoleDir: "", runtimeHosts: ["run.example.test", "agents.example.test"] };
  assert.deepEqual(adminSiteFromEnvironment({ ...access, AGENT_ADMIN_URL: "https://run.example.test/ops" }, context),
    { host: "run.example.test", path: "/ops", team: TEAM, audience: AUD, db: undefined, consoleDir: "", tracking: false });
  for (const url of ["https://run.example.test", "https://run.example.test/", "https://RUN.example.test"]) {
    assert.throws(() => adminSiteFromEnvironment({ ...access, AGENT_ADMIN_URL: url }, context), /give AGENT_ADMIN_URL a path/, url);
  }
  // The older setting names a hostname of its own only: a runtime from before paths reads it as the whole hostname.
  assert.throws(() => adminSiteFromEnvironment({ ...access, AGENT_ADMIN_HOST: "run.example.test" }, context), /give AGENT_ADMIN_URL a path/);
  assert.equal(adminSiteFromEnvironment({ ...access, AGENT_ADMIN_URL: "https://run.example.test/admin" }, context)!.path, "/admin");
  for (const url of ["run.example.test/ops", "http://run.example.test/ops", "https://run.example.test/ops/", "https://run.example.test/Ops", "https://run.example.test/ops/admin",
    "https://run.example.test/v1", "https://run.example.test/console", "https://run.example.test/api", "https://run.example.test/channels", "https://run.example.test/dashboard",
    "https://run.example.test/ops?x=1", "https://run.example.test/ops#x",
    "https://run.example.test:8443/ops", "https://user@run.example.test/ops", "https://run.example.test/%6Fps"]) {
    assert.throws(() => adminSiteFromEnvironment({ ...access, AGENT_ADMIN_URL: url }, context), /AGENT_ADMIN_URL must be/, url);
  }
  assert.throws(() => adminSiteFromEnvironment({ ...access, AGENT_ADMIN_URL: "https://run.example.test/ops", AGENT_ADMIN_HOST: "admin.example.test" }, context), /not both/);
  assert.throws(() => adminSiteFromEnvironment({ AGENT_ADMIN_URL: "https://run.example.test/ops" }, context), /together, or none of them/);
  assert.throws(() => adminSiteFromEnvironment(access, context), /together, or none of them/);
  // A hostname of its own needs no path, either way it is named; staff domains come from journey events' setting.
  const own = adminSiteFromEnvironment({ ...access, AGENT_ADMIN_URL: "https://admin.example.test", AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS: "CamelAI.com, camelqa.com" }, context)!;
  assert.deepEqual([own.host, own.path, own.internalDomains], ["admin.example.test", undefined, ["camelai.com", "camelqa.com"]]);
  assert.equal(adminSiteFromEnvironment({ ...access, AGENT_ADMIN_HOST: "admin.example.test" }, context)!.host, "admin.example.test");
  // The admins, as a second lock beside the Access policy.
  const site = { ...access, AGENT_ADMIN_URL: "https://run.example.test/ops" };
  assert.deepEqual(adminSiteFromEnvironment({ ...site, AGENT_ADMIN_EMAILS: " Illiana@CamelAI.com, miguel@camelai.com ,," }, context)!.admins, ["illiana@camelai.com", "miguel@camelai.com"]);
  assert.equal(adminSiteFromEnvironment({ ...site, AGENT_ADMIN_EMAILS: "" }, context)!.admins, undefined);
  for (const emails of ["illiana", "illiana@camelai", "a b@camelai.com", "@camelai.com"]) assert.throws(() => adminSiteFromEnvironment({ ...site, AGENT_ADMIN_EMAILS: emails }, context), /AGENT_ADMIN_EMAILS must be/, emails);
});
