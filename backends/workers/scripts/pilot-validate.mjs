#!/usr/bin/env node
// node --experimental-strip-types backends/workers/scripts/pilot-validate.mjs
// Creates a bounded, throwaway tenant through the application's operator paths.
import { randomBytes } from "node:crypto";
import { withPilotOperator, PILOT_URL } from "./pilot-operator.mjs";
import { runSmoke } from "./pilot-smoke.ts";
import { Agents } from "../../../clients/node.ts";

const fakeUrl = process.env.PILOT_FAKE_URL;
if (!fakeUrl) throw new Error("Set PILOT_FAKE_URL to the deployed camelrun-pilot-fakemodel URL");
const usageFields = ["responses", "input", "output", "cacheRead", "cacheWrite", "cost", "platformResponses", "platformCost"];
async function usageTotals(apiKey) {
  const response = await fetch(`${PILOT_URL}/v1/usage?days=1`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Pilot usage read returned ${response.status}`);
  const { totals } = await response.json();
  return Object.fromEntries(usageFields.map(key => [key, Number(totals[key]) || 0]));
}
const difference = (after, before) => Object.fromEntries(usageFields.map(key => [key, after[key] - before[key]]));
const tenant = `pilot-smoke-${randomBytes(6).toString("hex")}`;
try {
  const result = await withPilotOperator({ tenantIds: [tenant] }, async operator => {
    let created = false;
    const report = { tenant, startedAt: new Date().toISOString(), ...(process.env.PILOT_AGENT_NAMESPACE_ID ? { agentNamespaceId: process.env.PILOT_AGENT_NAMESPACE_ID } : {}) };
    try {
      const account = await operator.request("/v1/tenants", { body: { id: tenant, tokenName: "Throwaway pilot smoke key" } });
      created = true;
      await operator.request("/v1/billing/adjustments", { body: { tenant, amount: 10_000_000, reason: "Disposable pilot smoke credit", idempotencyKey: `${tenant}-credit` } });
      await operator.request(`/v1/tenants/${tenant}/limits`, { method: "PUT", body: { maxBusyAgents: 20, agentCreatesPerMinute: 100, runsPerMinute: 100 } });
      if (!process.argv.includes("--real-model-only")) report.smoke = await runSmoke({ apiKey: account.token.token, baseUrl: PILOT_URL, fakeUrl, python: process.env.PILOT_PYTHON, idleMs: Number(process.env.PILOT_IDLE_MS ?? 90000) });
      if (process.argv.includes("--real-model") || process.argv.includes("--real-model-only")) {
        const agents = new Agents({ url: PILOT_URL, apiKey: account.token.token });
        try {
          const model = process.env.PILOT_REAL_MODEL ?? "openrouter/openai/gpt-4o-mini";
          const beforeUsage = await usageTotals(account.token.token);
          const before = await operator.request("/pilot/inspect");
          const agent = await agents.upsert(`${tenant}-real`, { model, codeMode: false, fileTools: false, maxOutputTokens: 16 });
          report.realModel = { status: "started", model, manualRequests: 1, maxOutputTokens: 16 };
          try {
            const started = Date.now();
            try {
              // Exactly one submitted run. Runtime retries, if any, appear in
              // the response and durable attempt counters below.
              const run = await agent.run("Reply with only PILOT_OK.");
              report.realModel.ms = Date.now() - started;
              report.realModel.runStatus = run.status;
              report.realModel.usage = run.usage;
              report.realModel.status = run.status === "completed" && run.text.includes("PILOT_OK") ? "pass" : "fail";
              if (report.realModel.status !== "pass") throw new Error("Real model smoke did not complete with the expected reply");
            } catch {
              report.realModel.status = "fail";
              report.realModel.ms = Date.now() - started;
              throw new Error("Real model smoke request failed; inspect the recorded usage and attempts before retrying");
            } finally {
              const deadline = Date.now() + 30000;
              for (;;) {
                const afterUsage = await usageTotals(account.token.token);
                const after = await operator.request("/pilot/inspect");
                report.realModel.apiUsageDelta = difference(afterUsage, beforeUsage);
                report.realModel.modelAttempts = {
                  total: Number(after.attempts) - Number(before.attempts),
                  settled: Number(after.settled_attempts) - Number(before.settled_attempts),
                  pending: Number(after.pending_attempts),
                  chargeMicros: Number(after.attempt_charge_micros) - Number(before.attempt_charge_micros),
                };
                if (Number(after.pending_attempts) === 0 && (report.realModel.apiUsageDelta.responses > 0 || report.realModel.status !== "pass")) break;
                if (Date.now() >= deadline) break;
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
              console.log(JSON.stringify({ tenant, realModel: report.realModel }));
            }
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
