#!/usr/bin/env node
// Create (or reuse) a pilot tenant, mint it an API key, grant it internal credit once, and write the key to a
// private file. The key is never printed, so an agent can run this for a product built on the pilot:
//   node backends/workers/scripts/pilot-tenant-key.mjs <tenant> <credit-usd> <key-file>
// Running it again mints a fresh key (older keys stay valid until revoked); the credit grant is idempotent.
import { withPilotOperator, PILOT_URL } from "./pilot-operator.mjs";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export async function setupPilotTenant(operator, { tenant, creditUsd }) {
  const existing = await operator.request(`/pilot/inspect?tenant=${encodeURIComponent(tenant)}`);
  if (existing.deleted_tenants || existing.deleting_tenants) throw new Error(`${tenant} was deleted or is being deleted; its ID cannot be reused.`);
  const created = existing.tenants
    ? { tenant, token: await operator.request(`/v1/tenants/${tenant}/tokens`, { body: { name: `${tenant} pilot key` } }) }
    : await operator.request("/v1/tenants", { body: { id: tenant, tokenName: `${tenant} pilot key` } });
  try {
    await operator.request("/v1/billing/adjustments", { body: {
      tenant, amount: Math.round(creditUsd * 1_000_000), reason: "Internal pilot credit", idempotencyKey: `${tenant}-initial-credit`,
    } });
  } catch {
    await operator.request(`/v1/tenants/${tenant}/tokens/${created.token.id}`, { method: "DELETE" });
    throw new Error(`Credit setup for ${tenant} failed; its new key was revoked. Run this again to retry.`);
  }
  return created;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tenant, credit, file] = process.argv.slice(2);
  if (!/^pilot-[a-z0-9][a-z0-9-]{0,32}$/.test(tenant ?? "") || !(Number(credit) >= 0) || !file) {
    console.error("usage: pilot-tenant-key.mjs <pilot-tenant> <credit-usd> <key-file>");
    process.exitCode = 2;
  } else {
    try {
      const result = await withPilotOperator({ tenantIds: [tenant] }, operator => setupPilotTenant(operator, { tenant, creditUsd: Number(credit) }));
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, `${result.token.token}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      console.log(`Pilot: ${PILOT_URL}\nTenant: ${result.tenant}\nKey id: ${result.token.id}\nKey written to ${file} (mode 600; not printed)`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Pilot tenant setup failed.");
      process.exitCode = 1;
    }
  }
}
