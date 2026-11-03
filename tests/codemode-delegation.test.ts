import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, toolCall, toolResults, until } from "./runtime-server.ts";

const roleText = (body: any) => body.messages.filter((message: any) => ["system", "developer", "user"].includes(message.role))
  .map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
const refusal = "The workflow builtin was removed: a workflow is now a codemode script that calls tools.delegate (the delegate builtin)";

test("code fans out three delegates once, returns their structured answers, and records each child", async t => {
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
  const rows = (await r.db.query("select child, tool_call_id from agent_children where parent = $1", [made.json.id])).rows;
  assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.tool_call_id === "code"));
});

test("a script returning without awaiting a delegate stops that child", async t => {
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
    const rows = (await r.db.query("select ended_at from agent_children where parent = $1", [parent])).rows;
    return rows.length === 2 && rows.every(row => row.ended_at !== null);
  }, "both delegates ended");
  const rows = (await r.db.query("select status from agent_children where parent = $1", [parent])).rows;
  assert.ok(rows.some(row => row.status === "completed"));
  assert.ok(rows.some(row => row.status !== "completed"));
});

test("workflow input is refused on agents, definitions, runs, upserts and configure; stored settings are ignored", async t => {
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
  await r.db.query(`update definitions set spec = (spec::jsonb || '{"builtins":["workflow"],"workflow":{"instructions":true}}'::jsonb)::json where id = $1`, [definition]);
  const loaded = await r.call(`/v1/definitions/${definition}`);
  assert.equal(loaded.status, 200, loaded.text);
  assert.deepEqual(loaded.json.builtins, []);
  assert.equal(loaded.json.workflow, undefined);
  const created = await r.call("/v1/agents", { body: { definition } });
  assert.equal(created.status, 201, created.text);
  assert.equal((await r.prompt(created.json.id, "go")).outcome.result.reply, "ok");
  assert.ok(r.model.bodies.every(body => !(body.tools ?? []).some((tool: any) => tool.function.name === "run_workflow")));
});
