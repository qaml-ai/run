import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { deliveryLine, errorClass, metricLine, observeContextMetrics, observeTurns, recordContextRange, recordToolResultSize, recordEventMetrics, recordWatchRefused, setMetricService, setMetricSink, timedStorage, webhookBacklogLine } from "../src/metrics.ts";
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

test("context metrics use only ServiceName, with agent ids as properties", async () => {
  setMetricService("runtime-test");
  let lines: any[];
  try {
    lines = await captured(() => {
      observeContextMetrics(() => "agent-private").request(60_000, 20_000);
      recordContextRange("agent-private", { bytes: 123_456, entries: 789 });
      recordToolResultSize("agent-private", { details: { text: "é" }, content: [
        { type: "image", data: "YWJj" }, { type: "image", data: "ZA==" }, { type: "text", data: "not an image" },
      ] });
    });
  } finally { setMetricService(undefined); }
  for (const line of lines!) {
    assert.deepEqual(directive(line).Dimensions, [["ServiceName"]]);
    assert.equal(line.agent, "agent-private");
    assert.equal(directive(line).Namespace, "AgentRuntime");
  }
  assert.equal(lines![0].held_tokens, 60_000);
  assert.equal(lines![0].sent_tokens, 20_000);
  assert.equal(lines![0].held_sent_ratio, 3);
  assert.deepEqual(directive(lines![0]).Metrics, [
    { Name: "held_tokens", Unit: "Count" }, { Name: "sent_tokens", Unit: "Count" }, { Name: "held_sent_ratio", Unit: "None" },
  ]);
  assert.equal(lines![1].context_range_bytes, 123_456);
  assert.equal(lines![1].context_range_entries, 789);
  assert.equal(lines![2].tool_result_details_bytes, Buffer.byteLength(JSON.stringify({ text: "é" })));
  assert.equal(lines![2].tool_result_inline_image_bytes, 8);
  for (const [line, names] of [[lines![1], ["context_range_bytes"]], [lines![2], ["tool_result_details_bytes", "tool_result_inline_image_bytes"]]] as const)
    for (const name of names) assert.equal(directive(line).Metrics.find((metric: any) => metric.Name === name).Unit, "Bytes");
  assert.ok(!JSON.stringify(lines!).includes("not an image"));
  assert.ok(!JSON.stringify(lines!).includes("YWJj"));
  assert.ok(!JSON.stringify(lines!).includes("é"));
});

test("divergence requires both strict thresholds and warns once per host run", async () => {
  const metrics = observeContextMetrics(() => "a1");
  const lines = await captured(() => {
    metrics.request(50_000, 1);
    metrics.request(60_000, 15_000);
    metrics.request(60_001, 15_000);
    metrics.request(100_000, 1);
    metrics.reset();
    metrics.request(60_001, 15_000);
  });
  assert.equal(lines.filter(line => line.type === "context_request").length, 5);
  assert.deepEqual(lines.filter(line => line.type === "context_divergence"), [
    { type: "context_divergence", agent: "a1", held: 60_001, sent: 15_000 },
    { type: "context_divergence", agent: "a1", held: 60_001, sent: 15_000 },
  ]);
});

test("zero sent tokens omit an undefined ratio but still detect divergence", async () => {
  const lines = await captured(() => observeContextMetrics(() => "a1").request(50_001, 0));
  assert.equal(lines[0].held_tokens, 50_001);
  assert.equal(lines[0].sent_tokens, 0);
  assert.ok(!("held_sent_ratio" in lines[0]));
  assert.ok(!directive(lines[0]).Metrics.some((metric: any) => metric.Name === "held_sent_ratio"));
  assert.equal(lines[1].type, "context_divergence");
});

test("tool sizes count JSON null, omit absent details, and ignore file references", async () => {
  const lines = await captured(() => {
    recordToolResultSize("a1", { content: [{ type: "file", data: "reference" }] });
    recordToolResultSize("a1", { details: null, content: [] });
  });
  assert.equal(lines[0].tool_result_details_bytes, 0);
  assert.equal(lines[0].tool_result_inline_image_bytes, 0);
  assert.equal(lines[1].tool_result_details_bytes, 4);
});

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
  assert.equal(errorClass("This turn exhausted its 2 node-loss resumes and was not resumed again"), "resume_limit");
  assert.equal(errorClass("429 Too Many Requests"), "rate_limit");
  assert.equal(errorClass("Rate limit exceeded for model"), "rate_limit");
  assert.equal(errorClass("Overloaded"), "overloaded");
  assert.equal(errorClass("prompt is too long: 250000 tokens > 200000 maximum"), "context_overflow");
  // OpenRouter refusing a request's image content (a 413 within milliseconds): its own class, not other.
  assert.equal(errorClass('413 {"message":"Downloaded image content cannot exceed 30MB","code":413}'), "image_limit");
  assert.equal(errorClass("401 Unauthorized: invalid x-api-key"), "auth");
  assert.equal(errorClass("402 Insufficient credits"), "billing");
  // OpenRouter's refusal when the platform account cannot reserve a response's max_tokens (the billing-errors alarm).
  assert.equal(errorClass("402 This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 9120."), "billing");
  assert.equal(errorClass("Request timed out"), "timeout");
  assert.equal(errorClass("502 Bad Gateway"), "provider_5xx");
  assert.equal(errorClass("fetch failed: ECONNRESET"), "network");
  assert.equal(errorClass("The runtime restarted during this request"), "runtime_restart");
  for (const error of ["Compaction failed: Summarization failed: Network connection lost", "Summarization failed: 429", "Compaction failed: context window exceeded"])
    assert.equal(errorClass(error), "compaction");
  assert.equal(errorClass("something else"), "other");
  assert.equal(errorClass(undefined), "none");
});

test("a turn's line: its outcome, duration, time to first token and to its first request, model responses and errors, tool calls and errors, retries", async () => {
  let now = 10_000;
  const turns = observeTurns(() => ({ provider: "openrouter", id: "openai/gpt-6-luna" }), () => now);
  const lines = await captured(async () => {
    const handle = turns.wrap(async (method: string) => {
      assert.equal(method, "prompt");
      now += 150;
      turns.event({ type: "turn_start" });
      now += 250;
      turns.event({ type: "message_start", message: { role: "assistant" } });
      now += 800;
      turns.event({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } });
      turns.event({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta" } });
      turns.event({ type: "message_end", message: { role: "assistant", provider: "openrouter", model: "openai/gpt-6-luna", stopReason: "error", errorMessage: "429 rate limited: my secret memo" } });
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
  assert.equal(modelError.error, "rate_limit (32 chars)", "a provider's error can echo the prompt: only its class and length are logged");

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
  assert.equal(turn.TimeToFirstRequestMs, 150, "the runtime's part: until the first model request starts");
  assert.equal(turn.ModelResponses, 3);
  assert.equal(turn.ModelErrors, undefined, "model_error lines count failed responses: no second count under the same name");
  assert.equal(turn.modelErrors, 1);
  assert.equal(turn.ModelRetries, 1);
  assert.equal(turn.ToolCalls, 2);
  assert.equal(turn.ToolErrors, 1);
  assert.deepEqual(directive(turn).Dimensions.map((set: string[]) => set.filter(name => name !== "ServiceName")),
    [[], ["Outcome"], ["ErrorClass"], ["Provider", "Model"]]);
});

test("a turn whose first model request waited says why: Pi storage, or the host's first turn", async () => {
  let now = 0;
  const turns = observeTurns(() => ({ provider: "openrouter", id: "m" }), () => now);
  /** A turn whose first request comes `ms` after it starts, `storageMs` of them in Pi storage. */
  const turn = (ms: number, storageMs = 0, during?: () => void) => turns.wrap(async () => {
    if (storageMs) await timedStorage(() => new Promise(resolve => setTimeout(resolve, storageMs)));
    during?.();
    now += ms;
    turns.event({ type: "turn_start" });
    return { messages: 1, error: null };
  })("prompt", {});
  const lines = await captured(async () => {
    await turn(2500);
    await turn(3000, 1600);
    await turn(2500);
    await turn(100);
  });
  const metrics = lines.filter(line => line.type === "turn_metrics");
  assert.deepEqual(metrics.map(line => line.slowFirstRequest), ["first_turn", "storage", "other", undefined]);
  assert.deepEqual(metrics.map(line => line.firstTurn), [true, false, false, false]);
  assert.ok(metrics[1].FirstRequestStorageMs >= 1500, "the storage time is a metric");
});

test("turn outcomes: a model error, input required, the spend limit, a thrown error, a caller's abort; other methods are not turns", async () => {
  const turns = observeTurns(() => ({ provider: "anthropic", id: "claude-sonnet-5" }));
  const lines = await captured(async () => {
    await turns.wrap(async () => ({ messages: 2, error: "503 Service Unavailable" }))("continue", {});
    await turns.wrap(async () => ({ messages: 2, error: null, stopped: "input_required" }))("resume", {});
    await turns.wrap(async () => ({ messages: 2, error: null, stopped: "spend_limit" }))("prompt", {});
    // As the host returns them: a limit's stop carries its reason as the error.
    await turns.wrap(async () => ({ messages: 2, error: "This run stopped at its limit of 3 model responses", code: "turn_limit", stopped: "turn_limit" }))("prompt", {});
    await assert.rejects(turns.wrap(async () => { throw new Error("Session closed"); })("prompt", {}), /Session closed/);
    // Stopped by its caller, as the host returns it (code aborted), and as Pi words an abort without the code.
    await turns.wrap(async () => ({ messages: 2, error: "The run was aborted", code: "aborted" }))("prompt", {});
    await turns.wrap(async () => ({ messages: 2, error: "Request was aborted" }))("prompt", {});
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
  assert.deepEqual(outcomes, [["failed", "provider_5xx"], ["input_required", "none"], ["spend_limit", "none"], ["turn_limit", "none"], ["failed", "exception"], ["aborted", "aborted"], ["aborted", "aborted"], ["completed", "none"]]);
  const noFirstToken = lines.find(line => line.type === "turn_metrics");
  assert.equal(noFirstToken.TimeToFirstTokenMs, undefined, "no token, no time to first token");
  assert.equal(noFirstToken.TimeToFirstRequestMs, undefined, "no request, no time to it");
});

test("run and usage events: counted by tenant as they are written, with runtime restarts and resumes", async () => {
  const events = [
    webhookEvent("run.started", "chiridion-prod", { agentId: "a", requestId: "r1", method: "prompt" }),
    webhookEvent("run.started", "chiridion-prod", { agentId: "a", requestId: "r2", method: "continue", resumes: 1 }),
    webhookEvent("run.completed", "chiridion-prod", { agentId: "a", requestId: "r1", usage: null }),
    webhookEvent("run.completed", "chiridion-prod", { agentId: "a", requestId: "r3", usage: null, stopped: "input_required" }),
    webhookEvent("run.completed", "chiridion-prod", { agentId: "a", requestId: "r5", usage: null, stopped: "turn_limit" }),
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
  assert.equal(runs[0].RunsCompleted, 3);
  assert.equal(runs[0].RunsTurnLimited, 1);
  assert.equal(runs[0].RunsInputRequired, 1);
  assert.equal(runs[0].RunsFailed, 2);
  assert.equal(runs[0].RunsUncertain, 1);

  const failures = lines.filter(line => line.type === "run_failed").map(line => [line.Tenant, line.ErrorClass, line.RunsFailedByClass]);
  assert.deepEqual(failures.sort(), [["chiridion-prod", "rate_limit", 1], ["chiridion-prod", "runtime_restart", 1]]);

  const cost = lines.filter(line => line.type === "model_cost").map(line => [line.Tenant, line.Provider, line.Model, line.ModelCostUsd, line.ModelUsageEvents]);
  assert.deepEqual(cost.sort(), [["chiridion-prod", "openrouter", "openai/gpt-6-luna", 0.75, 2], ["miguel", "anthropic", "claude-sonnet-5", 1, 1]]);
});

test("model_cost: tokens and the serving host as fields, a line per host, never a dimension", async () => {
  const usage = (host: string | undefined, input: number, cacheRead: number, output: number, usd: number) => ({
    ...webhookEvent("usage.recorded", "camel-bots", { agentId: "a", provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017:morph", input, output, cacheRead, cacheWrite: 0, cost: { usd, source: "provider" } }),
    ...(host ? { host } : {}),
  });
  const lines = await captured(() => recordEventMetrics([usage("Morph", 1000, 99_000, 500, 0.001), usage("Morph", 2000, 98_000, 300, 0.002), usage("Together", 500, 9_500, 100, 0.003), usage(undefined, 10, 0, 1, 0.0001)]));
  const cost = lines.filter(line => line.type === "model_cost");
  assert.deepEqual(cost.map(line => [line.host, line.inputTokens, line.cacheReadTokens, line.cacheWriteTokens, line.outputTokens, line.ModelUsageEvents]).sort(),
    [["Morph", 3000, 197_000, 0, 800, 2], ["Together", 500, 9_500, 0, 100, 1], ["unknown", 10, 0, 0, 1, 1]]);
  for (const line of cost) assert.ok(directive(line).Dimensions.every((set: string[]) => !set.includes("host") && !set.includes("Host")));
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

test("an event stream subscriber refused at a limit: counted by the limit's scope and tenant", async () => {
  const lines = await captured(() => { recordWatchRefused("tenant", "chiridion-prod"); recordWatchRefused("agent", "chiridion-prod"); });
  assert.deepEqual(lines.map(line => [line.type, line.Scope, line.Tenant, line.WatchersRefused]), [["watch_refused", "tenant", "chiridion-prod", 1], ["watch_refused", "agent", "chiridion-prod", 1]]);
  assert.deepEqual(directive(lines[0]).Dimensions.map((set: string[]) => set.filter(name => name !== "ServiceName")), [[], ["Scope"], ["Tenant"]]);
});

test("the spend, provider-credit and turn-failure alarms read metrics as the runtime emits them", async () => {
  const terraform = readFileSync(new URL("../infra/terraform/observability.tf", import.meta.url), "utf8");
  setMetricService("camelai-agent-runtime");
  const lines = await captured(() => {
    recordEventMetrics([webhookEvent("usage.recorded", "acme", { agentId: "a", provider: "openrouter", model: "m", cost: { usd: 2, source: "provider" } })]);
    const turns = observeTurns(() => ({ provider: "openrouter", id: "m" }));
    turns.event({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "402 This request requires more credits, or fewer max_tokens" } });
    return turns.wrap(async () => ({ messages: 2, error: "402 This request requires more credits, or fewer max_tokens" }))("prompt", {});
  }).finally(() => setMetricService(undefined));
  // The top-tenant query groups ModelCostUsd by the {ServiceName, Tenant} set the runtime writes.
  const cost = directive(lines.find(line => line.type === "model_cost"));
  assert.ok(cost.Dimensions.some((set: string[]) => set.join() === "ServiceName,Tenant"));
  assert.ok(cost.Metrics.some((metric: any) => metric.Name === "ModelCostUsd"));
  assert.match(terraform, /SELECT SUM\(ModelCostUsd\) FROM SCHEMA\(AgentRuntime, ServiceName, Tenant\) WHERE ServiceName = '\$\{local\.service_name\}' GROUP BY Tenant ORDER BY SUM\(\) DESC LIMIT 1/);
  assert.match(terraform, /variable "tenant_spend_alarm_usd_per_hour" \{[^}]*default\s+= 50/);
  // Failed turns are counted (not their retried responses) in the {ServiceName, ErrorClass} set, class billing.
  const turn = lines.find(line => line.type === "turn_metrics");
  assert.equal(turn.Outcome, "failed");
  assert.equal(turn.ErrorClass, "billing");
  assert.ok(directive(turn).Dimensions.some((set: string[]) => set.join() === "ServiceName,ErrorClass"));
  assert.ok(directive(turn).Metrics.some((metric: any) => metric.Name === "Turns"));
  const alarm = (name: string) => terraform.slice(terraform.indexOf(`resource "aws_cloudwatch_metric_alarm" "${name}"`)).split("\n}\n")[0];
  // The billing-errors alarm counts runs on the platform's keys refused for credit (model_billing_failed, KeyOwner platform), never a tenant's own.
  for (const setting of [/metric_name\s+= "ModelBillingFailures"/, /KeyOwner = "platform"/, /period\s+= 900\n/, /threshold\s+= 2\n/, /comparison_operator = "GreaterThanOrEqualToThreshold"/]) assert.match(alarm("model_billing_errors"), setting);
  // The turn-failures alarm divides the {ServiceName, Outcome} set's failed turns by the {ServiceName} set's turns.
  assert.ok(directive(turn).Dimensions.some((set: string[]) => set.join() === "ServiceName,Outcome"));
  assert.ok(directive(turn).Dimensions.some((set: string[]) => set.join() === "ServiceName"));
  const failures = alarm("turn_failures");
  for (const setting of [/IF\(total >= 5, failed \/ total, 0\)/, /evaluation_periods\s+= 2\n/, /threshold\s+= 0\.4\n/, /Outcome = "failed"/]) assert.match(failures, setting);
  assert.equal(failures.match(/period\s+= 900\n/g)?.length, 2);
});

test("a turn a limit stopped says whose and which limit; any other turn does not name its tenant", async () => {
  const lines = await captured(async () => {
    const turns = observeTurns(() => ({ provider: "openrouter", id: "m" }), Date.now, () => "camel-bots");
    await turns.wrap(async () => ({ error: "This end user is out of credit: spent", code: "end_user_credit", stopped: "spend_limit", limit: "end_user", reason: "balance", endUser: "person", bucket: "b" }))("prompt", {});
    await turns.wrap(async () => ({ error: "This run stopped at its limit of 3 model responses", code: "turn_limit", stopped: "turn_limit" }))("prompt", {});
    await turns.wrap(async () => ({ error: null }))("prompt", {});
  });
  const [spend, turn, plain] = lines.filter(line => line.type === "turn_metrics");
  assert.deepEqual([spend.Outcome, spend.tenant, spend.limit, spend.limitReason], ["spend_limit", "camel-bots", "end_user", "balance"]);
  assert.deepEqual([turn.Outcome, turn.tenant, turn.limit], ["turn_limit", "camel-bots", undefined]);
  assert.deepEqual([plain.Outcome, plain.tenant], ["completed", undefined]);
  assert.ok(!JSON.stringify(spend).includes("out of credit") && !JSON.stringify(spend).includes("person"), "never the message, nor whose credit");
});

test("each model response logs its time, first token and the host that served it, never its text", async () => {
  let now = 1_000;
  const lines = await captured(() => {
    const turns = observeTurns(() => ({ provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017:nitro" }), () => now, () => "camel-bots");
    // The request starts; its stream's headers come 600 ms later.
    turns.event({ type: "turn_start" });
    now += 600;
    turns.event({ type: "message_start", message: { role: "assistant" } });
    now += 900;
    turns.event({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "a secret plan" } });
    now += 4_100;
    turns.event({ type: "message_end", message: { role: "assistant", provider: "openrouter", model: "deepseek/deepseek-v4.1-flash-1017:nitro", stopReason: "toolUse", content: [{ type: "text", text: "my secret memo" }], usage: { output: 321, providerHost: "Parasail" } } });
    // A response with no host said (another provider, an older runtime): "unknown"; an error's response too.
    turns.event({ type: "message_start", message: { role: "assistant" } });
    now += 2_000;
    turns.event({ type: "message_end", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", stopReason: "error", errorMessage: "529 overloaded", usage: {} } });
    // A message_end with no start (a resumed stream): no line.
    turns.event({ type: "message_end", message: { role: "assistant", provider: "openrouter", model: "x", stopReason: "stop", usage: {} } });
  });
  const responses = lines.filter(line => line.type === "model_response");
  assert.equal(responses.length, 2);
  const [first, second] = responses;
  assert.deepEqual([first.Provider, first.Model, first.Host, first.ResponseMs, first.ResponseFirstTokenMs, first.RequestFirstTokenMs, first.stopReason, first.outputTokens, first.tenant],
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017:nitro", "Parasail", 5_000, 900, 1_500, "toolUse", 321, "camel-bots"]);
  // One metric set, by model and host: ResponseMs by Model and Host on the dashboard.
  assert.equal(first._aws.CloudWatchMetrics[0].Dimensions.length, 1);
  assert.deepEqual(first._aws.CloudWatchMetrics[0].Dimensions[0].filter((name: string) => name !== "ServiceName"), ["Provider", "Model", "Host"]);
  assert.deepEqual([second.Host, second.ResponseMs, second.ResponseFirstTokenMs, second.RequestFirstTokenMs, second.stopReason], ["unknown", 2_000, undefined, undefined, "error"]);
  const text = JSON.stringify(responses);
  assert.ok(!text.includes("secret"), "no text of a response, its reasoning or its error");
});
