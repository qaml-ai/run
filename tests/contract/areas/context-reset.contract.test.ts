import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import {join} from "node:path";

import type {AgentMessage} from "@earendil-works/pi-agent-core";

import {OTHER_OPERATOR, toolCall, until} from "../support.ts";

const result = (id: string, text: string): AgentMessage => ({ role: "toolResult", toolCallId: id, toolName: "codemode", content: [{ type: "text", text }], isError: false, timestamp: 4 } as AgentMessage);

contractTest("history", "tests/context-reset.test.ts:118", "a context too large to load resets over the API, and the next prompt runs from the new context", async t => {
  let mode: "answer" | "fill" | "slow" = "answer";
  let release: () => void = () => {};
  const r = await runtime(t, (_body, index) => mode === "fill" ? toolCall("codemode", { code: 'return "x".repeat(8192)' }, `call_${index}`)
    : mode === "slow" ? { role: "assistant", content: "slow", wait: new Promise<void>(resolve => { release = resolve; }) } : { role: "assistant", content: "fine" }, {
    AGENT_CONTEXT_RANGE_MAX_BYTES: "65536", AGENT_IDLE_MS: "1000",
  });
  const agent = (await r.call("/v1/agents", { body: {} })).json;
  assert.equal((await r.prompt(agent.id, "first")).outcome.result?.error ?? null, null);
  mode = "fill";
  const filled = await r.prompt(agent.id, "go");
  assert.equal(filled.outcome.result.code, "context_too_large", JSON.stringify(filled));
  const calls = r.model.bodies.length;
  const refused = await r.prompt(agent.id, "again");
  assert.equal(refused.outcome.result.code, "context_too_large");
  assert.equal(r.model.bodies.length, calls, "the oversized context is refused before the model");
  const history = (await r.call(`/v1/agents/${agent.id}/history`)).json.messages as any[];

  // Only its tenant's operator resets it.
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {}, token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {}, token: null })).status, 401);
  const browser = (await r.call(`/v1/agents/${agent.id}/browser-tokens`, { body: {} })).json.token;
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {}, token: browser })).status, 403);
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: { keepMessages: 21 } })).status, 400);
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: { keep: 1 } })).status, 400);

  // A tail that starts on a tool result: the reset keeps one fewer, from its call on.
  const keep = [...Array(20).keys()].map(n => n + 1).find(n => history.at(-n).role === "toolResult" && history.at(-n - 1).role === "assistant")!;
  const reset = await r.call(`/v1/agents/${agent.id}/context/reset`, { body: { keepMessages: keep, summary: "The operator cleared a runaway loop." } });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.json.reset, true);
  assert.equal(reset.json.keptMessages, keep - 1);
  assert.ok(reset.json.before.bytes > 65536 && reset.json.after.bytes < 65536, JSON.stringify(reset.json));
  assert.deepEqual((await r.call(`/v1/agents/${agent.id}/history`)).json.messages, history, "the history is unchanged");

  mode = "answer";
  const next = await r.prompt(agent.id, "after");
  assert.equal(next.outcome.result?.error ?? null, null, JSON.stringify(next));
  const body = r.model.bodies.at(-1);
  assert.equal(body.messages[0].role, "system");
  assert.deepEqual(body.messages[0], r.model.bodies[0].messages[0], "the same system message as before the reset");
  assert.deepEqual(body.tools, r.model.bodies[0].tools, "and the same tools");
  const text = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part: any) => part.text ?? "").join("");
  assert.match(text(body.messages[1]), /The operator cleared a runaway loop\./);
  assert.notEqual(body.messages[2].role, "tool");
  assert.ok(!body.messages.some((message: any) => /^first$/.test(text(message))), "the old context is gone");
  assert.equal(body.messages.at(-1).role, "user");
  const after = (await r.call(`/v1/agents/${agent.id}/history`)).json.messages as any[];
  assert.deepEqual(after.slice(0, history.length), history);
  assert.equal(after.length, history.length + 2);

  // Refused while a run is open.
  mode = "slow";
  const accepted = await r.call(`/v1/agents/${agent.id}/prompt`, { body: { text: "slow" } });
  await until(() => r.model.bodies.at(-1) && text(r.model.bodies.at(-1).messages.at(-1)) === "slow", "the slow run to reach the model");
  const busy = await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {} });
  assert.equal(busy.status, 409, busy.text);
  assert.equal(busy.json.code, "AGENT_BUSY");
  release();
  await until(async () => (await r.call(`/v1/agents/${agent.id}/requests/${accepted.json.id}`)).json.state === "completed", "the slow run to end");
  // Reset again (idempotent-safe): the same history, and the agent runs on.
  const second = await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {} });
  assert.equal(second.status, 200, second.text);
  mode = "answer";
  assert.equal((await r.prompt(agent.id, "once more")).outcome.result?.error ?? null, null);
});
