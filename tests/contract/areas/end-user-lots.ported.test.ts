import { portedTest } from '../ported.ts';
const test = portedTest("credits", "tests/end-user-lots.test.ts");

import assert from "node:assert/strict";


import { OPERATOR, OTHER_OPERATOR, runtime } from "../support.ts";

import { Agents } from "../../../clients/node.ts";

const USD = 1_000_000;

const DAY = 86_400_000;


test("the lots API and the TypeScript SDK: expiring grants, lots on the end user, marking, refunds by lot, for the tenant only", async t => {
  const r = await runtime(t, () => ({ content: "ok" }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  await agents.endUsers.configure({ enabled: true, allowances: { builder: USD } });
  const end = new Date(Date.now() + 30 * DAY);
  await agents.endUsers.grant("p", { amount: 5 * USD, key: "pack-1" });
  const plan = await agents.endUsers.grant("p", { amount: 3 * USD, key: "plan:1", expiresAt: end, description: "camelBot Plus" });
  assert.equal(plan.entry.amount, 3 * USD);
  const person = await agents.endUsers.get("p");
  assert.deepEqual(person.lots.map(lot => [lot.key, lot.remaining, lot.expiresAt]), [["plan:1", 3 * USD, end.getTime()], [null, 5 * USD, null]]);
  await agents.endUsers.refund("p", { amount: USD, key: "re-plan", lot: "plan:1" });
  assert.deepEqual((await agents.endUsers.get("p")).lots.map(lot => lot.remaining), [2 * USD, 5 * USD]);
  await agents.endUsers.grant("p", { amount: USD, key: "old-plan" });
  const marked = await agents.endUsers.markLot("p", { key: "old-plan", amount: USD, expiresAt: end });
  assert.equal(marked.lot.key, "old-plan");
  assert.equal((await r.call("/v1/end-users/p/lots", { method: "POST", body: { key: "x", amount: 99 * USD, expiresAt: end.getTime() } })).status, 409);
  assert.equal((await r.call("/v1/end-users/p/entries", { method: "POST", body: { kind: "grant", amount: USD, key: "y", expiresAt: 5 } })).status, 400);
  assert.deepEqual((await r.call("/v1/end-users/p", { token: OTHER_OPERATOR })).json.lots, [], "another tenant sees none of it");
});
