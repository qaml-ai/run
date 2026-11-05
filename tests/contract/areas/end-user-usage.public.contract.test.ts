import assert from "node:assert/strict";
import { Agents } from "../../../clients/node.ts";
import { OPERATOR, OTHER_OPERATOR, createContractFixture } from "../support.ts";
import { portedTest } from "../ported.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-02-01T00:00:00Z");

portedTest("credits", "tests/end-user-usage.test.ts:96")("usage API and TypeScript SDK parse times, group usage and isolate tenants", async t => {
  const r = await createContractFixture(t);
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  await agents.endUsers.grant("p", { amount: 100, key: "grant" });
  await agents.endUsers.configure({ enabled: true, allowances: { "bot:*": 100 } });
  await r.seedEndUserUsage({ tenant: "alice", endUser: "p", bucket: "bot:1", amount: 50, key: "usage", metadata: { call: "response", agent: "one" }, at: START });
  const expected = { step: "hour", from: START, to: START + DAY, rows: [
    { at: START, bucket: "bot:1", call: "response", agent: "one", calls: 1, raw: 50, allowance: 50, paid: 0, writtenOff: 0 },
  ] };
  assert.deepEqual(await agents.endUsers.usage("p", { from: new Date(START), to: START + DAY, bucket: "bot:*" }), expected);
  assert.deepEqual((await r.call("/v1/end-users/p/usage?from=2026-02-01&to=2026-02-02T00:00:00Z&bucket=bot:*&step=hour")).json, expected);
  assert.equal((await agents.endUsers.usage("p", { from: "2026-02-01", to: "2026-02-02", step: "day" })).rows.length, 1);
  for (const bad of ["step=minute", "from=soon", "from=2026-02-30", "to=12abc", "from=1&to=1", "from=0&to=9999999999999", "bucket=bad%20bucket", "from="]) {
    assert.equal((await r.call(`/v1/end-users/p/usage?${bad}`)).status, 400, bad);
  }
  assert.deepEqual((await r.call("/v1/end-users/p/usage?from=2026-02-01&to=2026-02-02", { token: OTHER_OPERATOR })).json.rows, []);
  assert.deepEqual((await agents.endUsers.usage("other", { from: START, to: START + DAY })).rows, []);
});
