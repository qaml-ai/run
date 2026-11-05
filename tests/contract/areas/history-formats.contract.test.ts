import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

contractTest("history", "tests/history-formats.test.ts:88", "an agent made with importMessages begins with the conversation, and a refused import makes no agent", async t => {
  const bodies: any[] = [];
  const r = await runtime(t, body => { bodies.push(body); return { role: "assistant", content: "Noted." }; });
  const created = await r.call("/v1/agents", { body: { importMessages: { format: "openai-chat", messages: [
    { role: "user", content: "My order is A-17." },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "track", arguments: "{\"order\":\"A-17\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "SHIPPED-TUESDAY" },
    { role: "assistant", content: "It shipped Tuesday." },
  ] } } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal((await r.prompt(created.json.id, "When did it ship?")).outcome.result.reply, "Noted.");
  const sent = JSON.stringify(bodies[0].messages);
  for (const seen of ["My order is A-17.", "SHIPPED-TUESDAY", "It shipped Tuesday.", "When did it ship?"]) assert.ok(sent.includes(seen), seen);
  assert.deepEqual((await r.call(`/v1/agents/${created.json.id}/history`)).json.messages.slice(0, 4).map((message: any) => message.role), ["user", "assistant", "toolResult", "assistant"]);

  const refused = await r.call("/v1/agents", { body: { importMessages: { format: "openai-chat", messages: [{ role: "tool", tool_call_id: "x", content: "y" }] } } });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "INVALID_HISTORY");
  assert.match(refused.json.error, /importMessages\.messages\[0\]/);
  assert.equal((await r.call("/v1/agents", { body: { initialMessages: [], importMessages: { format: "anthropic", messages: [] } } })).status, 400);
  assert.equal((await r.call("/v1/agents")).json.length, 1);
});
