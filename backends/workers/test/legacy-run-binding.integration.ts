import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.ts";

test("legacy prompts and reads cross nested Worker bindings without serializing abort signals", { timeout: 180_000 }, async t => {
  const apiKey = "art_fixture-preserved-tenant-key";
  const agent = `client_${"1".repeat(40)}`;
  const f = await startFixture({
    tenants: [{ id: "fixture", token: apiKey }],
    entrypoint: fileURLToPath(new URL("./legacy-mcp-entry.ts", import.meta.url)),
    loopbackServices: { V2_LEGACY_RUNS: "FixtureLegacyDestination" },
  });
  t.after(() => f.stop());
  await f.db.query(`insert into agents(id,tenant,header,revision,name,type,model) values($1,'fixture','{}',1,'','agent','test')`, [agent]);
  await f.db.query(`insert into agent_v2_cutovers(tenant,agent,operation) values('fixture',$1,$2)`, [agent, randomUUID()]);
  await f.db.query(`insert into agent_v2_routes(tenant,agent,destination_tenant,destination_agent,event_base)
    values('fixture',$1,$2,$3,0)`, [agent, `tnt_${"1".repeat(16)}`, `agt_${"2".repeat(16)}`]);
  await f.db.query(`insert into agent_v2_receipt_archives(tenant,agent,receipts) values('fixture',$1,'[]')`, [agent]);

  const requestId = "fixture-prompt";
  const base = `${f.url}/v1/agents/${agent}`;
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const prompt = await fetch(`${base}/prompt`, { method: "POST", headers, body: JSON.stringify({ requestId, text: "Run on the private destination" }) });
  assert.equal(prompt.status, 202, await prompt.clone().text());
  const accepted = await prompt.json() as { id: string; status: string; outcome: { result: { reply: string } } };
  assert.equal(accepted.id, requestId);
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.outcome.result.reply, "From v2");
  const receipt = await fetch(`${base}/requests/${requestId}`, { headers });
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), accepted);
  const history = await fetch(`${base}/history`, { headers });
  assert.equal(history.status, 200);
  assert.deepEqual((await history.json() as { messages: [] }).messages, []);
});
