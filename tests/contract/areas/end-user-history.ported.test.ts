import { portedTest } from '../ported.ts';
const test = portedTest("credits", "tests/end-user-history.test.ts");

import assert from "node:assert/strict";

import { utcDay } from "../../../src/end-user-credits.ts";

import { OPERATOR, OTHER_OPERATOR, runtime } from "../support.ts";

import { Agents } from "../../../clients/node.ts";

const USD = 1_000_000;

const DAY = 86_400_000;

test("the history API and the TypeScript SDK: ledger filters and per-day totals, for the tenant only", async t => {
  const r = await runtime(t, () => ({ content: "ok" }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  await agents.endUsers.configure({ enabled: true, allowances: { builder: USD } });
  await agents.endUsers.grant("p", { amount: 5 * USD, key: "pi_1" });
  await agents.endUsers.adjust("p", { amount: -USD, key: "adj_1" });

  const credit = await agents.endUsers.ledger("p", { kind: ["grant", "refund"], from: new Date(Date.now() - DAY), moved: true });
  assert.deepEqual(credit.entries.map(entry => entry.key), ["pi_1"]);
  const days = await agents.endUsers.days("p", { limit: 5 });
  assert.deepEqual(days.days.map(day => [day.day, day.granted, day.adjusted, day.entries]), [[utcDay(Date.now()), 5 * USD, -USD, 2]]);

  const ledger = (query: string) => r.call(`/v1/end-users/p/ledger?${query}`);
  assert.deepEqual((await ledger("kind=grant,adjustment&from=2020-01-01&to=2099-01-01T00:00:00Z")).json.entries.map((entry: any) => entry.key), ["adj_1", "pi_1"]);
  for (const bad of ["kind=gift", "kind=", "from=soon", "to=12abc", "moved=yes", "bucket=bad%20bucket!"]) assert.equal((await ledger(bad)).status, 400, bad);
  for (const bad of ["from=2026-02-30", "to=tomorrow", "limit=0", "limit=x"]) assert.equal((await r.call(`/v1/end-users/p/days?${bad}`)).status, 400, bad);

  assert.deepEqual((await r.call("/v1/end-users/p/days", { token: OTHER_OPERATOR })).json.days, [], "another tenant sees none of it");
  assert.deepEqual((await r.call("/v1/end-users/p/ledger?kind=grant", { token: OTHER_OPERATOR })).json.entries, []);
});
