import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runtime, until } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OPS = "ops-operator-token-at-least-24-chars";
const OTHER = "other-ops-token-at-least-24-chars";
const tenantsFile = {
  tenants: { ops: { tokenSha256: sha(OPS), apiKeys: {} }, other: { tokenSha256: sha(OTHER), apiKeys: {} } },
  platformKeys: { openrouter: "fixture-platform-key" },
};

test("the platform operator makes a prepaid tenant like a sign-up's, with an API token, credits it and deletes it", { timeout: 120_000 }, async t => {
  const { call, prompt, model } = await runtime(t, () => ({ role: "assistant", content: "hello from the platform key", usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    { AGENT_BILLING_ADMINS: "ops", AGENT_PURGE_INTERVAL_MS: "1000" }, tenantsFile);

  // Only a billing admin's operator token, and only valid ids that are new.
  assert.equal((await call("/v1/tenants", { body: { id: "lab-one" }, token: OTHER })).status, 403);
  assert.equal((await call("/v1/tenants", { body: { id: "Lab One" }, token: OPS })).status, 400);
  assert.equal((await call("/v1/tenants", { body: { id: "other" }, token: OPS })).status, 409, "never an admin tenant's id");
  const created = await call("/v1/tenants", { body: { id: "lab-one", tokenName: "tester" }, token: OPS });
  assert.equal(created.status, 201);
  assert.equal(created.json.tenant, "lab-one");
  assert.equal(created.json.token.name, "tester");
  const token = created.json.token.token;
  assert.match(token, /^art_/);
  assert.equal((await call("/v1/tenants", { body: { id: "lab-one" }, token: OPS })).status, 409);
  assert.equal((await call("/v1/tenants", { body: { id: "lab-two" }, token })).status, 403, "its own token cannot make tenants");

  // It is what a sign-up gets: prepaid, on the platform's keys, out of credit until some is added.
  assert.equal((await call("/v1/me", { token })).json.tenant, "lab-one");
  const billing = (await call("/v1/billing", { token })).json;
  assert.equal(billing.billing, "prepaid");
  assert.equal(billing.balance, 0);
  const providers = (await call("/v1/providers", { token })).json;
  assert.equal(providers.find((provider: any) => provider.id === "openrouter")?.key?.source, "platform");
  const agent = (await call("/v1/agents", { body: {}, token })).json;
  assert.equal((await call(`/v1/agents/${agent.id}/prompt`, { body: { text: "hi" }, token })).status, 402);

  // Credit through the existing adjustment endpoint keeps it on free credit.
  assert.equal((await call("/v1/billing/adjustments", { body: { tenant: "lab-one", amount: 10_000_000, reason: "onboarding lab", idempotencyKey: "lab:lab-one" }, token: OPS })).status, 201);
  const credited = (await call("/v1/billing", { token })).json;
  assert.equal(credited.balance, 10_000_000);
  assert.equal(credited.freeCredit, true);
  const turn = await prompt(agent.id, "hi", token);
  assert.equal(turn.outcome.result.reply, "hello from the platform key");
  assert.deepEqual(new Set(model.keys), new Set(["Bearer fixture-platform-key"]));

  // Deleted like any account, and its id is never made again.
  assert.equal((await call("/v1/tenants/lab-one", { method: "DELETE", token: OPS })).status, 202);
  assert.equal((await call("/v1/me", { token })).status, 401);
  await until(async () => (await call("/v1/tenants/lab-one/deletion", { token: OPS })).json.state === "deleted", "the deletion to finish", 60_000);
  assert.equal((await call("/v1/tenants", { body: { id: "lab-one" }, token: OPS })).status, 409);
});
