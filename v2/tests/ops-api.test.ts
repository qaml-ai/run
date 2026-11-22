import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import type {
  AdminAccountDetail,
  AdminAcquisition,
  AdminGrowth,
  AdminHealth,
  AdminMcp,
  AdminRevenue,
  AdminSignals,
  AdminTrend,
  AdminUsage,
} from "../../shared/ops-types.ts";

const ADMIN_KEY = "test-admin-secret-ops-api";
const VAULT_SECRET = "test-vault-secret-ops-api";

test("v2-native /v2/admin/ops/* aggregates DO tenants, probes camelfsd, inspects agents, and applies operator controls", async (t) => {
  // Spin up a local fake camelfsd health server
  const healthServer = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => healthServer.listen(0, "127.0.0.1", resolve));
  t.after(() => healthServer.close());
  const addr = healthServer.address();
  assert.ok(addr && typeof addr === "object");
  const camelfsUrl = `http://127.0.0.1:${addr.port}`;

  const dir = mkdtempSync(join(tmpdir(), "camelrun-ops-api-"));
  const config = join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "ops-api-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: ADMIN_KEY,
        VAULT_SECRET,
        CAMELFS_URL: camelfsUrl,
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());

  const adminReq = (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    worker.fetch(`https://ops-api.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        "X-Admin-Key": ADMIN_KEY,
        "X-Ops-Viewer": "miguel@camelai.com",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(15_000),
    });

  // 0. Unauthenticated requests to /v2/admin/ops/* are rejected with 401
  const unauth = await worker.fetch("https://ops-api.test/v2/admin/ops/me");
  assert.equal(unauth.status, 401);

  // 1. Provision tenants across all flows:
  //    a) GitHub OAuth self-serve user (external)
  const ghRes = await adminReq("/v2/admin/console/oauth-login", {
    method: "POST",
    body: JSON.stringify({
      provider: "github",
      externalId: "1001",
      email: "ann@example.com",
      login: "ann-dev",
      name: "Ann Developer",
    }),
  });
  assert.equal(ghRes.status, 200);
  const ann = (await ghRes.json()) as { tenantId: string; apiKey: string };

  //    b) Staff Google OAuth user (@camelai.com — excluded from self-serve growth counts, marked staff)
  const staffRes = await adminReq("/v2/admin/console/oauth-login", {
    method: "POST",
    body: JSON.stringify({
      provider: "google",
      externalId: "staff-sub-1",
      email: "alex@camelai.com",
      name: "Alex Team",
    }),
  });
  assert.equal(staffRes.status, 200);

  //    c) Operator-created tenant (e.g. camel-bots style) via POST /v2/tenants + explicit register-tenant
  const botRes = await adminReq("/v2/tenants", {
    method: "POST",
    body: JSON.stringify({ name: "camel-bots", initialCreditsUsd: 50, kind: "operator" }),
  });
  assert.equal(botRes.status, 201);
  const bot = (await botRes.json()) as { tenantId: string; apiKey: string };

  // Explicitly re-registering existing tenant works idempotently
  const regRes = await adminReq("/v2/admin/ops/register-tenant", {
    method: "POST",
    body: JSON.stringify({ tenantId: bot.tenantId, name: "camel-bots", kind: "operator" }),
  });
  assert.equal(regRes.status, 200);

  // 2. Grant Ann credits and create an agent + run a mock turn so usage_daily has live data
  const topupRes = await adminReq("/v2/admin/ops/account/credits", {
    method: "POST",
    body: JSON.stringify({ tenantId: ann.tenantId, amountUsd: 25, note: "Welcome topup" }),
  });
  assert.equal(topupRes.status, 200);
  assert.equal(((await topupRes.json()) as { balanceUsd: number }).balanceUsd, 25);

  const agentRes = await worker.fetch("https://ops-api.test/v2/agents/research-helper", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ann.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "mock/echo",
      instructions: "You help Ann. Secret key sk-ant-1234567890abcdefghijklmnop should be hidden.",
      builtins: ["web_search"],
      prompt: "Hello ops test!",
      wait: true,
    }),
  });
  assert.equal(agentRes.status, 201);

  // Run a second turn on Ann's agent + a turn on operator camel-bots so per-agent responses > 1 and operator visibility are verified
  const secondRunRes = await worker.fetch("https://ops-api.test/v2/agents/research-helper/runs", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ann.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: "Second turn for response count check",
      wait: true,
    }),
  });
  assert.equal(secondRunRes.status, 200);

  const botAgentRes = await worker.fetch("https://ops-api.test/v2/agents/bot-worker", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${bot.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "mock/echo",
      instructions: "Operator bot agent",
      builtins: ["web_fetch"],
      prompt: "Hello from camel-bots!",
      wait: true,
    }),
  });
  assert.equal(botAgentRes.status, 201);

  // 3. Check /v2/admin/ops/me
  const meRes = await adminReq("/v2/admin/ops/me");
  assert.equal(meRes.status, 200);
  assert.deepEqual(await meRes.json(), { viewer: "miguel@camelai.com" });

  // 4. Check /v2/admin/ops/growth
  const growthRes = await adminReq("/v2/admin/ops/growth?days=30");
  assert.equal(growthRes.status, 200);
  const growth = (await growthRes.json()) as AdminGrowth;
  assert.equal(growth.accounts, 1); // Only Ann (not staff Alex, not operator camel-bots)
  assert.equal(growth.tiles.signups.current, 1);
  assert.equal(growth.sign_in.github, 1);
  assert.equal(growth.funnel.signed_up, 1);
  assert.equal(growth.funnel.made_agent, 1);
  assert.equal(growth.funnel.ran_model, 1);
  assert.equal(growth.cohorts.length, 12);

  // 5. Check /v2/admin/ops/acquisition
  const acqRes = await adminReq("/v2/admin/ops/acquisition?days=30");
  assert.equal(acqRes.status, 200);
  const acq = (await acqRes.json()) as AdminAcquisition;
  assert.equal(acq.total.signups, 1);
  assert.equal(acq.total.activated, 1);
  assert.equal(acq.sources[0]?.kind, "not_captured");

  // 6. Check /v2/admin/ops/usage
  const usageRes = await adminReq("/v2/admin/ops/usage?days=30");
  assert.equal(usageRes.status, 200);
  const usage = (await usageRes.json()) as AdminUsage;
  assert.equal(usage.tiles.active_accounts.current, 1);
  assert.equal(usage.tiles.all_active_accounts?.current, 2);
  assert.ok(usage.tiles.responses.current >= 3);
  assert.equal(usage.tiles.self_serve_responses.current, 2);
  assert.equal(usage.tiles.live_agents, 2);
  assert.equal(usage.tiles.self_serve_live_agents, 1);
  assert.equal(usage.tiles.agents_ran.current, 2);
  assert.equal(usage.tiles.self_serve_agents_ran.current, 1);
  assert.ok(usage.attempts_since !== null, "attempts_since must be populated when runs exist");
  assert.ok(usage.configured_models.some((m) => m.model === "mock/echo" && m.agents === 2 && m.self_serve_agents === 1));
  assert.ok(usage.features.some((f) => f.key === "web_search" && f.agents === 1 && f.self_serve_agents === 1));
  assert.ok(usage.features.some((f) => f.key === "web_fetch" && f.agents === 1 && f.self_serve_agents === 0));
  assert.ok(usage.accounts.some((a) => a.tenant === ann.tenantId && a.kind === "self_serve" && a.responses === 2));
  assert.ok(usage.accounts.some((a) => a.tenant === bot.tenantId && a.kind === "operator" && a.responses === 1));
  const annTopAgent = usage.agents.find((a) => a.name === "research-helper");
  assert.ok(annTopAgent, "expected research-helper in top agents");
  assert.equal(annTopAgent.responses, 2, "per-agent responses must reflect actual settled runs, not 0");

  // 7. Check /v2/admin/ops/revenue (including micros vs USD unit invariants!)
  const revRes = await adminReq("/v2/admin/ops/revenue?days=30");
  assert.equal(revRes.status, 200);
  const rev = (await revRes.json()) as AdminRevenue;
  assert.equal(rev.tiles.revenue.current, 25 * 1_000_000);
  assert.equal(rev.tiles.buyers.current, 1);
  assert.equal(rev.tiles.paying_accounts, 1);
  assert.equal(rev.monthly.length, 12);
  assert.equal(rev.spend.paying_charged, Math.round(rev.spend.paying_provider_cost * 1_000_000));
  assert.equal(rev.spend.free_charged, Math.round(rev.spend.free_provider_cost * 1_000_000));

  // 8. Check /v2/admin/ops/health (including live camelfsd health probe!)
  const healthRes = await adminReq("/v2/admin/ops/health?days=30");
  assert.equal(healthRes.status, 200);
  const health = (await healthRes.json()) as AdminHealth;
  const camelfsCheck = health.checks.find((c) => c.key === "camelfsd");
  assert.ok(camelfsCheck, "expected camelfsd health check");
  assert.equal(camelfsCheck.status, "ok");
  assert.match(camelfsCheck.value, /ms$/);
  const tenantsCheck = health.checks.find((c) => c.key === "tenants_registry");
  assert.equal(tenantsCheck?.status, "ok");
  assert.equal(tenantsCheck?.value, "3 / 3");

  // 9. Check /v2/admin/ops/mcp (clean empty response without errors)
  const mcpRes = await adminReq("/v2/admin/ops/mcp?days=30");
  assert.equal(mcpRes.status, 200);
  const mcp = (await mcpRes.json()) as AdminMcp;
  assert.equal(mcp.funnel.length, 4);
  assert.ok(mcp.limitations.length > 0);

  // 10. Check /v2/admin/ops/account detail + AgentDO hydration + real per-agent run counts + secret masking + tier/cap update
  const acctRes = await adminReq(`/v2/admin/ops/account?tenant=${encodeURIComponent(ann.tenantId)}&days=30`);
  assert.equal(acctRes.status, 200);
  const acct = (await acctRes.json()) as AdminAccountDetail;
  assert.equal(acct.account.tenant, ann.tenantId);
  assert.equal(acct.live_agents, 1);
  assert.equal(acct.agents.length, 1);
  assert.equal(acct.agents[0]?.name, "research-helper");
  assert.equal(acct.agents[0]?.responses, 2, "AccountDialog agent responses must match actual run count");
  assert.ok(acct.agents[0]?.system_prompt.includes("sk-a…[hidden]"), "secret in system prompt must be masked");
  assert.ok(!acct.agents[0]?.system_prompt.includes("1234567890"));

  const patchRes = await adminReq("/v2/admin/ops/account", {
    method: "PATCH",
    body: JSON.stringify({ tenantId: ann.tenantId, tier: "enterprise", monthlyCapUsd: 2500 }),
  });
  assert.equal(patchRes.status, 200);
  const acctAfter = (await (await adminReq(`/v2/admin/ops/account?tenant=${encodeURIComponent(ann.tenantId)}&days=30`)).json()) as AdminAccountDetail;
  assert.equal(acctAfter.account.tier, "enterprise");
  assert.equal(acctAfter.account.monthly_cap_usd, 2500);

  // 11. Unknown tenant -> 404 account_not_found
  const missing = await adminReq("/v2/admin/ops/account?tenant=tnt_does_not_exist&days=30");
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "account_not_found" });

  // 12. Journeys endpoints work gracefully
  const sigRes = await adminReq("/v2/admin/ops/product-signals");
  assert.equal(sigRes.status, 200);
  const sig = (await sigRes.json()) as AdminSignals;
  assert.equal(sig.summary.signups, 1);

  const trendRes = await adminReq("/v2/admin/ops/activity-trend?days=14");
  assert.equal(trendRes.status, 200);
  const trend = (await trendRes.json()) as AdminTrend;
  assert.equal(trend.daily.length, 14);

  const reportRes = await adminReq("/v2/admin/ops/report", { method: "POST", body: JSON.stringify({ kind: "journeys" }) });
  assert.equal(reportRes.status, 503);
  assert.deepEqual(await reportRes.json(), { error: "report_not_configured" });
});
