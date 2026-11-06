#!/usr/bin/env node
import { withPilotOperator, PILOT_URL } from "./pilot-operator.mjs";
import { pathToFileURL } from "node:url";

export async function setupPilotAdmin(operator) {
  const existing = await operator.request("/pilot/inspect?tenant=pilot-admin");
  if (existing.deleted_tenants || existing.deleting_tenants) throw new Error("pilot-admin was deleted or is being deleted; its ID cannot be reused.");
  const created = existing.tenants
    ? { tenant: "pilot-admin", token: await operator.request("/v1/tenants/pilot-admin/tokens", { body: { name: "CTO pilot key" } }) }
    : await operator.request("/v1/tenants", { body: { id: "pilot-admin", tokenName: "CTO pilot key" } });
  try {
    await operator.request("/v1/billing/adjustments", { body: {
      tenant: "pilot-admin", amount: 25_000_000, reason: "Internal pilot credit", idempotencyKey: "pilot-admin-initial-credit",
    } });
  } catch {
    // Retain the tenant so the CTO can retry, but revoke the unreported key.
    await operator.request(`/v1/tenants/pilot-admin/tokens/${created.token.id}`, { method: "DELETE" });
    throw new Error("Pilot admin credit setup failed; its new key was revoked. Run this command again to retry.");
  }
  return created;
}

// Run this yourself in a terminal. Do not run it through an agent or a CI job:
// it deliberately displays the newly minted credential exactly once.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
if (!process.stdout.isTTY) {
  console.error("Run this command yourself in an interactive terminal; it prints a usable API key once.");
  process.exitCode = 1;
} else {
  try {
    const result = await withPilotOperator({ tenantIds: ["pilot-admin"] }, setupPilotAdmin);
    console.log(`Pilot: ${PILOT_URL}\nTenant: ${result.tenant}\nAPI key (shown once; save it securely):\n${result.token.token}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Pilot admin setup failed.");
    process.exitCode = 1;
  }
}
}
