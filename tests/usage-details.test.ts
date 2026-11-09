import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabase } from "./database.ts";
import { groupedUsage, recordUsageDetails } from "../shared/usage-details.ts";

test("usage rollup counts each child once and preserves signed reconciliation after deletion", async () => {
  const { db } = await testDatabase();
  {
    const header = { parent: { agentId: "parent", chain: ["root", "parent"] }, definition: { id: "def_original" } };
    await db.query("insert into agents (id,tenant,header,revision,name,type,model) values ('child','alice',$1,1,'child','agent','model')", [JSON.stringify(header)]);
    const row = { tenant: "alice", agent: "child", endUser: "reader", timestamp: Date.now(), day: new Date().toISOString().slice(0,10), model: "p/m",
      responses: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.2, platformResponses: 1, platformCost: 0.2 };
    await recordUsageDetails(db, [row]);
    await db.query("delete from agents where id='child'");
    await recordUsageDetails(db, [{ ...row, responses: 0, input: 0, output: 0, cost: -0.05, platformResponses: 0, platformCost: -0.05 }]);
    const report = await groupedUsage(db, "alice", 0, { dimensions: ["agent","definition","endUser"], rollup: true }, "root");
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0].agent, "root");
    assert.equal(report.groups[0].definition, "def_original");
    assert.equal(report.groups[0].endUser, "reader");
    assert.equal(report.totals.responses, 1);
    assert.ok(Math.abs(report.totals.cost - 0.15) < 1e-9);
    assert.equal((await groupedUsage(db, "alice", 0, { dimensions: ["agent"], rollup: false }, "root")).groups.length, 0);
    assert.equal((await groupedUsage(db, "bob", 0, { dimensions: ["agent"], rollup: true })).groups.length, 0);
  }
});
