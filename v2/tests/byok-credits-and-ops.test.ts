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
  AdminRevenue,
} from "../../shared/ops-types.ts";

const ADMIN_KEY = "test-admin-secret-byok-ops";
const VAULT_SECRET = "test-vault-secret-byok-ops-32bytes";

test("BYOK zero-balance bypass, dual free-credit policy, operator revenue exclusion, and signup_source acquisition", async (t) => {
  let anthropicCalls = 0;
  let vmExecCalls = 0;

  const mockUpstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      res.setHeader("Content-Type", "application/json");

      // Fake camelfsd endpoints for bash VM billing check
      if (url === "/healthz") {
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url === "/v1/lineages" && req.method === "POST") {
        res.end(JSON.stringify({ lineage: "lin_byok_test", defaultRef: "refs/heads/main", commit: "c0", tree: "t0" }));
        return;
      }
      if (url === "/v1/vms" && req.method === "POST") {
        res.end(
          JSON.stringify({
            vmId: "vm_byok_1",
            lineage: "lin_byok_test",
            ref: "refs/heads/main",
            holder: "agent",
            state: "running",
            headCommit: "c0",
            leaseExpiresAt: Date.now() + 600_000,
          }),
        );
        return;
      }
      if (url === "/v1/vms/vm_byok_1/exec" && req.method === "POST") {
        vmExecCalls++;
        // 100,000 ms (100 VM seconds) @ $0.05 / 1000s = $0.005 exact VM infra charge
        res.end(
          JSON.stringify({
            execId: String(body.execId ?? "exec_1"),
            exitCode: 0,
            stdout: "hello from vm\n",
            stderr: "",
            cwd: "/workspace",
            timedOut: false,
            durationMs: 100_000,
            billableMs: 100_000,
            commit: { changed: false, commit: "c0", tree: "t0", filesChanged: [] },
          }),
        );
        return;
      }

      // Mock Anthropic Messages API for BYOK run (1st call triggers bash tool; 2nd returns final text)
      if (url.includes("/v1/messages")) {
        anthropicCalls++;
        const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : [];
        const hasToolResult = messages.some(
          (m) =>
            m.role === "user" &&
            Array.isArray(m.content) &&
            (m.content as Array<{ type?: string }>).some((b) => b.type === "tool_result"),
        );
        const tools = Array.isArray(body.tools) ? body.tools : [];
        if (tools.length > 0 && !hasToolResult) {
          res.end(
            JSON.stringify({
              stop_reason: "tool_use",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_bash_1",
                  name: "bash",
                  input: { command: "echo hi" },
                },
              ],
              usage: { input_tokens: 1_000, output_tokens: 100 },
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            stop_reason: "end_turn",
            content: [{ type: "text", text: "BYOK run succeeded!" }],
            usage: { input_tokens: 2_000, output_tokens: 200 },
          }),
        );
        return;
      }

      // Platform Azure endpoint (should NEVER be reached by $0 Google tenant!)
      if (url.includes("/openai/v1/responses")) {
        res.end(
          JSON.stringify({
            output: [{ type: "message", content: [{ type: "output_text", text: "platform ok" }] }],
            usage: { input_tokens: 50, output_tokens: 20 },
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found", url }));
    });
  });

  await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    mockUpstream.closeAllConnections();
    mockUpstream.close();
  });
  const port = (mockUpstream.address() as { port: number }).port;
  const upstreamUrl = `http://127.0.0.1:${port}`;

  const dir = mkdtempSync(join(tmpdir(), "camelrun-byok-ops-"));
  const config = join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "byok-credits-ops-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: ADMIN_KEY,
        VAULT_SECRET,
        CAMELFS_URL: upstreamUrl,
        CAMELFS_DEV_TOKEN: "dev-token",
        DEFAULT_MODEL: "azure/gpt-6.1-terra",
        AZURE_OPENAI_SOL_ENDPOINT: upstreamUrl,
        AZURE_OPENAI_SOL_API_KEY: "platform-azure-key",
        ANTHROPIC_API_KEY: "platform-anthropic-key",
      },
      r2_buckets: [{ binding: "MEDIA_BUCKET", bucket_name: "test-media-bucket" }],
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

  const adminReq = (path: string, init: { method?: string; body?: unknown } = {}) =>
    worker.fetch(`https://byok-ops.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        "X-Admin-Key": ADMIN_KEY,
        "X-Ops-Viewer": "ops@camelai.com",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });

  const tenantReq = (apiKey: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    worker.fetch(`https://byok-ops.test${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });

  // 1. Provision self-serve tenants across all 3 auth methods with distinct signup sources:
  //    a) Google self-serve user -> $0 platform LLM credit, $5 BYOK infra-only credit, ref=run-slack
  const googleRes = await adminReq("/v2/admin/console/oauth-login", {
    method: "POST",
    body: {
      provider: "google",
      externalId: "goog-byok-1",
      email: "byok-user@gmail.com",
      name: "BYOK Gmail User",
      signupSource: { ref: "run-slack", from: "www.news.ycombinator.com" },
    },
  });
  assert.equal(googleRes.status, 200);
  const googleUser = (await googleRes.json()) as { tenantId: string; apiKey: string; created: boolean };
  assert.equal(googleUser.created, true);

  //    b) GitHub self-serve user -> $5 platform LLM grant + $5 BYOK infra credit, referrer=news.ycombinator.com
  const githubRes = await adminReq("/v2/admin/console/oauth-login", {
    method: "POST",
    body: {
      provider: "github",
      externalId: "gh-starter-1",
      email: "octo@example.com",
      login: "octodev",
      name: "Octo Dev",
      signupSource: { from: "www.news.ycombinator.com" },
    },
  });
  assert.equal(githubRes.status, 200);
  const githubUser = (await githubRes.json()) as { tenantId: string; apiKey: string; created: boolean };
  assert.equal(githubUser.created, true);

  //    c) Email self-serve user -> $0 platform LLM credit, $5 BYOK infra credit, direct {}
  const emailRes = await adminReq("/v2/admin/console/password-signup", {
    method: "POST",
    body: {
      email: "direct@example.com",
      password: "correct-horse-battery",
      name: "Direct User",
      signupSource: {},
    },
  });
  assert.equal(emailRes.status, 201);
  const emailUser = (await emailRes.json()) as { tenantId: string; apiKey: string; created: boolean };
  assert.equal(emailUser.created, true);

  //    d) Legacy self-serve user with NO signupSource -> not_captured
  const legacyRes = await adminReq("/v2/admin/console/oauth-login", {
    method: "POST",
    body: {
      provider: "google",
      externalId: "goog-legacy-1",
      email: "legacy@gmail.com",
      name: "Legacy User",
    },
  });
  assert.equal(legacyRes.status, 200);

  //    e) Operator & operator_made tenants with large topups (MUST be excluded from Revenue tab!)
  const opRes = await adminReq("/v2/tenants", {
    method: "POST",
    body: { name: "camel-bots", initialCreditsUsd: 0, kind: "operator" },
  });
  assert.equal(opRes.status, 201);
  const opTenant = (await opRes.json()) as { tenantId: string };
  assert.equal(
    (
      await adminReq("/v2/admin/ops/account/credits", {
        method: "POST",
        body: { tenantId: opTenant.tenantId, amountUsd: 146.77, note: "Internal reserve topup" },
      })
    ).status,
    200,
  );

  const opMadeRes = await adminReq("/v2/tenants", {
    method: "POST",
    body: { name: "internal-canary", initialCreditsUsd: 0, kind: "operator_made" },
  });
  assert.equal(opMadeRes.status, 201);
  const opMadeTenant = (await opMadeRes.json()) as { tenantId: string };
  assert.equal(
    (
      await adminReq("/v2/admin/ops/account/credits", {
        method: "POST",
        body: { tenantId: opMadeTenant.tenantId, amountUsd: 50, note: "Canary topup" },
      })
    ).status,
    200,
  );

  // Verify initial balances + infra credits for all 3 self-serve signup types
  const googleBilling0 = (await (await tenantReq(googleUser.apiKey, "/v2/billing")).json()) as {
    balanceUsd: number;
    infraCreditUsd?: number;
  };
  assert.equal(googleBilling0.balanceUsd, 0, "Google signup must start at $0 platform LLM credit");
  assert.equal(googleBilling0.infraCreditUsd, 5, "Google signup must start with $5 BYOK infra credit");

  const emailBilling0 = (await (await tenantReq(emailUser.apiKey, "/v2/billing")).json()) as {
    balanceUsd: number;
    infraCreditUsd?: number;
  };
  assert.equal(emailBilling0.balanceUsd, 0, "Email signup must start at $0 platform LLM credit");
  assert.equal(emailBilling0.infraCreditUsd, 5, "Email signup must start with $5 BYOK infra credit");

  const githubBilling0 = (await (await tenantReq(githubUser.apiKey, "/v2/billing")).json()) as {
    balanceUsd: number;
    infraCreditUsd?: number;
    recent: Array<{ kind: string; amountUsd: number }>;
  };
  assert.equal(githubBilling0.balanceUsd, 5, "GitHub signup must receive $5 platform starter grant");
  assert.equal(githubBilling0.infraCreditUsd, 5, "GitHub signup must also receive $5 BYOK infra credit");
  assert.equal(githubBilling0.recent[0]?.kind, "grant", "GitHub starter credit must be recorded as kind=grant");

  // 2. $0 Google tenant trying a PLATFORM LLM MUST still get insufficient_credits (cannot use infraCreditUsd!)
  const platAgentRes = await tenantReq(googleUser.apiKey, "/v2/agents/platform-blocked", {
    method: "PUT",
    body: {
      model: "azure/gpt-6.1-terra",
      builtins: [],
      prompt: "Try platform model at $0",
      wait: true,
    },
  });
  assert.equal(platAgentRes.status, 201);
  const platAgent = (await platAgentRes.json()) as {
    id: string;
    run: { status: string; error: { code: string } | null };
  };
  assert.equal(platAgent.run.status, "failed");
  assert.equal(platAgent.run.error?.code, "insufficient_credits");

  // Verify AgentDO.getOpsRunStats does NOT miscount insufficient_credits failure as a response
  const acctBeforeByok = (await (
    await adminReq(`/v2/admin/ops/account?tenant=${encodeURIComponent(googleUser.tenantId)}&days=30`)
  ).json()) as AdminAccountDetail;
  const blockedAgentView = acctBeforeByok.agents.find((a) => a.name === "platform-blocked");
  assert.ok(blockedAgentView, "expected platform-blocked agent in account detail");
  assert.equal(blockedAgentView.responses, 0, "insufficient_credits failure must NOT count as a response");

  // 3. Configure BYOK Anthropic key on the SAME $0 Google tenant and run an agent with bash VM tool!
  assert.equal(
    (
      await tenantReq(googleUser.apiKey, "/v2/providers/anthropic", {
        method: "PUT",
        body: {
          apiKey: "sk-ant-user-byok-key",
          baseUrl: upstreamUrl,
        },
      })
    ).status,
    200,
  );

  const byokAgentRes = await tenantReq(googleUser.apiKey, "/v2/agents/byok-claude", {
    method: "PUT",
    body: {
      model: "anthropic/claude-sonnet-4",
      builtins: ["bash"],
      prompt: "Run bash and say hello",
      wait: true,
    },
  });
  assert.equal(byokAgentRes.status, 201);
  const byokAgent = (await byokAgentRes.json()) as {
    id: string;
    run: {
      status: string;
      text: string;
      usage: { inputTokens: number; outputTokens: number; vmMs: number; byok?: boolean };
    };
  };
  assert.equal(byokAgent.run.status, "completed");
  assert.equal(byokAgent.run.text, "BYOK run succeeded!");
  assert.equal(byokAgent.run.usage.byok, true);
  assert.equal(byokAgent.run.usage.vmMs, 100_000);
  assert.equal(vmExecCalls, 1);
  assert.equal(anthropicCalls, 2);

  // Check billing after BYOK run:
  // - balanceUsd stays EXACTLY $0.00 (never debited for BYOK LLM tokens, never driven negative!)
  // - infraCreditUsd was debited by exactly $0.005 (100 VM seconds @ $0.05/1000s) -> $4.995
  const googleBilling1 = (await (await tenantReq(googleUser.apiKey, "/v2/billing")).json()) as {
    balanceUsd: number;
    infraCreditUsd?: number;
    usage: Array<{ model: string; runsCount: number; costUsd: number }>;
  };
  assert.equal(googleBilling1.balanceUsd, 0, "BYOK run must NOT debit balanceUsd or drive it negative");
  assert.equal(googleBilling1.infraCreditUsd, 4.995, "BYOK VM infra cost must draw from infraCreditUsd");
  const byokUsageRow = googleBilling1.usage.find((u) => u.model === "anthropic/claude-sonnet-4");
  assert.ok(byokUsageRow, "BYOK run must still be recorded in usage_daily");
  assert.equal(byokUsageRow.runsCount, 1);
  assert.equal(byokUsageRow.costUsd, 0, "BYOK platform ledger costUsd must be $0 when infra credit covers VM");

  // 4. Verify Ops Growth + Health accurately count BYOK activation and own_key_responses
  const growth = (await (await adminReq("/v2/admin/ops/growth?days=30")).json()) as AdminGrowth;
  assert.equal(growth.accounts, 4);
  assert.equal(growth.tiles.activated.current, 1, "BYOK run must activate the self-serve account");
  assert.equal(growth.funnel.ran_model, 1);

  const health = (await (await adminReq("/v2/admin/ops/health?days=30")).json()) as AdminHealth;
  assert.equal(health.spend.own_key_responses, 1, "BYOK run must populate own_key_responses");
  assert.equal(health.spend.platform_responses, 0);

  // 5. Verify Revenue tab excludes operator & operator_made tenants AND treats starter_grant: backfill as grant
  const backfillRes = await adminReq("/v2/admin/ops/account/credits", {
    method: "POST",
    body: {
      tenantId: emailUser.tenantId,
      amountUsd: 5,
      refId: "starter_grant:backfill_test",
      kind: "grant",
      note: "Backfill starter credit",
    },
  });
  assert.equal(backfillRes.status, 200);

  const revenue = (await (await adminReq("/v2/admin/ops/revenue?days=30")).json()) as AdminRevenue;
  assert.equal(revenue.tiles.revenue.current, 0, "Operator/operator_made topups and starter grants must NOT count as revenue");
  assert.equal(revenue.tiles.paying_accounts, 0, "Operator/operator_made tenants must NOT count as paying accounts");
  assert.equal(revenue.tiles.buyers.current, 0);
  assert.equal(revenue.spend.paying_charged, 0);
  assert.equal(revenue.free_credit.accounts, 2, "GitHub starter grant + starter_grant backfill = 2 free credit accounts");
  assert.equal(revenue.free_credit.given, 10 * 1_000_000);

  // 6. Verify Acquisition endpoint reads R2 signup_source and populates ref / referrer / direct / not_captured + recorded_since
  const acq = (await (await adminReq("/v2/admin/ops/acquisition?days=30")).json()) as AdminAcquisition;
  assert.equal(acq.total.signups, 4);
  assert.equal(acq.total.activated, 1);
  assert.ok(acq.recorded_since !== null, "recorded_since must be populated once sources are recorded");
  const byKind = new Map(acq.sources.map((s) => [s.kind, s]));
  assert.equal(byKind.get("ref")?.source, "run-slack");
  assert.equal(byKind.get("ref")?.signups, 1);
  assert.equal(byKind.get("ref")?.activated, 1);
  assert.equal(byKind.get("referrer")?.source, "news.ycombinator.com");
  assert.equal(byKind.get("referrer")?.signups, 1);
  assert.equal(byKind.get("direct")?.source, "Direct");
  assert.equal(byKind.get("direct")?.signups, 1);
  assert.equal(byKind.get("not_captured")?.source, "Not captured");
  assert.equal(byKind.get("not_captured")?.signups, 1);
});
