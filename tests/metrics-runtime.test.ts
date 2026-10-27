import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { listen, OPERATOR, OTHER_OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_USAGE_WEBHOOK_RETRY_MS: "100", AGENT_SERVICE_NAME: "agent-runtime-test", AGENT_HOSTING: "inline" };

test("a running runtime (inline hosting, as on ECS) writes metric lines: each turn, its run events and usage, and each webhook delivery", async t => {
  let status = 500;
  const url = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(status).end();
  });
  const r = await runtime(t, (_body, index) => index === 0
    ? { ...toolCall("no_such_tool", {}, "call_1"), usage: { prompt_tokens: 100, completion_tokens: 10 } }
    : { role: "assistant", content: "Done", usage: { prompt_tokens: 120, completion_tokens: 5 } }, LOCAL);
  const events = ["run.started", "run.completed", "run.failed", "usage.recorded"];
  assert.equal((await r.call("/v1/webhooks", { body: { url, events } })).status, 201);

  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(agent, "Go");
  const lines = () => r.logs.map(line => { try { return JSON.parse(line); } catch { return {}; } });
  const turn = await until(() => lines().find(line => line.type === "turn_metrics"), "a turn_metrics line");
  assert.equal(turn.ServiceName, "agent-runtime-test");
  assert.equal(turn.Outcome, "completed");
  assert.equal(turn.method, "prompt");
  assert.equal(turn.ModelResponses, 2);
  assert.equal(turn.ToolCalls, 1);
  assert.equal(turn.ToolErrors, 1, "the unknown tool's call failed");
  assert.ok(turn.TimeToFirstTokenMs >= 0 && turn.TurnDurationMs >= turn.TimeToFirstTokenMs);
  assert.ok(lines().some(line => line.type === "tool_failed" && line.toolName === "no_such_tool"));
  const context = lines().filter(line => line.type === "context_request" && line.agent === agent);
  assert.equal(context.length, 2, "one context metric per model request");
  for (const line of context) {
    assert.ok(line.held_tokens > 0 && line.sent_tokens > 0);
    assert.equal(line.held_sent_ratio, line.held_tokens / line.sent_tokens);
    assert.deepEqual(line._aws.CloudWatchMetrics[0].Dimensions, [["ServiceName"]]);
  }
  const ranges = lines().filter(line => line.type === "context_range" && line.agent === agent);
  assert.equal(ranges.length, 2, "one at host load and one at the run's first request");
  assert.ok(ranges[1].context_range_bytes > 0 && ranges[1].context_range_entries > 0);
  const results = lines().filter(line => line.type === "tool_result_size" && line.agent === agent);
  assert.equal(results.length, 1, "one metric for the committed unavailable-tool result");
  assert.equal(results[0].tool_result_inline_image_bytes, 0);

  const runs = await until(() => lines().filter(line => line.type === "run_events").reduce((sum, line) => sum + (line.RunsCompleted ?? 0), 0) >= 1 && lines().filter(line => line.type === "run_events"), "run_events");
  assert.ok(runs.every(line => line.Tenant === "alice"), JSON.stringify(runs.map(line => line.Tenant)));
  assert.ok(await until(() => lines().some(line => line.type === "model_cost" && line.ModelUsageEvents >= 1), "model_cost"));

  const failed = await until(() => lines().find(line => line.type === "webhook_failed"), "a failed delivery");
  assert.equal(failed.Kind, "endpoint");
  assert.equal(failed.error, "HTTP 500");
  status = 204;
  const delivered = await until(() => lines().find(line => line.type === "webhook_delivered" && line.WebhookAttempts >= 2), "a retried delivery");
  assert.ok(delivered.WebhookDeliveryLagMs >= 0);
});

test("a run its provider refused for credit (402) is counted by whose key: the platform's account, or a tenant's own", async t => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const tenantsFile = {
    tenants: { alice: { tokenSha256: sha(OPERATOR), apiKeys: {} }, bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: {} } },
    platformKeys: { openrouter: "fixture-platform-key" },
  };
  const r = await runtime(t, () => ({ httpStatus: 402, message: "This request requires more credits, or fewer max_tokens" }), LOCAL, tenantsFile);
  const lines = () => r.logs.map(line => { try { return JSON.parse(line); } catch { return {}; } }).filter(line => line.type === "model_billing_failed");
  // alice brings her own OpenRouter key; bob runs on the platform's.
  assert.equal((await r.call("/v1/providers/openrouter/key", { method: "PUT", body: { apiKey: "sk-or-alice-own-key" } })).status, 200);
  for (const token of [OPERATOR, OTHER_OPERATOR]) {
    const agent = (await r.call("/v1/agents", { body: {}, token })).json.id as string;
    const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "Go" }, token });
    assert.equal(accepted.status, 202, accepted.text);
  }
  const counted = await until(() => lines().length >= 2 && lines(), "two billing failures");
  assert.deepEqual(counted.map(line => [line.tenant, line.KeyOwner, line.ModelBillingFailures]).sort(), [["alice", "tenant", 1], ["bob", "platform", 1]]);
});
