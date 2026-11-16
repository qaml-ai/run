#!/usr/bin/env node
import { withPilotOperator, PILOT_URL } from "./pilot-operator.mjs";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";
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
    // Retain the tenant for a retry and revoke the unreported key.
    await operator.request(`/v1/tenants/pilot-admin/tokens/${created.token.id}`, { method: "DELETE" });
    throw new Error("Pilot admin credit setup failed; its new key was revoked. Run this command again to retry.");
  }
  return created;
}

export async function writePilotAdminKey(file, run = withPilotOperator) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const output = await open(file, "wx", 0o600);
  let saved = false;
  try {
    await output.chmod(0o600);
    return await run({ tenantIds: ["pilot-admin"] }, async operator => {
      const { tenant, token } = await setupPilotAdmin(operator);
      try {
        await output.writeFile(`${token.token}\n`);
        await output.sync();
        saved = true;
      } catch {
        try {
          await operator.request(`/v1/tenants/${tenant}/tokens/${token.id}`, { method: "DELETE" });
        } catch {
          throw new Error(`Could not save the pilot admin key. Revoke key ${token.id} on ${tenant} before retrying.`);
        }
        throw new Error("Could not save the pilot admin key. Its new key was revoked.");
      }
      return { tenant, keyId: token.id };
    });
  } finally {
    try { await output.close(); }
    finally { if (!saved) await unlink(file); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, extra] = process.argv.slice(2);
  if (!file || file.startsWith("-") || extra !== undefined) {
    console.error("usage: pilot-admin-key.mjs <key-file>");
    process.exitCode = 2;
  } else {
    try {
      const { tenant, keyId } = await writePilotAdminKey(file);
      console.log(`Pilot: ${PILOT_URL}\nTenant: ${tenant}\nKey id: ${keyId}\nKey written to ${file} (mode 600)`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Pilot admin setup failed.");
      process.exitCode = 1;
    }
  }
}
