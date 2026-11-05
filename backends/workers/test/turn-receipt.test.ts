import { test } from "node:test";
import assert from "node:assert/strict";
import { settleTurn } from "../src/control.ts";
import { postLedger } from "../src/billing.ts";
import { testDatabase } from "./billing-database.ts";

test("turn receipts reject changed response counts and invalid charge inputs before posting", async () => {
  const { db, url } = await testDatabase();
  const tenantId = "receipt-test";
  await db.query("insert into tenants(id,billing,created_at) values($1,'prepaid',$2)", [tenantId, Date.now()]);
  await postLedger(db, [{ tenant: tenantId, kind: "purchase", amount: 1_000_000, key: "test-funding" }]);
  const env = { HYPERDRIVE: { connectionString: url } };
  const receipt = { tenantId, agentId: "client_" + "0".repeat(40), requestId: "stable-test", costMicros: 123, responses: 1 };
  assert.deepEqual(await settleTurn(env, receipt), { duplicate: false });
  assert.deepEqual(await settleTurn(env, receipt), { duplicate: true });
  await assert.rejects(settleTurn(env, { ...receipt, responses: 2 }), /Receipt changed/);
  for (const invalid of [{ responses: -1 }, { responses: 1.5 }, { activeMs: -1 }, { activeMs: Infinity }, { startedAt: -1 }, { modelMetered: "yes" }]) {
    await assert.rejects(settleTurn(env, { ...receipt, ...invalid } as any), /Invalid charge/);
  }
  const row = (await db.query("select balance from credit_accounts where tenant=$1", [tenantId])).rows[0];
  assert.equal(row.balance, 1_000_000 - 123);
});
