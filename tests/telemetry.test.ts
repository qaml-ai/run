import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTraceparent, newSpanId, newTraceId, otlpJson, otlpProtobuf, parseTraceparent, sampledAt, SpanKind, type Span } from "../src/otlp.ts";
import { RunSpans, Telemetry } from "../src/telemetry.ts";
import { Outbound } from "../src/outbound.ts";
import { setMetricSink } from "../src/metrics.ts";
import { attach, runtime, toolCall, until } from "./runtime-server.ts";
import { decodeJson, decodeProtobuf, otlpReceiver, type ReceivedSpan } from "./otlp-receiver.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_TELEMETRY_INTERVAL_MS: "100", AGENT_TELEMETRY_RETRY_MS: "50" };
const CONTENT_KEYS = ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "input.value", "output.value", "camelrun.code", "camelrun.input.message", "camelrun.output"];

const sample = (overrides: Partial<Span> = {}): Span => ({
  traceId: newTraceId(), spanId: newSpanId(), parentSpanId: newSpanId(), name: "chat gpt", kind: SpanKind.client, start: 1_727_000_000_123.456, end: 1_727_000_001_000,
  attributes: { "gen_ai.usage.input_tokens": 120, "camelrun.cost.usd": { double: 0 }, "gen_ai.system": "openrouter", "error.type": undefined, "flag": true, "ratio": 0.25, "reasons": ["stop", "length"], "negative": -3 },
  status: { code: "error", message: "rate_limit" }, links: [{ traceId: newTraceId(), spanId: newSpanId() }], ...overrides,
});

test("OTLP: the protobuf and JSON encodings carry the same spans, exact to the microsecond", () => {
  const spans = [sample(), sample({ parentSpanId: undefined, status: undefined, links: undefined, kind: SpanKind.server })];
  const resource = { "service.name": "camelrun" };
  const scope = { name: "camelrun", version: "1.0.0" };
  const fromProto = decodeProtobuf(otlpProtobuf(resource, scope, spans));
  const fromJson = decodeJson(JSON.parse(JSON.stringify(otlpJson(resource, scope, spans))));
  assert.deepEqual(fromProto, fromJson);
  assert.equal(fromJson[0].start, 1_727_000_000_123.456);
  assert.deepEqual(fromJson[0].attributes, { "gen_ai.usage.input_tokens": 120, "camelrun.cost.usd": 0, "gen_ai.system": "openrouter", flag: true, ratio: 0.25, reasons: ["stop", "length"], negative: -3 });
  const json = otlpJson(resource, scope, spans) as any;
  assert.deepEqual(json.resourceSpans[0].scopeSpans[0].spans[0].attributes.find((entry: any) => entry.key === "camelrun.cost.usd").value, { doubleValue: 0 }, "a cost stays a double when it is whole");
  assert.equal(json.resourceSpans[0].scopeSpans[0].spans[0].status.code, 2);
});

test("traceparent: W3C version 00 parsed, invalid ones ignored; sampling decided by the trace id alone", () => {
  const header = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  assert.deepEqual(parseTraceparent(header), { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", sampled: true });
  assert.equal(formatTraceparent(parseTraceparent(header)!), header);
  assert.equal(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")?.sampled, false);
  assert.ok(parseTraceparent("01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra"), "a later version may carry more");
  for (const bad of [undefined, "", "garbage", "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra", "00-4bf92f-00f067aa0ba902b7-01"]) {
    assert.equal(parseTraceparent(bad), undefined, String(bad));
  }
  const ids = Array.from({ length: 2000 }, newTraceId);
  const kept = ids.filter(id => sampledAt(id, 0.25)).length;
  assert.ok(kept > 400 && kept < 600, `${kept} of 2000 at 0.25`);
  assert.deepEqual(ids.map(id => sampledAt(id, 0.25)), ids.map(id => sampledAt(id, 0.25)), "the same id, the same decision");
  assert.ok(ids.every(id => sampledAt(id, 1) && !sampledAt(id, 0)));
});

/** A Telemetry over a stub database: one tenant whose settings point at `endpoint`. */
function exporter(endpoint: string, options: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}, headers = { authorization: "Bearer otlp-secret-value" }) {
  const sealed = { iv: "", tag: "", ciphertext: JSON.stringify(headers) };
  const writes: string[] = [];
  const db = { query: async (sql: string) => {
    if (sql.startsWith("select endpoint")) return { rows: [{ endpoint, protocol: "http/json", sample_rate: 1, include_content: false, headers: sealed }] };
    writes.push(sql);
    return { rows: [], rowCount: 1 };
  } } as any;
  const accounts = { canStoreKeys: true, seal: () => sealed, unseal: (_aad: string, value: typeof sealed) => value.ciphertext } as any;
  const telemetry = new Telemetry({ db, accounts, outbound: new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] }), retryBaseMs: 20, ...options });
  return { telemetry, writes };
}

test("export: batched per tenant, retried with backoff on 503, bounded per tenant and per node, drops counted, failures logged without content or headers", async t => {
  const lines: string[] = [];
  setMetricSink(line => lines.push(line));
  const errors: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  t.after(() => { setMetricSink(); console.error = error; });

  // Two 503s, then accepted: the batch goes through on its third attempt.
  const flaky = await otlpReceiver(t, index => index < 2 ? 503 : 200);
  const { telemetry } = exporter(flaky.endpoint, { limits: { batch: 4 } });
  for (let i = 0; i < 6; i++) telemetry.record("alice", sample({ name: `span ${i}`, attributes: { "camelrun.prompt": "never in a log" } }));
  await until(async () => { await telemetry.flush(); return telemetry.totals.exported === 6; }, "every span exported");
  assert.deepEqual(flaky.spans.map(span => span.name), ["span 0", "span 1", "span 2", "span 3", "span 4", "span 5"], "in order, in batches of 4");
  assert.equal(flaky.requests[0].headers.authorization, "Bearer otlp-secret-value", "the tenant's headers are sent");
  assert.equal(flaky.requests[0].headers["content-type"], "application/json");
  assert.ok(flaky.requests.length >= 4, "the failed batch was sent again");
  const failed = errors.map(line => JSON.parse(line)).filter(line => line.type === "telemetry_export_failed");
  assert.equal(failed.length, 1, "one line for the failing spell");
  assert.match(failed[0].error, /HTTP|503/);
  assert.ok(!errors.join("").includes("otlp-secret-value") && !errors.join("").includes("never in a log"));
  const metrics = lines.map(line => JSON.parse(line)).filter(line => line.type === "telemetry_spans");
  assert.equal(metrics.reduce((sum, line) => sum + line.SpansExported, 0), 6);

  // A full queue drops what does not fit, and recording never waits.
  const hanging = await otlpReceiver(t, () => "hang");
  const bounded = exporter(hanging.endpoint, { limits: { tenantSpans: 10, nodeSpans: 15 } }).telemetry;
  const began = performance.now();
  for (let i = 0; i < 25; i++) bounded.record("alice", sample());
  for (let i = 0; i < 25; i++) bounded.record("bob", sample());
  assert.ok(performance.now() - began < 200, "recording is synchronous and cheap");
  assert.equal(bounded.pending, 15);
  assert.deepEqual({ ...bounded.totals.dropped }, { queue_full: 35 });
  // Shutting down sends what it can within its deadline; the rest is dropped and counted.
  void bounded.flush();
  await bounded.close(200);
  assert.equal(bounded.totals.dropped.shutdown, 15);
  assert.equal(bounded.pending, 0);

  // A 400 is not retried: the batch is dropped as rejected.
  const refusing = await otlpReceiver(t, 400);
  const rejecting = exporter(refusing.endpoint).telemetry;
  rejecting.record("alice", sample());
  await rejecting.flush();
  assert.deepEqual(rejecting.totals.dropped, { rejected: 1 });
  assert.equal(refusing.requests.length, 1);

  // Retries end: a batch that keeps failing is dropped after its attempts.
  const down = await otlpReceiver(t, 502);
  const giving = exporter(down.endpoint, { limits: { attempts: 3 } }).telemetry;
  giving.record("alice", sample());
  await until(async () => { await giving.flush(); return giving.totals.dropped.failed === 1; }, "the batch given up");
  assert.equal(down.requests.length, 3);
});

test("run spans: built from the run's events, content only when asked", () => {
  const recorded: Span[] = [];
  const trace = { traceId: newTraceId(), spanId: newSpanId(), parentSpanId: newSpanId(), sampled: true };
  const spans = (content: boolean) => new RunSpans({
    tenant: "alice", agent: { id: "client_x", name: "Support" }, request: { id: "req-1", method: "prompt", startedAt: 1_000, began: 1_100, prompt: "secret prompt" },
    trace, content, model: () => ({ provider: "openrouter", id: "openai/gpt-4o-mini" }), toolSource: name => name === "lookup" ? "attached" : "runtime", record: span => recorded.push(span),
  });
  const run = spans(false);
  run.event({ type: "turn_start" }, 1_200);
  run.event({ type: "message_start", message: { role: "assistant" } }, 1_300);
  const assistant = { role: "assistant", provider: "openrouter", model: "openai/gpt-4o-mini", stopReason: "toolUse", usage: { input: 100, output: 7, cacheRead: 30, cost: { total: 0.002 } }, content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "secret argument" } }] };
  run.event({ type: "message_end", message: assistant }, 1_400);
  run.event({ type: "tool_execution_start", toolCallId: "call_1", toolName: "lookup", args: { q: "secret argument" } }, 1_410);
  run.event({ type: "tool_execution_end", toolCallId: "call_1", toolName: "lookup", result: { content: [{ type: "text", text: "secret result" }] }, isError: false }, 1_500);
  run.event({ type: "turn_start" }, 1_510);
  run.event({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "429 rate limited: secret prompt echoed", usage: { input: 0, output: 0 } } }, 1_600);
  run.end({ result: { reply: "secret reply", usage: { responses: 2, input: 100, output: 7, cacheRead: 30, cacheWrite: 0, costUsd: 0.002 }, error: "429 rate limited", code: undefined } }, undefined, 1_700);
  const [chat, tool, failed, root] = recorded;
  assert.deepEqual([chat.name, tool.name, failed.name, root.name], ["chat openai/gpt-4o-mini", "execute_tool lookup", "chat openai/gpt-4o-mini", "invoke_agent Support"]);
  assert.deepEqual([chat.start, chat.end, tool.start, tool.end, failed.start, root.start, root.end], [1_200, 1_400, 1_410, 1_500, 1_510, 1_000, 1_700]);
  assert.ok(recorded.every(span => span.traceId === trace.traceId));
  assert.ok([chat, tool, failed].every(span => span.parentSpanId === trace.spanId));
  assert.equal(root.spanId, trace.spanId);
  assert.equal(root.parentSpanId, trace.parentSpanId);
  assert.deepEqual(chat.attributes, {
    "camelrun.tenant": "alice", "camelrun.agent.id": "client_x", "camelrun.request.id": "req-1",
    "gen_ai.operation.name": "chat", "gen_ai.system": "openrouter", "gen_ai.provider.name": "openrouter", "gen_ai.request.model": "openai/gpt-4o-mini", "gen_ai.response.model": "openai/gpt-4o-mini",
    "gen_ai.response.finish_reasons": ["tool_call"], "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 7, "gen_ai.usage.cache_read.input_tokens": 30, "gen_ai.usage.cache_creation.input_tokens": undefined,
    "camelrun.cost.usd": { double: 0.002 }, "gen_ai.usage.cost": { double: 0.002 },
  });
  assert.equal(tool.attributes["camelrun.tool.source"], "attached");
  assert.deepEqual(failed.status, { code: "error", message: "rate_limit" }, "an error's class, not its message");
  assert.equal(root.attributes["camelrun.run.status"], "failed");
  assert.equal(root.attributes["camelrun.run.queued_ms"], 100);
  assert.equal(root.attributes["camelrun.cost.usd"] && (root.attributes["camelrun.cost.usd"] as { double: number }).double, 0.002);
  const text = JSON.stringify(recorded);
  for (const secret of ["secret prompt", "secret argument", "secret result", "secret reply"]) assert.ok(!text.includes(secret), `${secret} exported without include.content`);

  recorded.length = 0;
  const withContent = spans(true);
  withContent.event({ type: "message_end", message: assistant }, 1_400);
  withContent.event({ type: "tool_execution_start", toolCallId: "call_1", toolName: "lookup", args: { q: "secret argument" } }, 1_410);
  withContent.event({ type: "tool_execution_end", toolCallId: "call_1", toolName: "lookup", result: { content: [{ type: "text", text: "secret result" }] }, isError: false }, 1_500);
  withContent.end({ result: { reply: "secret reply" } }, undefined, 1_700);
  assert.match(String(recorded[0].attributes["gen_ai.output.messages"]), /"tool_call".*secret argument/);
  assert.match(String(recorded[1].attributes["gen_ai.tool.call.arguments"]), /secret argument/);
  assert.equal(recorded[1].attributes["gen_ai.tool.call.result"], "secret result");
  assert.equal(recorded[1].attributes["output.value"], "secret result", "as LangSmith and Langfuse read a tool's output");
  assert.equal(recorded[2].attributes["input.value"], "secret prompt");
  assert.match(String(recorded[2].attributes["gen_ai.input.messages"]), /secret prompt/);
  assert.match(String(recorded[2].attributes["gen_ai.output.messages"]), /secret reply/);
});

/** Spans received so far, by name. */
const named = (spans: ReceivedSpan[], name: string) => spans.filter(span => span.name === name);

test("telemetry API: set, shown without header values, refused for internal addresses, test span; runs export their spans under the caller's trace, with no content unless included", async t => {
  const receiver = await otlpReceiver(t);
  const other = await otlpReceiver(t);
  const lookupTool = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
  // Each run: a direct tool call, code that calls the tool, a reply.
  const r = await runtime(t, (_body, index) => [
    { ...toolCall("lookup", { q: "private argument" }, `call_lookup_${index}`), usage: { prompt_tokens: 50, completion_tokens: 5 } },
    { ...toolCall("js_exec", { code: 'return await tools.lookup({ q: "from code" })' }, `call_code_${index}`), usage: { prompt_tokens: 60, completion_tokens: 6 } },
    { role: "assistant", content: "private reply", usage: { prompt_tokens: 70, completion_tokens: 7 } },
  ][index % 3], LOCAL);

  assert.equal((await r.call("/v1/telemetry")).status, 404);
  assert.equal((await r.call("/v1/telemetry", { method: "PUT", body: { sampleRate: 0.5 } })).status, 400, "the first set needs an endpoint");
  for (const [body, why] of [
    [{ endpoint: "http://10.0.0.1:4318/v1/traces" }, "a private address"], [{ endpoint: "http://169.254.169.254/v1/traces" }, "the instance metadata address"],
    [{ endpoint: "http://[::1]:4318/v1/traces" }, "IPv6 loopback"], [{ endpoint: "ftp://collector.example.com/v1/traces" }, "not http(s)"],
    [{ endpoint: receiver.endpoint, headers: { "content-type": "text/plain" } }, "a header the exporter sets"], [{ endpoint: receiver.endpoint, sampleRate: 2 }, "a rate over 1"],
    [{ endpoint: receiver.endpoint, protocol: "grpc" }, "gRPC"], [{ endpoint: receiver.endpoint, include: { content: "yes" } }, "content not a boolean"],
    [{ endpoint: `${receiver.endpoint}?key=x` }, "a query"],
  ] as const) assert.equal((await r.call("/v1/telemetry", { method: "PUT", body })).status, 400, why);

  const set = await r.call("/v1/telemetry", { method: "PUT", body: { endpoint: receiver.url, headers: { Authorization: "Bearer otlp-secret-value", "x-team": "t1" } } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual({ ...set.json, createdAt: 0, updatedAt: 0 }, {
    endpoint: `${receiver.url}/v1/traces`, protocol: "http/protobuf", sampleRate: 1, include: { content: false }, headers: ["authorization", "x-team"],
    createdAt: 0, updatedAt: 0, status: { lastExportAt: null, lastError: null, lastErrorAt: null },
  }, "a base URL gets /v1/traces; defaults; header names only");
  const shown = await r.call("/v1/telemetry");
  assert.ok(!shown.text.includes("otlp-secret-value") && !set.text.includes("otlp-secret-value"), "header values are never returned");
  assert.equal((await r.call("/v1/telemetry", { token: "other-operator-token-at-least-24-chars" })).status, 404, "another tenant has none");

  const tested = await r.call("/v1/telemetry/test", { method: "POST" });
  assert.equal(tested.status, 200, tested.text);
  assert.equal(tested.json.ok, true);
  await until(() => receiver.spans.some(span => span.traceId === tested.json.traceId), "the test span");
  assert.equal(receiver.requests[0].headers.authorization, "Bearer otlp-secret-value");
  assert.equal(receiver.requests[0].headers["x-team"], "t1");
  assert.equal(receiver.requests[0].headers["content-type"], "application/x-protobuf");
  assert.equal(receiver.requests[0].path, "/v1/traces");
  assert.ok((await r.call("/v1/telemetry")).json.status.lastExportAt > 0);

  // A run continuing the caller's trace: run, model, tool and code-tool spans, nested.
  const created = (await r.call("/v1/agents", { body: { mcp: { tools: [lookupTool] }, name: "Support bot" } })).json;
  await attach(t, r.base, created.id, created.token, (call, { reply }) => void reply({ content: [{ type: "text", text: `private result for ${call.params.arguments.q}` }] }));
  const caller = { traceId: newTraceId(), spanId: newSpanId() };
  const accepted = await r.call(`/v1/agents/${created.id}/prompt`, { body: { text: "private prompt", requestId: "traced-1" }, headers: { traceparent: formatTraceparent({ ...caller, sampled: true }) } });
  assert.equal(accepted.status, 202, accepted.text);
  assert.deepEqual({ ...accepted.json.trace, spanId: "" }, { traceId: caller.traceId, spanId: "", parentSpanId: caller.spanId, sampled: true }, "the record names its trace");
  const record = await until(async () => { const got = (await r.call(`/v1/agents/${created.id}/requests/traced-1`)).json; return got.state === "completed" && got; }, "the run");
  assert.equal(record.status, "completed", JSON.stringify(record));
  const root = await until(() => receiver.spans.find(span => span.attributes["camelrun.request.id"] === "traced-1" && span.name.startsWith("invoke_agent")), "the run's span");
  await until(() => receiver.spans.filter(span => span.traceId === caller.traceId).length >= 7, "every span of the run");
  const run = receiver.spans.filter(span => span.traceId === caller.traceId);
  assert.equal(root.name, "invoke_agent Support bot");
  assert.equal(root.spanId, record.trace.spanId);
  assert.equal(root.parentSpanId, caller.spanId, "under the caller's span");
  assert.equal(root.kind, SpanKind.server);
  assert.deepEqual(Object.fromEntries(["gen_ai.operation.name", "gen_ai.agent.id", "gen_ai.agent.name", "gen_ai.request.model", "camelrun.tenant", "camelrun.agent.id", "camelrun.run.status", "camelrun.run.method", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "camelrun.run.model_responses", "camelrun.run.tool_calls"].map(key => [key, root.attributes[key]])), {
    "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.id": created.id, "gen_ai.agent.name": "Support bot", "gen_ai.request.model": "openai/gpt-4o-mini",
    "camelrun.tenant": "alice", "camelrun.agent.id": created.id, "camelrun.run.status": "completed", "camelrun.run.method": "prompt",
    "gen_ai.usage.input_tokens": 180, "gen_ai.usage.output_tokens": 18, "camelrun.run.model_responses": 3, "camelrun.run.tool_calls": 3,
  });
  assert.equal(typeof root.attributes["camelrun.cost.usd"], "number");
  const chats = named(run, "chat openai/gpt-4o-mini");
  assert.equal(chats.length, 3);
  assert.ok(chats.every(span => span.parentSpanId === root.spanId && span.kind === SpanKind.client && span.attributes["gen_ai.operation.name"] === "chat"));
  assert.deepEqual(chats.map(span => span.attributes["gen_ai.usage.input_tokens"]), [50, 60, 70]);
  const tools = named(run, "execute_tool lookup");
  assert.equal(tools.length, 2, "the direct call and the call from code");
  const direct = tools.find(span => span.parentSpanId === root.spanId)!;
  assert.equal(direct.attributes["camelrun.tool.source"], "attached");
  assert.equal(direct.attributes["gen_ai.tool.call.id"], "call_lookup_0");
  assert.equal(direct.attributes["gen_ai.tool.name"], "lookup");
  const code = named(run, "execute_tool js_exec")[0];
  assert.equal(code.parentSpanId, root.spanId);
  assert.equal(code.attributes["camelrun.tool.source"], "runtime");
  const inner = tools.find(span => span !== direct)!;
  assert.equal(inner.parentSpanId, code.spanId, "a call from code is under js_exec");
  assert.ok(inner.attributes["camelrun.tool.inner_call.id"]);
  for (const span of run) assert.ok(span.start >= root.start && span.end <= root.end + 1, `${span.name} within the run`);
  assert.ok(run.every(span => CONTENT_KEYS.every(key => !(key in span.attributes))), "no content attributes");
  for (const secret of ["private prompt", "private argument", "private result", "private reply", "from code"]) assert.ok(!receiver.raw().includes(secret), `${secret} was exported`);
  assert.equal(run[0].resource["service.name"], "camelrun");

  // Content, when the tenant includes it; the stored headers stay at the same origin.
  const including = await r.call("/v1/telemetry", { method: "PUT", body: { endpoint: receiver.endpoint, protocol: "http/json", include: { content: true } } });
  assert.deepEqual(including.json.headers, ["authorization", "x-team"]);
  // A field left out keeps its value.
  const partial = await r.call("/v1/telemetry", { method: "PUT", body: { sampleRate: 1 } });
  assert.deepEqual([partial.json.endpoint, partial.json.protocol, partial.json.include, partial.json.headers], [receiver.endpoint, "http/json", { content: true }, ["authorization", "x-team"]]);
  const second = await r.prompt(created.id, "private prompt again", undefined, { requestId: "traced-2" });
  assert.equal(second.status, "completed");
  const secondRoot = await until(() => receiver.spans.find(span => span.attributes["camelrun.request.id"] === "traced-2" && span.name.startsWith("invoke_agent")), "the second run's span");
  await until(() => receiver.spans.filter(span => span.traceId === secondRoot.traceId).length >= 7, "every span of the second run");
  const contentful = receiver.spans.filter(span => span.traceId === secondRoot.traceId);
  assert.equal(secondRoot.parentSpanId, undefined, "a trace of its own");
  assert.match(String(secondRoot.attributes["gen_ai.input.messages"]), /private prompt again/);
  assert.match(String(secondRoot.attributes["gen_ai.output.messages"]), /private reply/);
  assert.match(String(named(contentful, "execute_tool lookup").find(span => span.parentSpanId === secondRoot.spanId)!.attributes["gen_ai.tool.call.arguments"]), /private argument/);
  assert.equal(receiver.requests.at(-1)!.headers["content-type"], "application/json");
  assert.equal(receiver.requests.at(-1)!.headers.authorization, "Bearer otlp-secret-value");

  // Moving to another origin leaves the headers behind; DELETE stops export.
  const moved = await r.call("/v1/telemetry", { method: "PUT", body: { endpoint: other.endpoint } });
  assert.deepEqual(moved.json.headers, [], "credentials never follow the endpoint to another origin");
  assert.equal((await r.call("/v1/telemetry/test", { method: "POST" })).json.ok, true);
  await until(() => other.requests.length === 1, "the test span at the new endpoint");
  assert.equal(other.requests[0].headers.authorization, undefined);
  assert.equal((await r.call("/v1/telemetry", { method: "DELETE" })).status, 200);
  assert.equal((await r.call("/v1/telemetry")).status, 404);
  const before = other.requests.length;
  await r.prompt(created.id, "untraced", undefined, { requestId: "untraced-1" });
  assert.equal((await r.call(`/v1/agents/${created.id}/requests/untraced-1`)).json.trace, undefined);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(other.requests.length, before, "nothing exported once cleared");
});

test("a collector that hangs or fails never holds up runs; its failure is reported on GET /v1/telemetry", async t => {
  const hanging = await otlpReceiver(t, () => "hang");
  const r = await runtime(t, () => ({ role: "assistant", content: "fine" }), LOCAL);
  assert.equal((await r.call("/v1/telemetry", { method: "PUT", body: { endpoint: hanging.endpoint } })).status, 200);
  const agent = (await r.call("/v1/agents", { body: {} })).json.id;
  const began = Date.now();
  for (let i = 0; i < 3; i++) assert.equal((await r.prompt(agent, `run ${i}`)).status, "completed");
  assert.ok(Date.now() - began < 10_000, "runs went on while the collector hung");
  await until(() => hanging.requests.length > 0, "an export was attempted");

  const failing = await otlpReceiver(t, 401);
  assert.equal((await r.call("/v1/telemetry", { method: "PUT", body: { endpoint: failing.endpoint, headers: { authorization: "Bearer wrong" } } })).status, 200);
  const tested = (await r.call("/v1/telemetry/test", { method: "POST" })).json;
  assert.deepEqual({ ok: tested.ok, status: tested.status, error: tested.error }, { ok: false, status: 401, error: "HTTP 401" });
  assert.equal((await r.prompt(agent, "still fine")).status, "completed");
  const status = await until(async () => { const got = (await r.call("/v1/telemetry")).json.status; return got.lastError && got; }, "the failure reported");
  assert.equal(status.lastError, "HTTP 401");
});

test("waits on people: a resumed run continues the trace of the run that asked, with a span for each input's wait", async t => {
  const receiver = await otlpReceiver(t);
  const ask = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };
  const r = await runtime(t, (_body, index) => index === 0 ? toolCall("ask_user", ask, "call_ask") : { role: "assistant", content: "Deploying to EU" }, LOCAL);
  assert.equal((await r.call("/v1/telemetry", { method: "PUT", body: { endpoint: receiver.endpoint, sampleRate: 1 } })).status, 200);
  const definition = (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id as string;
  const asked = await r.prompt(agent, "Deploy it", undefined, { requestId: "asks" });
  assert.equal(asked.status, "input_required");
  const input = (await r.call(`/v1/agents/${agent}/inputs`)).json.inputs?.[0] ?? (await r.call(`/v1/agents/${agent}/inputs`)).json[0];
  const answered = await r.call(`/v1/agents/${agent}/inputs`, { body: { answers: [{ id: input.id, action: "accept", content: { answers: { "Which region?": "EU" } } }] } });
  assert.ok([200, 202].includes(answered.status), answered.text);
  const resumeRoot = await until(() => receiver.spans.find(span => span.name.startsWith("invoke_agent") && span.attributes["camelrun.run.method"] === "resume"), "the resumed run's span");
  const firstRoot = receiver.spans.find(span => span.attributes["camelrun.request.id"] === "asks" && span.name.startsWith("invoke_agent"))!;
  assert.equal(firstRoot.attributes["camelrun.run.status"], "input_required");
  assert.equal(firstRoot.attributes["camelrun.run.stopped"], "input_required");
  assert.equal(resumeRoot.traceId, firstRoot.traceId, "one trace");
  assert.equal(resumeRoot.parentSpanId, firstRoot.spanId, "the resume continues the run that asked");
  const wait = await until(() => receiver.spans.find(span => span.name === "await_human_input"), "the wait's span");
  assert.equal(wait.traceId, firstRoot.traceId);
  assert.equal(wait.parentSpanId, firstRoot.spanId);
  assert.deepEqual([wait.attributes["camelrun.input.id"], wait.attributes["camelrun.input.kind"], wait.attributes["camelrun.input.state"], wait.attributes["gen_ai.tool.call.id"]], [input.id, "question", "answered", "call_ask"]);
  assert.ok(!("camelrun.input.message" in wait.attributes), "the question is content");
  const askSpans = receiver.spans.filter(span => span.name === "execute_tool ask_user");
  assert.equal(askSpans.find(span => span.parentSpanId === firstRoot.spanId)?.attributes["camelrun.tool.input_required"], true);
});
