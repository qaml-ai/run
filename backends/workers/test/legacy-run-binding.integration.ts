import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.ts";
import { ARCHIVE_KIND } from "../../../src/pi-durable/ordinals.ts";
import { hash, resumeId } from "../../../src/v1-client-state.ts";

test("legacy prompts and reads cross nested Worker bindings without serializing abort signals", { timeout: 180_000 }, async t => {
  const apiKey = "art_fixture-preserved-tenant-key";
  const agent = `client_${"1".repeat(40)}`;
  const agentKey = "preserved-agent-fixture-key";
  const f = await startFixture({
    tenants: [{ id: "fixture", token: apiKey }],
    entrypoint: fileURLToPath(new URL("./legacy-mcp-entry.ts", import.meta.url)),
    loopbackServices: { V2_LEGACY_RUNS: "FixtureLegacyDestination" },
  });
  t.after(() => f.stop());
  await f.db.query(`insert into agents(id,tenant,header,revision,name,type,model) values($1,'fixture',$2,1,'','agent','test')`, [agent, JSON.stringify({ digest: hash(agentKey) })]);
  const unmigrated = `client_${"3".repeat(40)}`;
  await f.db.query(`insert into agents(id,tenant,header,revision,name,type,model) values($1,'fixture',$2,1,'','agent','test')`, [unmigrated, JSON.stringify({ digest: hash(agentKey) })]);
  const message = { role: "user", timestamp: 1, content: "Existing history" };
  await f.db.query(`insert into pi_durable_metadata(session_id,next_id,next_seq,history_next) values($1,'2',2,1)`, [unmigrated]);
  await f.db.query(`insert into pi_durable_entries(session_id,id,conversation_id,commit_seq,record,msg_from,msg_count,msg_skip,turn_start)
    values($1,1,1,1,$2,0,1,0,true)`, [unmigrated, JSON.stringify({ kind: ARCHIVE_KIND, data: { messages: [message] } })]);
  const sourceHeaders = { authorization: `Bearer ${apiKey}` };
  const source = `${f.url}/v1/agents/${unmigrated}`;
  const full = await fetch(`${source}/history`, { headers: sourceHeaders });
  assert.equal(full.status, 200, await full.clone().text());
  assert.deepEqual(await full.json(), { messages: [message] });
  const page = await fetch(`${source}/history?after=0&limit=1`, { headers: sourceHeaders });
  assert.equal(page.status, 200, await page.clone().text());
  assert.deepEqual((await page.json() as { entries: unknown[] }).entries, [{ index: 0, message }]);
  const sourceInputs = await fetch(`${source}/inputs`, { headers: sourceHeaders });
  assert.equal(sourceInputs.status, 200, await sourceInputs.clone().text());
  assert.deepEqual(await sourceInputs.json(), []);
  assert.equal((await fetch(`${source}/history`)).status, 401);
  await f.db.query(`insert into agent_v2_cutovers(tenant,agent,operation) values('fixture',$1,$2)`, [agent, randomUUID()]);
  await f.db.query(`insert into agent_v2_routes(tenant,agent,destination_tenant,destination_agent,event_base)
    values('fixture',$1,$2,$3,0)`, [agent, `tnt_${"1".repeat(16)}`, `agt_${"2".repeat(16)}`]);
  const input = {
    id: `inp_${"2".repeat(32)}`, agent, tenant: "fixture", requestId: "earlier", toolCallId: "tool",
    kind: "approval", message: "Approve this?", detail: {}, responders: { audience: ["original-user"] },
    state: "answered", answer: { action: "accept", by: { actor: "original-user" }, at: 3 },
    createdAt: 1, expiresAt: 8, blocking: true, version: 2,
  };
  const continuation = { id: resumeId(input.requestId), state: "completed", method: "resume", suspension: input.requestId,
    fingerprint: "original-fingerprint", startedAt: 4, began: 4, endedAt: 6, outcome: { result: { reply: "already ran" } } };
  await f.db.query(`insert into agent_v2_receipt_archives(tenant,agent,receipts,inputs) values('fixture',$1,$2,$3)`,
    [agent, JSON.stringify([continuation]), JSON.stringify([{ input, approvers: [] }])]);

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

  const inputs = await fetch(`${base}/inputs?state=answered`, { headers });
  assert.equal(inputs.status, 200, await inputs.clone().text());
  assert.deepEqual(await inputs.json(), [input]);
  const agentHeaders = { ...headers, authorization: `Bearer ${agentKey}` };
  const existingAnswer = await fetch(`${f.url}/clients/${agent}/inputs/${input.id}`, {
    method: "POST", headers: agentHeaders, body: JSON.stringify({ action: "accept", actor: "original-user" }),
  });
  assert.equal(existingAnswer.status, 200, await existingAnswer.clone().text());
  assert.deepEqual(await existingAnswer.json(), { input, request: continuation });
  const conflict = await fetch(`${base}/inputs/${input.id}`, {
    method: "POST", headers, body: JSON.stringify({ action: "decline", actor: "original-user" }),
  });
  assert.equal(conflict.status, 409, await conflict.clone().text());
  assert.deepEqual((await conflict.json() as { input: unknown }).input, input);
  assert.equal((await f.db.query("select id from agent_inputs where agent=$1", [agent])).rowCount, 0);
});
