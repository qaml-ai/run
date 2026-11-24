import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

interface BillingState {
  billing: {
    balanceUsd: number;
    usage: Array<{ model: string; runsCount: number; costUsd: number; vmMs: number }>;
    recent: Array<{ refId: string; amountUsd: number; kind: string }>;
  };
  ledger: Array<{ amount_usd: number; kind: string }>;
}

test("platform reserves preserve metered usage, deduplicate charges and rolls back failed grants", async t => {
  const dir = mkdtempSync(join(tmpdir(), "camelrun-credit-reserve-"));
  const config = join(dir, "wrangler.json");
  const builder = "fixture-builder-tenant";
  const chiridion = "fixture-chiridion-tenant";
  const botCanary = "fixture-bot-canary";
  writeFileSync(config, JSON.stringify({
    name: "credit-reserve-test",
    main: fileURLToPath(new URL("./fixtures/credit-reserve-worker.ts", import.meta.url)),
    compatibility_date: "2026-03-01",
    compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
    vars: { BUILDER_CUTOVER_CREDIT_TENANT_ID: builder, APP_RUNTIME_CREDIT_TENANT_IDS: [chiridion, botCanary].join(",") },
    durable_objects: { bindings: [{ name: "TEST_TENANT", class_name: "CreditReserveTestTenant" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["CreditReserveTestTenant"] }],
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const call = (mode: string, tenantId: string, amount?: number, ref?: string) => worker.fetch(
    `https://credit-reserve.test/${mode}/${tenantId}`,
    { method: "POST", body: JSON.stringify({ amount, ref }), signal: AbortSignal.timeout(5_000) },
  );
  const send = async <T>(mode: string, tenantId: string, amount?: number, ref?: string, status = 200): Promise<T> => {
    const response = await call(mode, tenantId, amount, ref);
    assert.equal(response.status, status);
    return response.json() as Promise<T>;
  };

  await send("init", builder, 1);
  await send("init", chiridion, 1);
  await send("init", botCanary, 0);
  await send("init", "other", 1);
  await Promise.all([
    send("settle", builder, 30, "run:first"),
    send("settle", builder, 30, "run:first"),
    send("settle", builder, 2, "run:second"),
    send("settle", chiridion, 30, "run:first"),
    send("settle", chiridion, 30, "run:first"),
    send("settle", botCanary, 30, "run:first"),
    send("settle", "other", 30, "run:first"),
  ]);
  const { billing, ledger } = await send<BillingState>("read", builder);
  assert.ok(billing.balanceUsd >= 23 && billing.balanceUsd <= 25);
  assert.deepEqual(billing.usage.map(({ runsCount, costUsd }) => [runsCount, costUsd]), [[2, 32]]);
  assert.equal(ledger.filter(({ kind }) => kind === "usage").length, 2);
  assert.equal(ledger.reduce((total, { amount_usd }) => total + amount_usd, 0), billing.balanceUsd);
  assert.equal((await send<BillingState>("read", "other")).billing.balanceUsd, -29);
  assert.equal((await send<{ code: string }>("grant", builder, -100, "correction", 409)).code, "builder_credit_reserve");
  assert.equal((await send<{ code: string }>("grant", builder, 1, "builder-cutover-reserve:bad", 400)).code, "invalid_credit_ref");

  assert.equal((await send<BillingState>("read", botCanary)).billing.balanceUsd, 25);
  const chiridionState = await send<BillingState>("read", chiridion);
  assert.equal(chiridionState.billing.balanceUsd, 25);
  assert.deepEqual(chiridionState.billing.usage.map(({ runsCount, costUsd }) => [runsCount, costUsd]), [[1, 30]]);
  assert.equal(chiridionState.ledger.reduce((total, { amount_usd }) => total + amount_usd, 0), 25);
  assert.equal((await send<{ code: string }>("grant", chiridion, -25, "correction", 409)).code, "app_runtime_credit_reserve");
  assert.equal((await send<{ code: string }>("grant", chiridion, 1, "app-runtime-reserve:bad", 400)).code, "invalid_credit_ref");

  await send("collision", builder, undefined, "run:rollback");
  const before = await send("read", builder);
  await send("settle", builder, 100, "run:rollback", 500);
  assert.deepEqual(await send("read", builder), before);

  // Free $0 image:resvg usage with skipLedger=true records usage_daily without inserting a $0 credit_ledger row.
  const otherBefore = await send<BillingState>("read", "other");
  await send("free-image", "other", 0, "svg:rnd1");
  await send("free-image", "other", 0, "svg:rnd2");
  const otherAfter = await send<BillingState>("read", "other");
  assert.equal(otherAfter.ledger.length, otherBefore.ledger.length, "free $0 render must not insert into credit_ledger");
  assert.equal(otherAfter.billing.recent.length, otherBefore.billing.recent.length, "free $0 render must not pollute /v2/billing recent ledger");
  const svgRow = otherAfter.billing.usage.find(u => u.model === "image:resvg");
  assert.ok(svgRow, "image:resvg usage row must be recorded in usage_daily");
  assert.equal(svgRow.runsCount, 2);
  assert.equal(svgRow.vmMs, 110);
  assert.equal(svgRow.costUsd, 0);
});
