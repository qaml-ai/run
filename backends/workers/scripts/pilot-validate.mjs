#!/usr/bin/env node
// node --experimental-strip-types backends/workers/scripts/pilot-validate.mjs
// Creates a bounded, throwaway tenant through the application's operator paths.
import { randomBytes } from "node:crypto";
import { withPilotOperator, PILOT_URL } from "./pilot-operator.mjs";
import { runSmoke } from "./pilot-smoke.ts";
import { Agents } from "../../../clients/node.ts";

const fakeUrl = process.env.PILOT_FAKE_URL;
if (!fakeUrl) throw new Error("Set PILOT_FAKE_URL to the deployed camelrun-pilot-fakemodel URL");
const tenant = `pilot-smoke-${randomBytes(6).toString("hex")}`;
try {
  const result = await withPilotOperator({ tenantIds: [tenant] }, async operator => {
    let created = false;
    const report = { tenant, startedAt: new Date().toISOString() };
    try {
      const account = await operator.request("/v1/tenants", { body: { id: tenant, tokenName: "Throwaway pilot smoke key" } });
      created = true;
      await operator.request("/v1/billing/adjustments", { body: { tenant, amount: 10_000_000, reason: "Disposable pilot smoke credit", idempotencyKey: `${tenant}-credit` } });
      await operator.request(`/v1/tenants/${tenant}/limits`, { method: "PUT", body: { maxBusyAgents: 20, agentCreatesPerMinute: 100, runsPerMinute: 100 } });
      if (!process.argv.includes("--real-model-only")) report.smoke = await runSmoke({ apiKey: account.token.token, baseUrl: PILOT_URL, fakeUrl, python: process.env.PILOT_PYTHON, idleMs: Number(process.env.PILOT_IDLE_MS ?? 90000) });
      if (process.argv.includes("--real-model") || process.argv.includes("--real-model-only")) {
        const agents = new Agents({ url: PILOT_URL, apiKey: account.token.token });
        try {
          const agent = await agents.upsert(`${tenant}-real`, { model: process.env.PILOT_REAL_MODEL ?? "openrouter/openai/gpt-4o-mini", codeMode: false, fileTools: false, maxOutputTokens: 16 });
          try {
            const started = Date.now();
            const run = await agent.run("Reply with only PILOT_OK.");
            if (run.status !== "completed" || !run.text.includes("PILOT_OK")) throw new Error("Real model smoke did not complete with the expected reply");
            report.realModel = { status: "pass", model: process.env.PILOT_REAL_MODEL ?? "openrouter/openai/gpt-4o-mini", ms: Date.now() - started, usage: run.usage };
          } finally { await agent.delete(); }
        } finally { await agents.close(); }
      }
      const idleAgent = report.smoke?.idle?.agentId;
      report.beforeCleanup = await operator.request(`/pilot/inspect?tenant=${encodeURIComponent(tenant)}${idleAgent ? `&agent=${encodeURIComponent(idleAgent)}` : ""}`);
    } finally {
      if (created) {
        await operator.request(`/v1/tenants/${tenant}`, { method: "DELETE" });
        const deadline = Date.now() + 120000;
        for (;;) {
          const deletion = await operator.request(`/v1/tenants/${tenant}/deletion`);
          if (deletion.state === "deleted") break;
          if (Date.now() > deadline) throw new Error(`Cleanup for ${tenant} did not complete within two minutes`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        report.afterCleanup = await operator.request("/pilot/inspect");
        report.cleanup = "completed";
        console.log(JSON.stringify({ tenant, cleanup: report.cleanup, afterCleanup: report.afterCleanup }));
      }
    }
    return report;
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // Helpers deliberately omit response bodies and credentials from errors.
  console.error(error instanceof Error ? error.message : "Pilot validation failed");
  process.exitCode = 1;
}
