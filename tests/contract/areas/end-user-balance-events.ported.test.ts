import { portedTest } from '../ported.ts';
const test = portedTest("credits", "tests/end-user-balance-events.test.ts");

import assert from "node:assert/strict";

import { runtime } from "../support.ts";

const USD = 1_000_000;

test("the API: a person's lowBalance, and the end users under their threshold", async t => {
  const r = await runtime(t, () => ({ content: "ok" }));
  await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true, lowBalance: 2 * USD, allowanceWarningPercent: 90 } });
  for (const [id, amount] of [["a", USD], ["b", 3 * USD], ["c", 5 * USD]] as const) await r.call(`/v1/end-users/${id}/entries`, { body: { kind: "grant", amount, key: `pay-${id}` } });
  const patched = await r.call("/v1/end-users/c", { method: "PATCH", body: { lowBalance: 10 * USD } });
  assert.deepEqual([patched.status, patched.json.lowBalance, patched.json.overrides.lowBalance], [200, 10 * USD, 10 * USD], patched.text);
  const below = await r.call("/v1/end-users?belowLowBalance=true");
  assert.deepEqual(below.json.endUsers.map((user: any) => user.id), ["a", "c"]);
  assert.equal((await r.call("/v1/end-users")).json.endUsers.length, 3);
  assert.equal((await r.call("/v1/end-users?belowLowBalance=yes")).status, 400);
  assert.equal((await r.call("/v1/end-users/c", { method: "PATCH", body: { lowBalance: -1 } })).status, 400);
  assert.equal((await r.call("/v1/end-user-settings")).json.allowanceWarningPercent, 90);
});
