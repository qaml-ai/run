#!/usr/bin/env node
import { withPilotOperator, PILOT_URL } from "./pilot-operator.mjs";

// Run this yourself in a terminal. Do not run it through an agent or a CI job:
// it deliberately displays the newly minted credential exactly once.
if (!process.stdout.isTTY) {
  console.error("Run this command yourself in an interactive terminal; it prints a usable API key once.");
  process.exitCode = 1;
} else {
  try {
    const result = await withPilotOperator({ tenantIds: ["pilot-admin"] }, async operator => {
      const created = await operator.request("/v1/tenants", { body: { id: "pilot-admin", tokenName: "CTO pilot key" } });
      try {
        await operator.request("/v1/billing/adjustments", { body: {
          tenant: "pilot-admin", amount: 25_000_000, reason: "Internal pilot credit", idempotencyKey: "pilot-admin-initial-credit",
        } });
      } catch {
        // Return no key if setup is incomplete. Revoke the tenant through the
        // app's normal deletion path, allowing a deliberate new tenant next run.
        await operator.request("/v1/tenants/pilot-admin", { method: "DELETE" });
        throw new Error("Pilot admin setup failed; its key was revoked.");
      }
      return created;
    });
    console.log(`Pilot: ${PILOT_URL}\nTenant: ${result.tenant}\nAPI key (shown once; save it securely):\n${result.token.token}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Pilot admin setup failed.");
    process.exitCode = 1;
  }
}
