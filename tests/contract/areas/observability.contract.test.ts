import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contractTest, createContractFixture, listen, OTHER_OPERATOR, toolCall } from "../support.ts";

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
  const deleted = await r.call(`/v1/agents/${agent}/usage`);
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(deleted.json.totals.responses, 1);
  assert.equal((await r.call(`/v1/agents/${agent}/usage`, { token: OTHER_OPERATOR })).status, 404);
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


contractTest("observability", "tests/observability.test.ts:3", "usage pages preserve totals, validate bounds and isolate tenants", async (_t, r) => {
  r.setModel(() => ({ role: "assistant", content: "Done", usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.2 } }));
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const agent = (await r.call("/v1/agents", { body: { name: "page-" + i } })).json.id;
    ids.push(agent);
    await r.prompt(agent, "Test");
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  let first: string | undefined;
  do {
    const page = await r.call("/v1/usage?groupBy=agent&limit=1" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    assert.equal(page.status, 200, page.text);
    assert.equal(page.json.groups.length, 1);
    assert.equal(page.json.totals.responses, 3);
    seen.push(page.json.groups[0].agent);
    cursor = page.json.next;
    first ??= cursor;
  } while (cursor);
  assert.deepEqual(seen.sort(), ids.sort());
  assert.equal((await r.call("/v1/usage?groupBy=agent&cursor=" + encodeURIComponent(first!), { token: OTHER_OPERATOR })).status, 400);
  for (const days of ["0", "-1", "366", "1.5", "no"]) assert.equal((await r.call("/v1/usage?days=" + days)).status, 400);
  for (const days of ["1", "365"]) assert.equal((await r.call("/v1/usage?days=" + days)).status, 200);
  for (const limit of ["0", "501", "1.1", "no"]) assert.equal((await r.call("/v1/usage?groupBy=agent&limit=" + limit)).status, 400);
  assert.equal((await r.call("/v1/usage", { token: null })).status, 401);
  assert.equal((await r.call(`/v1/agents/${ids[0]}/usage`, { token: null })).status, 401);
}, {});

contractTest("observability", "tests/observability.test.ts:4", "rolled-up child usage respects workspace filters", async (_t, r) => {
  r.setModel(body => {
    const child = JSON.stringify(body.messages.filter((m: any) => ["system", "developer", "user"].includes(m.role))).includes("HELPER");
    const reply = child || body.messages.some((m: any) => m.role === "tool")
      ? { role: "assistant", content: "Done" } : toolCall("delegate", { instructions: "You are HELPER.", task: "help" });
    return { ...reply, usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.2 } };
  });
  const workspace = (await r.call("/v1/workspaces", { body: { name: "Usage workspace" } })).json.id;
  const parent = (await r.call("/v1/agents", { body: { workspaceId: workspace, systemPrompt: "LEAD", builtins: ["delegate"], delegate: { instructions: true } } })).json.id;
  await r.prompt(parent, "Delegate");
  const all = await r.call(`/v1/usage?groupBy=agent&rollup=true&workspaceId=${workspace}`);
  assert.equal(all.status, 200, all.text);
  assert.equal(all.json.groups.length, 1);
  assert.equal(all.json.groups[0].agent, parent);
  assert.equal(all.json.totals.responses, 3);
  const own = await r.call(`/v1/agents/${parent}/usage?workspaceId=${workspace}`);
  const rolled = await r.call(`/v1/agents/${parent}/usage?rollup=true&workspaceId=${workspace}`);
  assert.equal(own.json.totals.responses, 2);
  assert.equal(rolled.json.totals.responses, 3);
  assert.equal((await r.call("/v1/usage?groupBy=agent&rollup=true&workspaceId=unassigned")).json.totals.responses, 0);
}, {});

contractTest("observability", "tests/observability.test.ts:5", "run logs page forward and mark oversized messages without exceeding byte limits", async (_t, r) => {
  r.setModel(() => ({ role: "assistant", content: "result".repeat(12000) }));
  const created = await r.call("/v1/runs?wait=30", { body: { input: "input".repeat(8000) } });
  assert.equal(created.status, 200, created.text);
  const path = `/v1/runs/${created.json.id}/log`;
  let cursor: string | undefined;
  const indices: number[] = [];
  let truncated = false;
  do {
    const page = await r.call(path + "?limit=1" + (cursor ? "&cursor=" + cursor : ""));
    assert.equal(page.status, 200, page.text);
    assert.ok(Buffer.byteLength(page.text) <= 256 * 1024);
    assert.equal(page.json.events.length, 1);
    for (const event of page.json.events) {
      assert.ok(Buffer.byteLength(JSON.stringify(event.message)) <= 16 * 1024);
      truncated ||= !!event.truncated;
      indices.push(event.index);
    }
    cursor = page.json.next;
  } while (cursor);
  assert.deepEqual(indices, indices.map((_, i) => i));
  assert.ok(truncated);
  for (const query of ["limit=0", "limit=101", "cursor=-1", "cursor=bad"])
    assert.equal((await r.call(path + "?" + query)).status, 400);
  assert.equal((await r.call(path, { token: null })).status, 401);
}, {});

contractTest("observability", "tests/observability.test.ts:6", "unattributed decisions remain one null-agent group with summed usage", async t => {
  const token = "observability-operator-at-least-24-chars";
  const provider = await listen(t, async (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      model: "typesafe/jev-1.14-20261014", answers: { q: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 400, output_tokens: 70, cost: 0.01 }, provider: "TypeSafe",
    }));
  });
  const r = await createContractFixture(t, {
    env: { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_DECISIONS_URL: provider },
    tenants: { tenants: { own: { tokenSha256: createHash("sha256").update(token).digest("hex"), apiKeys: { openrouter: "fixture-key" }, platformKeys: false } } },
  });
  for (let i = 0; i < 2; i++) {
    const response = await r.call("/v1/decisions", { token, body: { state: "Test", subject: "reader", questions: { q: { type: "noul", instructions: "Test" } } } });
    assert.equal(response.status, 200, response.text);
  }
  const usage = await r.call("/v1/usage?groupBy=agent,endUser&limit=1", { token });
  assert.equal(usage.status, 200, usage.text);
  assert.equal(usage.json.groups.length, 1);
  assert.equal(usage.json.groups[0].agent, null);
  assert.equal(usage.json.groups[0].endUser, "reader");
  assert.equal(usage.json.groups[0].responses, 2);
  assert.equal(usage.json.groups[0].input, 800);
  assert.equal(usage.json.groups[0].cost, 0.02);
  assert.equal(usage.json.next, undefined);
});
