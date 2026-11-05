import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import {Agents} from "../../../clients/node.ts";

import {OPERATOR, toolCall} from "../support.ts";

const userTexts = (body: any) => body.messages.filter((message: any) => message.role === "user")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));

contractTest("history", "tests/history-none-ignored.test.ts:32", "the SDK still takes history: \"none\" (ignored), codeMode and configHash", async t => {
  const r = await runtime(t, body => body.tool_choice ? toolCall("final_output", { yes: true }) : ({ role: "assistant", content: "ok" }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const agent = await agents.upsert("yes-no", { instructions: "Answer yes or no.", codeMode: false, fileTools: false });
  const again = await agents.upsert("yes-no", { instructions: "Answer yes or no.", codeMode: false, fileTools: false });
  assert.match(agent.configHash!, /^[0-9a-f]{64}$/);
  assert.equal(again.configHash, agent.configHash);
  assert.equal((await agents.get("yes-no")).configHash, agent.configHash);
  assert.equal((await agents.runtime.listAgents()).find(entry => entry.id === agent.id)?.configHash, agent.configHash);
  await agent.run("First question");
  const run = await agent.run("Second question", { history: "none", output: { type: "object", properties: { yes: { type: "boolean" } }, required: ["yes"] } });
  assert.deepEqual(run.output, { yes: true });
  const body = r.model.bodies.at(-1);
  assert.deepEqual(userTexts(body).map((text: string) => text.includes("First question") || text.includes("Second question")), [true, true]);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "final_output" } });
  assert.doesNotMatch(JSON.stringify(body), /codemode/);
});
