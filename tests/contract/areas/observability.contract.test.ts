import assert from "node:assert/strict";
import { contractTest, OTHER_OPERATOR, toolCall } from "../support.ts";

contractTest("observability", "tests/observability.test.ts:1", "attributed usage and durable logs preserve totals and tenant boundaries", async (_t, r) => {
  r.setModel(() => ({ role: "assistant", content: "Done", usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.2 } }));
  const definition = (await r.call("/v1/definitions", { body: { name: "Observer" } })).json.id;
  const agent = (await r.call("/v1/agents", { body: { definition, subject: "reader" } })).json.id;
  await r.prompt(agent, "Test");
  const legacy = await r.call("/v1/usage");
  assert.equal(legacy.json.totals.responses, 1);
  assert.ok(Array.isArray(legacy.json.days));
  const grouped = await r.call("/v1/usage?groupBy=agent,definition,endUser,model,day");
  assert.equal(grouped.status, 200, grouped.text);
  assert.equal(grouped.json.groups.length, 1);
  assert.equal(grouped.json.groups[0].agent, agent);
  assert.equal(grouped.json.groups[0].definition, definition);
  assert.equal(grouped.json.groups[0].endUser, "reader");
  assert.equal(grouped.json.totals.cost, legacy.json.totals.cost);
  assert.equal((await r.call(`/v1/agents/${agent}/usage`, { token: OTHER_OPERATOR })).status, 404);
  const agentUsage = await r.call(`/v1/agents/${agent}/usage?rollup=true`);
  assert.equal(agentUsage.status, 200, agentUsage.text);
  assert.equal(agentUsage.json.totals.responses, 1);
  assert.equal((await r.call("/v1/usage?groupBy=bogus")).status, 400);
  assert.equal((await r.call("/v1/usage?groupBy=agent,agent")).status, 400);
  const run = await r.call("/v1/runs?wait=30", { body: { input: "Test" } });
  assert.equal(run.status, 200, run.text);
  const log = await r.call(`/v1/runs/${run.json.id}/log`);
  assert.equal(log.status, 200, log.text);
  assert.equal(log.json.run.text, "Done");
  assert.ok(log.json.durationMs >= 0);
  assert.ok(log.json.events.some((e: any) => e.message.role === "assistant"));
  assert.equal((await r.call(`/v1/runs/${run.json.id}/log`, { token: OTHER_OPERATOR })).status, 404);
  await r.call(`/v1/agents/${agent}`, { method: "DELETE" });
  assert.equal((await r.call("/v1/usage?groupBy=agent")).json.groups.find((g: any) => g.agent === agent).responses, 1);
}, {});


contractTest("observability", "tests/observability.test.ts:2", "retained logs include tool arguments, results and failed-run details", async (_t, r) => {
  r.setModel(body => body.messages.some((m: any) => m.role === "tool")
    ? { role: "assistant", content: "Finished" }
    : toolCall("codemode", { code: "return 6 * 7" }));
  const response = await r.call("/v1/runs?wait=30", { body: { input: "Compute", codeMode: true } });
  assert.equal(response.status, 200, response.text);
  const log = (await r.call(`/v1/runs/${response.json.id}/log`)).json;
  assert.ok(log.events.some((e: any) => e.message.role === "assistant" && e.message.content.some((c: any) => c.type === "toolCall")));
  assert.ok(log.events.some((e: any) => e.message.role === "toolResult"));
  assert.ok(log.events.some((e: any) => e.message.role === "assistant" && e.message.content.some((c: any) => c.type === "toolCall" && c.arguments.code === "return 6 * 7")));
  r.setModel(() => ({ httpStatus: 402, message: "Insufficient test credit" }));
  const failed = await r.call("/v1/runs?wait=30", { body: { input: "Fail" } });
  const failedLog = (await r.call(`/v1/runs/${failed.json.id}/log`)).json;
  assert.equal(failedLog.run.status, "failed");
  assert.ok(failedLog.run.error.message);
}, {});
