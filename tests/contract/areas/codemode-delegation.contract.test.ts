import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OPERATOR, toolCall, toolResults, until } from "../support.ts";

const roleText = (body: any) => body.messages.filter((message: any) => ["system", "developer", "user"].includes(message.role))
  .map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
const refusal = "The workflow builtin was removed: a workflow is now a codemode script that calls tools.delegate (the delegate builtin)";

/**
 * The original reads its `agent_children` rows; these are the same facts from the public API: each child the parent
 * made, the call that made it (its prompt's parentToolCallId), how its run ended and when.
 */
async function childRows(r: ContractFixture, parent: string) {
  const children = (await r.call("/v1/agents")).json.filter((agent: any) => agent.parentAgentId === parent);
  return Promise.all(children.map(async (child: any) => {
    const run = (await r.call(`/v1/agents/${child.id}`)).json.requests.find((request: any) => request.method === "prompt");
    return { child: child.id, tool_call_id: run?.metadata?.parentToolCallId, status: run?.state === "completed" ? run.status ?? "completed" : "running", ended_at: run?.state === "completed" ? run.endedAt ?? 0 : null };
  }));
}

contractTest("delegation", "tests/codemode-delegation.test.ts:10", "code fans out three delegates once, returns their structured answers, and records each child", async (t)=>{
  const asked: string[] = [];
  const r = await runtime(t, body => {
    if (roleText(body).includes("WORKER")) {
      const task = ["one", "two", "three"].find(task => roleText(body).includes(`task ${task}`))!;
      asked.push(task);
      return toolCall("final_output", { answer: task });
    }
    return toolResults(body).length ? { role: "assistant", content: toolResults(body).at(-1) } : toolCall("codemode", { code: `
      const output = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
      const answers = await Promise.all(["one", "two", "three"].map(task => tools.delegate({ instructions: "You are WORKER.", task: "task " + task, output })));
      return answers.map(answer => answer.output);
    ` }, "code");
  });
  const made = await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { instructions: true } } });
  const record = await r.prompt(made.json.id, "go");
  assert.equal(record.error, undefined, JSON.stringify(record));
  assert.deepEqual(asked.sort(), ["one", "three", "two"]);
  assert.match(record.outcome.result.reply, /\[{"answer":"one"},{"answer":"two"},{"answer":"three"}\]/);
  const calls = record.outcome.result.toolCalls.filter((call: any) => call.tool === "delegate");
  assert.deepEqual(calls.map((call: any) => call.innerCallId).sort(), ["c1", "c2", "c3"]);
  assert.ok(calls.every((call: any) => call.toolCallId === "code" && call.ok && call.agentId));
  assert.equal(new Set(calls.map((call: any) => call.agentId)).size, 3);
  const rows = await childRows(r, made.json.id);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.tool_call_id === "code"));
}, { timeout: 90_000 }); // Includes the file's cold Workers fixture startup.

contractTest("delegation", "tests/codemode-delegation.test.ts:38", "a script returning without awaiting a delegate stops that child", async (t)=>{
  const started = Promise.withResolvers<void>();
  const r = await runtime(t, body => {
    if (roleText(body).includes("BLOCKED")) { started.resolve(); return { wait: new Promise(() => {}), role: "assistant", content: "unreachable" }; }
    if (roleText(body).includes("FINISHER")) return { wait: started.promise, role: "assistant", content: "finished" };
    return toolResults(body).length ? { role: "assistant", content: "done" } : toolCall("codemode", { code: `
      void tools.delegate({ instructions: "You are BLOCKED.", task: "wait" });
      await tools.delegate({ instructions: "You are FINISHER.", task: "finish" });
      return "done";
    ` }, "code");
  });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { instructions: true } } })).json.id;
  const record = await r.prompt(parent, "go");
  assert.equal(record.error, undefined, JSON.stringify(record));
  await until(async () => {
    const rows = await childRows(r, parent);
    return rows.length === 2 && rows.every(row => row.ended_at !== null);
  }, "both delegates ended");
  const rows = await childRows(r, parent);
  assert.ok(rows.some(row => row.status === "completed"));
  assert.ok(rows.some(row => row.status !== "completed"));
});

contractTest("delegation", "tests/codemode-delegation.test.ts:61", "scripts waiting on children longer than their deadline, on an account with one code slot, finish: the wait is off their clock and holds no slot", async (t)=>{
  const tenants = { tenants: { alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), apiKeys: { openrouter: "fixture-model-key" }, tier: "internal", codeConcurrency: 1, codeMaxTimeoutMs: 1_000 } } };
  const r = await runtime(t, body => {
    const child = roleText(body).includes("CHILD");
    if (toolResults(body).length) return { role: "assistant", content: child ? "child done" : String(toolResults(body).at(-1)) };
    // Each child thinks longer than its parent's 1 s deadline, then runs code of its own, which needs the one slot.
    if (child) return { wait: new Promise(resolve => setTimeout(resolve, 1_500)), ...toolCall("codemode", { code: "return 41 + 1" }, "child-code") };
    return toolCall("codemode", { code: `
      const answers = await Promise.all(["a", "b"].map(task => tools.delegate({ instructions: "You are CHILD.", task })));
      return answers.map(answer => answer.text).join(",");
    ` }, "code");
  }, { AGENT_MAX_AGENTS: "16", AGENT_MAX_AGENTS_PER_TENANT: "16" }, tenants);
  const parents = await Promise.all([0, 1].map(async () => (await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { instructions: true } } })).json.id));
  const records = await Promise.all(parents.map(parent => r.prompt(parent, "go")));
  for (const record of records) {
    assert.equal(record.error, undefined, JSON.stringify(record));
    assert.match(record.outcome.result.reply, /child done,child done/);
  }
}, { timeout: 120_000 });

contractTest("delegation", "tests/codemode-delegation.test.ts:81", "workflow input is refused on agents, definitions, runs, upserts and configure; stored settings are ignored", async (t)=>{
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const definition = (await r.call("/v1/definitions", { body: { name: "Old" } })).json.id;
  const agent = (await r.call("/v1/agents", { body: {} })).json.id;
  for (const removed of [{ builtins: ["workflow"] }, { workflow: {} }, { workflow: null }]) {
    for (const [path, body, method, headers] of [
      ["/v1/agents", removed, "POST", {}],
      ["/v1/agents", removed, "POST", { "Idempotency-Key": "old-agent" }],
      ["/v1/definitions", { name: "Old", ...removed }, "POST", {}],
      ["/v1/definitions", { name: "Old", ...removed }, "POST", { "Idempotency-Key": "old-definition" }],
      [`/v1/definitions/${definition}`, removed, "PATCH", {}],
      ["/v1/runs", { input: "go", ...removed }, "POST", {}],
      [`/v1/agents/${agent}/configuration`, removed, "PATCH", {}],
    ] as const) {
      const response = await r.call(path, { body, method, headers });
      assert.equal(response.status, 400, `${path}: ${response.text}`);
      assert.ok(response.text.includes(refusal), response.text);
    }
  }
  // As stored before the builtin was removed (the original updates the definitions row the same way).
  await r.seedLegacyWorkflowDefinition(definition);
  const loaded = await r.call(`/v1/definitions/${definition}`);
  assert.equal(loaded.status, 200, loaded.text);
  assert.deepEqual(loaded.json.builtins, []);
  assert.equal(loaded.json.workflow, undefined);
  const created = await r.call("/v1/agents", { body: { definition } });
  assert.equal(created.status, 201, created.text);
  assert.equal((await r.prompt(created.json.id, "go")).outcome.result.reply, "ok");
  assert.ok(r.model.bodies.every(body => !(body.tools ?? []).some((tool: any) => tool.function.name === "run_workflow")));
});
