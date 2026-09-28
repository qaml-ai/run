import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryLine, errorClass, metricLine, observeTurns, recordEventMetrics, setMetricSink, webhookBacklogLine } from "../src/metrics.ts";
import { webhookEvent } from "../src/webhooks.ts";

/** Capture the metric lines written while `fn` runs. */
async function captured(fn: () => unknown | Promise<unknown>) {
  const lines: any[] = [];
  setMetricSink(line => lines.push(JSON.parse(line)));
  try { await fn(); } finally { setMetricSink(); }
  return lines;
}

/** The metric names and dimension sets CloudWatch would extract from an EMF line. */
const directive = (line: any) => line._aws.CloudWatchMetrics[0];

test("a metric line is CloudWatch EMF: namespace AgentRuntime, ServiceName in every dimension set, values at the root", () => {
  const line = JSON.parse(metricLine("turn_metrics", {
    dimensions: { Outcome: "completed", Provider: "openrouter" }, rollups: [[], ["Outcome"], ["Provider"]],
    metrics: { Turns: 1, TurnDurationMs: [1500, "Milliseconds"] }, properties: { agent: "a1" },
  }, "camelai-agent-runtime", 1000));
  assert.equal(line.type, "turn_metrics");
  assert.equal(line._aws.Timestamp, 1000);
  assert.equal(directive(line).Namespace, "AgentRuntime");
  assert.deepEqual(directive(line).Dimensions, [["ServiceName"], ["ServiceName", "Outcome"], ["ServiceName", "Provider"]]);
  assert.deepEqual(directive(line).Metrics, [{ Name: "Turns", Unit: "Count" }, { Name: "TurnDurationMs", Unit: "Milliseconds" }]);
  assert.equal(line.ServiceName, "camelai-agent-runtime");
  assert.equal(line.Outcome, "completed");
  assert.equal(line.Turns, 1);
  assert.equal(line.TurnDurationMs, 1500);
  assert.equal(line.agent, "a1");

  const bare = JSON.parse(metricLine("x", { dimensions: {}, rollups: [[]], metrics: { N: 2 } }, undefined));
  assert.deepEqual(directive(bare).Dimensions, [[]], "no service name: the metric has no dimension");
});

test("model and run errors are sorted into a few classes", () => {
  assert.equal(errorClass("429 Too Many Requests"), "rate_limit");
  assert.equal(errorClass("Rate limit exceeded for model"), "rate_limit");
  assert.equal(errorClass("Overloaded"), "overloaded");
  assert.equal(errorClass("prompt is too long: 250000 tokens > 200000 maximum"), "context_overflow");
  assert.equal(errorClass("401 Unauthorized: invalid x-api-key"), "auth");
  assert.equal(errorClass("402 Insufficient credits"), "billing");
  assert.equal(errorClass("Request timed out"), "timeout");
  assert.equal(errorClass("502 Bad Gateway"), "provider_5xx");
  assert.equal(errorClass("fetch failed: ECONNRESET"), "network");
  assert.equal(errorClass("The runtime restarted during this request"), "runtime_restart");
  assert.equal(errorClass("something else"), "other");
  assert.equal(errorClass(undefined), "none");
});

test("a turn's line: its outcome, duration, time to first token, model responses and errors, tool calls and errors, retries", async () => {
  let now = 10_000;
  const turns = observeTurns(() => ({ provider: "openrouter", id: "openai/gpt-6-luna" }), () => now);
  const lines = await captured(async () => {
    const handle = turns.wrap(async (method: string) => {
      assert.equal(method, "prompt");
      now += 400;
      turns.event({ type: "message_start", message: { role: "assistant" } });
      now += 800;
      turns.event({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } });
      turns.event({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } });
      turns.event({ type: "message_end", message: { role: "assistant", provider: "openrouter", model: "openai/gpt-6-luna", stopReason: "error", errorMessage: "429 rate limited" } });
      turns.event({ type: "auto_retry_start", attempt: 1 });
      turns.event({ type: "message_end", message: { role: "assistant", provider: "openrouter", model: "openai/gpt-6-luna", stopReason: "toolUse" } });
      turns.event({ type: "tool_execution_end", toolName: "js_exec", isError: false });
      turns.event({ type: "tool_execution_end", toolName: "camel__query", isError: true, result: { content: [{ type: "text", text: "secret stuff" }] } });
      turns.event({ type: "message_end", message: { role: "toolResult" } });
      turns.event({ type: "message_end", message: { role: "assistant", provider: "openrouter", model: "openai/gpt-6-luna", stopReason: "stop" } });
      now += 2000;
      return { messages: 5, error: null, reply: "done" };
    });
    assert.deepEqual(await handle("prompt", {}), { messages: 5, error: null, reply: "done" });
  });

  const modelError = lines.find(line => line.type === "model_error");
  assert.equal(modelError.Provider, "openrouter");
  assert.equal(modelError.Model, "openai/gpt-6-luna");
  assert.equal(modelError.ErrorClass, "rate_limit");
  assert.equal(modelError.ModelErrors, 1);
  assert.equal(modelError.error, "429 rate limited");

  const toolError = lines.find(line => line.type === "tool_failed");
  assert.equal(toolError.toolName, "camel__query");
  assert.ok(!JSON.stringify(toolError).includes("secret stuff"), "a tool's result never goes to the logs");
  assert.equal(toolError._aws, undefined, "tool failures are a log line; the turn line counts them");

  const turn = lines.find(line => line.type === "turn_metrics");
  assert.equal(turn.Outcome, "completed");
  assert.equal(turn.ErrorClass, "none");
  assert.equal(turn.Provider, "openrouter");
  assert.equal(turn.Model, "openai/gpt-6-luna");
  assert.equal(turn.method, "prompt");
  assert.equal(turn.Turns, 1);
  assert.equal(turn.TurnDurationMs, 3200);
  assert.equal(turn.TimeToFirstTokenMs, 1200);
  assert.equal(turn.ModelResponses, 3);
  assert.equal(turn.ModelErrors, undefined, "model_error lines count failed responses: no second count under the same name");
  assert.equal(turn.modelErrors, 1);
  assert.equal(turn.ModelRetries, 1);
  assert.equal(turn.ToolCalls, 2);
  assert.equal(turn.ToolErrors, 1);
  assert.deepEqual(directive(turn).Dimensions.map((set: string[]) => set.filter(name => name !== "ServiceName")),
    [[], ["Outcome"], ["ErrorClass"], ["Provider", "Model"]]);
});

test("turn outcomes: a model error, input required, the spend limit, a thrown error; other methods are not turns", async () => {
  const turns = observeTurns(() => ({ provider: "anthropic", id: "claude-sonnet-5" }));
  const lines = await captured(async () => {
    await turns.wrap(async () => ({ messages: 2, error: "503 Service Unavailable" }))("continue", {});
    await turns.wrap(async () => ({ messages: 2, error: null, stopped: "input_required" }))("resume", {});
    await turns.wrap(async () => ({ messages: 2, error: null, stopped: "spend_limit" }))("prompt", {});
    await assert.rejects(turns.wrap(async () => { throw new Error("Session closed"); })("prompt", {}), /Session closed/);
    await turns.wrap(async () => ({ ok: true }))("init", {});
    await turns.wrap(async () => ({ value: 1 }))("execute", {});
    // A second turn sent while one runs is refused by the host: it is no turn, and the running one is untouched.
    const running = Promise.withResolvers<any>();
    const handle = turns.wrap((_method: string) => _method === "prompt" && !busy ? (busy = true, running.promise) : Promise.reject(new Error("Agent is busy")));
    let busy = false;
    const first = handle("prompt", {});
    await assert.rejects(handle("continue", {}), /busy/);
    running.resolve({ messages: 1, error: null });
    await first;
  });
  const outcomes = lines.filter(line => line.type === "turn_metrics").map(line => [line.Outcome, line.ErrorClass]);
  assert.deepEqual(outcomes, [["failed", "provider_5xx"], ["input_required", "none"], ["spend_limit", "none"], ["failed", "exception"], ["completed", "none"]]);
  const noFirstToken = lines.find(line => line.type === "turn_metrics");
  assert.equal(noFirstToken.TimeToFirstTokenMs, undefined, "no token, no time to first token");
});

test("run and usage events: counted by tenant as they are written, with runtime restarts and resumes", async () => {
  const events = [
    webhookEvent("run.started", "chiridion-prod", { agentId: "a", requestId: "r1", method: "prompt" }),
    webhookEvent("run.started", "chiridion-prod", { agentId: "a", requestId: "r2", method: "continue", resumes: 1 }),
    webhookEvent("run.completed", "chiridion-prod", { agentId: "a", requestId: "r1", usage: null }),
    webhookEvent("run.completed", "chiridion-prod", { agentId: "a", requestId: "r3", usage: null, stopped: "input_required" }),
    webhookEvent("run.failed", "chiridion-prod", { agentId: "a", requestId: "r2", usage: null, error: "The runtime restarted during this request", uncertain: true }),
    webhookEvent("run.failed", "chiridion-prod", { agentId: "a", requestId: "r4", usage: null, error: "429 Too Many Requests" }),
    webhookEvent("usage.recorded", "chiridion-prod", { agentId: "a", provider: "openrouter", model: "openai/gpt-6-luna", cost: { usd: 0.25, source: "provider" } }),
    webhookEvent("usage.recorded", "chiridion-prod", { agentId: "b", provider: "openrouter", model: "openai/gpt-6-luna", cost: { usd: 0.5, source: "provider" } }),
    webhookEvent("usage.recorded", "miguel", { agentId: "c", provider: "anthropic", model: "claude-sonnet-5", cost: { usd: 1, source: "catalog" } }),
  ];
  const lines = await captured(() => recordEventMetrics(events));

  const runs = lines.filter(line => line.type === "run_events");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].Tenant, "chiridion-prod");
  assert.equal(runs[0].RunsStarted, 2);
  assert.equal(runs[0].RunsResumed, 1);
  assert.equal(runs[0].RunsCompleted, 2);
  assert.equal(runs[0].RunsInputRequired, 1);
  assert.equal(runs[0].RunsFailed, 2);
  assert.equal(runs[0].RunsUncertain, 1);

  const failures = lines.filter(line => line.type === "run_failed").map(line => [line.Tenant, line.ErrorClass, line.RunsFailedByClass]);
  assert.deepEqual(failures.sort(), [["chiridion-prod", "rate_limit", 1], ["chiridion-prod", "runtime_restart", 1]]);

  const cost = lines.filter(line => line.type === "model_cost").map(line => [line.Tenant, line.Provider, line.Model, line.ModelCostUsd, line.ModelUsageEvents]);
  assert.deepEqual(cost.sort(), [["chiridion-prod", "openrouter", "openai/gpt-6-luna", 0.75, 2], ["miguel", "anthropic", "claude-sonnet-5", 1, 1]]);
});

test("webhook deliveries: lag and attempts when delivered, the error when not; the backlog", () => {
  const delivered = JSON.parse(deliveryLine({ kind: "endpoint", tenant: "chiridion-prod", event: "evt_1", attempts: 2, lagMs: 7000 }));
  assert.equal(delivered.type, "webhook_delivered");
  assert.equal(delivered.Kind, "endpoint");
  assert.equal(delivered.WebhooksDelivered, 1);
  assert.equal(delivered.WebhookDeliveryLagMs, 7000);
  assert.equal(delivered.WebhookAttempts, 2);

  const failed = JSON.parse(deliveryLine({ kind: "usage", tenant: "t", event: "u1", attempts: 1, lagMs: 10, error: "HTTP 500" }));
  assert.equal(failed.type, "webhook_failed", "the log type alarms already match on");
  assert.equal(failed.error, "HTTP 500");
  assert.equal(failed.WebhooksFailed, 1);
  assert.equal(failed.WebhooksDelivered, undefined);

  const backlog = JSON.parse(webhookBacklogLine({ pending: 12, oldestAgeMs: 90_000 }));
  assert.equal(backlog.type, "webhook_backlog");
  assert.equal(backlog.WebhookBacklog, 12);
  assert.equal(backlog.WebhookOldestPendingMs, 90_000);
});
