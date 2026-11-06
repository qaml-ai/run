import { contractTest, createContractFixture, OPERATOR, OTHER_OPERATOR, free, lastUser, toolCall, toolResults, until, sleep, listen, watchEvents, type T } from '../support.ts';
import type { ModelReply, ContractFixture } from '../fixture.ts';
async function runtime(t:T, respond:ModelReply, env:Record<string,string>={}, tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import { z } from "zod";

import { Agents, RunError, schema } from "../../../clients/node.ts";

const SCHEMA = {
  type: "object",
  properties: { sentiment: { type: "string", enum: ["positive", "neutral", "negative"] }, score: { type: "number" } },
  required: ["sentiment", "score"], additionalProperties: false,
};

const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");

const declared = (body: any) => (body.tools ?? []).map((tool: any) => tool.function.name);

const outputTool = (body: any) => (body.tools ?? []).find((tool: any) => tool.function.name === "final_output")?.function;

async function agent(r: Awaited<ReturnType<typeof runtime>>) {
  const created = await r.call("/v1/agents", { body: {} });
  assert.equal(created.status, 201, created.text);
  return created.json.id as string;
}

const forced = { type: "function", function: { name: "final_output" } };

contractTest("models", "tests/structured-output.test.ts:166", "a provider that refuses a forced tool_choice is asked again without it; forcing stops after three requests", async (t)=>{
  const r = await runtime(t, body => {
    if (body.tool_choice) return { httpStatus: 400, message: "tool_choice is not supported" };
    return toolCall("final_output", { sentiment: "neutral", score: 0 });
  });
  const id = (await r.call("/v1/agents", { body: { codeMode: false, fileTools: false } })).json.id as string;
  const record = await r.prompt(id, "How is it?", undefined, { output: { schema: SCHEMA } });
  assert.deepEqual(record.outcome.result.output, { sentiment: "neutral", score: 0 }, JSON.stringify(record));
  assert.deepEqual(r.model.bodies.map(body => !!body.tool_choice), [true, false]);
  assert.deepEqual((await r.call(`/v1/agents/${id}/history`)).json.messages.map((message: any) => message.role), ["user", "assistant", "toolResult"]);

  // A model whose forced calls never fit the schema: three forced requests, then it may end its turn.
  const r2 = await runtime(t, body => body.tool_choice ? toolCall("final_output", { sentiment: "great" }, `call_${Math.random()}`) : { role: "assistant", content: "Fine." });
  const other = (await r2.call("/v1/agents", { body: { codeMode: false, fileTools: false } })).json.id as string;
  const missing = await r2.prompt(other, "How is it?", undefined, { output: { schema: SCHEMA } });
  assert.equal(missing.outcome.result.code, "output_missing");
  assert.deepEqual(r2.model.bodies.map(body => !!body.tool_choice), [true, true, true, false, false]);
});
