import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, runtime, sleep, toolCall, toolResults, until, watchEvents } from "./runtime-server.ts";

/** The model request's system text: its system messages, wherever they are, in order. */
const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");
const declared = (body: any) => (body.tools ?? []).map((tool: any) => tool.function.name);
/** Several tool calls in one response. */
const toolCalls = (...calls: [string, unknown, string][]) => ({ role: "assistant", tool_calls: calls.map(([name, args, id], index) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
const userText = (body: any) => body.messages.filter((message: any) => message.role === "user").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");

test("delegate starts a child from a definition, returns its answer, and links it to its parent", async t => {
  const r = await runtime(t, body => {
    if (systemText(body).includes("RESEARCHER")) return { role: "assistant", content: `found it: ${userText(body).includes("the answer") ? 42 : 0}` };
    return toolResults(body).length ? { role: "assistant", content: `The answer is ${JSON.parse(toolResults(body)[0]).text.split(": ")[1]}` } : toolCall("delegate", { agent: "researcher", task: "find the answer" }, "call_d");
  });
  const definition = await r.call("/v1/definitions", { headers: { "Idempotency-Key": "researcher" }, body: { name: "Researcher", description: "Finds answers", systemPrompt: "You are RESEARCHER." } });
  assert.equal(definition.status, 201, definition.text);
  // The builtin and its allowlist go together.
  assert.equal((await r.call("/v1/agents", { body: { builtins: ["delegate"] } })).status, 400);
  assert.equal((await r.call("/v1/agents", { body: { delegate: { agents: ["researcher"] } } })).status, 400);
  const created = await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { agents: ["researcher"] } } });
  assert.equal(created.status, 201, created.text);
  const parent = created.json.id;

  const record = await r.prompt(parent, "What is the answer?");
  assert.equal(record.error, undefined, JSON.stringify(record));
  assert.equal(record.outcome.result.reply, "The answer is 42");
  const call = record.outcome.result.toolCalls.find((entry: any) => entry.tool === "delegate");
  assert.equal(call.ok, true);
  assert.match(call.agentId, /^client_/);
  // The model saw the target and its definition's description.
  const tool = r.model.bodies[0].tools.find((entry: any) => entry.function.name === "delegate").function;
  assert.deepEqual(tool.parameters.properties.agent.enum, ["researcher"]);
  assert.match(tool.description, /researcher: Finds answers/);

  // The child is a real agent: listed with its parent, made from the definition, and its run says who started it.
  const agents = (await r.call("/v1/agents")).json;
  const child = agents.find((agent: any) => agent.id === call.agentId);
  assert.equal(child.parentAgentId, parent);
  assert.equal(child.type, "subagent");
  const detail = (await r.call(`/v1/agents/${call.agentId}`)).json;
  assert.equal(detail.parentAgentId, parent);
  assert.equal(detail.parentRunId, record.id);
  assert.equal(detail.definition.id, definition.json.id);
  const run = detail.requests.find((request: any) => request.method === "prompt");
  assert.equal(run.metadata.parentAgentId, parent);
  assert.equal(run.metadata.parentRunId, record.id);
  assert.equal(run.metadata.delegationDepth, "1");
  assert.equal(run.outcome.result.reply, "found it: 42");
});

test("delegate calls in one response run at once, at most maxParallel together, and one with output answers in its schema", async t => {
  let inFlight = 0, most = 0;
  const r = await runtime(t, body => {
    if (systemText(body).includes("WORKER")) {
      inFlight++; most = Math.max(most, inFlight);
      setTimeout(() => inFlight--, 400);
      const task = userText(body);
      return task.includes("structured") ? { ...toolCall("final_output", { value: 7 }, "call_out"), delayMs: 400 } : { role: "assistant", content: `done ${task.slice(-1)}`, delayMs: 400 };
    }
    if (!toolResults(body).length) return toolCalls(
      ["delegate", { instructions: "You are a WORKER.", task: "task 1" }, "c1"], ["delegate", { instructions: "You are a WORKER.", task: "task 2" }, "c2"],
      ["delegate", { instructions: "You are a WORKER.", task: "task 3" }, "c3"], ["delegate", { instructions: "You are a WORKER.", task: "structured", output: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } }, "c4"],
    );
    return { role: "assistant", content: toolResults(body).join(" | ") };
  });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { instructions: true, maxParallel: 3 } } })).json.id;
  const record = await r.prompt(parent, "fan out");
  assert.equal(record.error, undefined, JSON.stringify(record));
  const results = toolResults(r.model.bodies.at(-1)).map((text: string) => JSON.parse(text));
  assert.deepEqual(results.slice(0, 3).map((result: any) => result.text), ["done 1", "done 2", "done 3"]);
  assert.deepEqual(results[3].output, { value: 7 });
  assert.equal(most, 3, "three children at once (in parallel), the fourth after one finished");
  assert.equal(new Set(record.outcome.result.toolCalls.map((call: any) => call.agentId)).size, 4);
});

test("delegation stops at its depth limit, and a run's spend limit bounds its children and counts what they spent", async t => {
  // Each response costs $0.15 (5000 input tokens of openai/gpt-5.5-pro).
  const r = await runtime(t, body => {
    const usage = { prompt_tokens: 5000, completion_tokens: 0 };
    const results = toolResults(body);
    if (body.messages.at(-1).role === "tool") return { role: "assistant", content: `got: ${results.at(-1)}`, usage };
    return { ...toolCall("delegate", { agent: "self", task: `go deeper from ${userText(body).slice(0, 40)}` }, "call_deep"), usage };
  }, { AGENT_MODEL: "openai/gpt-5.5-pro" });
  // A definition that delegates to itself: each child delegates again, until the depth limit (2 by default) refuses.
  const saved = await r.call("/v1/definitions", { headers: { "Idempotency-Key": "self" }, body: { name: "Self", systemPrompt: "Delegate.", builtins: ["delegate"], delegate: { agents: ["self"] } } });
  assert.equal(saved.status, 201, saved.text);
  const root = (await r.call("/v1/agents", { body: { definition: saved.json.id } })).json.id;
  const record = await r.prompt(root, "start");
  assert.equal(record.error, undefined, JSON.stringify(record));
  const child = (await r.call(`/v1/agents/${record.outcome.result.toolCalls[0].agentId}`)).json;
  const childRun = child.requests.find((request: any) => request.method === "prompt");
  const grandchild = (await r.call(`/v1/agents/${childRun.outcome.result.toolCalls[0].agentId}`)).json;
  const grandchildRun = grandchild.requests.find((request: any) => request.method === "prompt");
  assert.equal(grandchildRun.metadata.delegationDepth, "2");
  assert.equal(grandchildRun.outcome.result.toolCalls[0].ok, false);
  assert.match(grandchildRun.outcome.result.reply, /depth limit of 2/);
  // Each agent made two responses ($0.30); the root's usage counts its own, and what its children (and theirs) spent.
  assert.equal(record.outcome.result.usage.costUsd.toFixed(2), "0.30");
  assert.equal(record.outcome.result.usage.subagentCostUsd.toFixed(2), "0.60");

  // With a run spend limit of $0.40, the child gets what is left after the parent's first response ($0.25) as its own limit.
  const limited = await r.prompt(root, "again", undefined, { spendLimit: { usd: 0.4 } });
  const limitedChild = (await r.call(`/v1/agents/${limited.outcome.result.toolCalls[0].agentId}`)).json;
  const limitedRun = limitedChild.requests.find((request: any) => request.method === "prompt");
  assert.equal(limitedRun.outcome.result.stopped, "spend_limit");
  assert.equal(limited.outcome.result.stopped, "spend_limit", "the children's spend counts against the parent run's limit");
});

test("parallel children share what their parent's run has left, rather than each getting all of it", async t => {
  // Each response costs $0.15 (5000 input tokens of openai/gpt-5.5-pro). A WORKER keeps working until its spend limit stops it.
  let n = 0;
  const r = await runtime(t, body => {
    const usage = { prompt_tokens: 5000, completion_tokens: 0 };
    if (systemText(body).includes("WORKER")) return { ...toolCall("missing_tool", {}, `call_w${++n}`), usage };
    if (!toolResults(body).length) return { ...toolCalls(["delegate", { instructions: "You are a WORKER.", task: "work 1" }, "p1"], ["delegate", { instructions: "You are a WORKER.", task: "work 2" }, "p2"]), usage };
    return { role: "assistant", content: "done", usage };
  }, { AGENT_MODEL: "openai/gpt-5.5-pro" });
  const parent = (await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { instructions: true } } })).json.id;
  // $0.40 for the run: $0.25 is left after the parent's first response, for both children together.
  const record = await r.prompt(parent, "fan out", undefined, { spendLimit: { usd: 0.4 } });
  assert.ok(record.outcome, JSON.stringify(record));
  const children = await Promise.all(record.outcome.result.toolCalls.filter((call: any) => call.tool === "delegate").map(async (call: any) =>
    (await r.call(`/v1/agents/${call.agentId}`)).json.requests.find((request: any) => request.method === "prompt")));
  assert.equal(children.length, 2);
  for (const run of children) assert.equal(run.outcome.result.stopped, "spend_limit");
  // Each child's limit is its share ($0.125), so each stops after one response; with all of it each would make two.
  assert.equal(record.outcome.result.usage.subagentCostUsd.toFixed(2), "0.30");
});

test("a caller cannot move a run's place in the delegation chain with prompt metadata", async t => {
  const r = await runtime(t, body => toolResults(body).length || body.messages.at(-1).role === "tool"
    ? { role: "assistant", content: `got: ${toolResults(body).at(-1)}` }
    : toolCall("delegate", { agent: "self", task: "go deeper" }, "call_deep"));
  const saved = await r.call("/v1/definitions", { headers: { "Idempotency-Key": "self" }, body: { name: "Self", systemPrompt: "Delegate.", builtins: ["delegate"], delegate: { agents: ["self"] } } });
  assert.equal(saved.status, 201, saved.text);
  const root = (await r.call("/v1/agents", { body: { definition: saved.json.id } })).json.id;
  // Metadata naming the runtime's delegation keys, as a delegate call's would, but sent by the caller.
  const record = await r.prompt(root, "start", undefined, { metadata: { delegationDepth: "-10", delegationMaxDepth: "5", delegationChain: "" } });
  assert.equal(record.error, undefined, JSON.stringify(record));
  const child = (await r.call(`/v1/agents/${record.outcome.result.toolCalls[0].agentId}`)).json;
  const childRun = child.requests.find((request: any) => request.method === "prompt");
  assert.equal(childRun.metadata.delegationDepth, "1", "the root is where every chain starts, whatever its prompt said");
  const grandchild = (await r.call(`/v1/agents/${childRun.outcome.result.toolCalls[0].agentId}`)).json;
  const grandchildRun = grandchild.requests.find((request: any) => request.method === "prompt");
  assert.equal(grandchildRun.outcome.result.toolCalls[0].ok, false);
  assert.match(grandchildRun.outcome.result.reply, /depth limit of 2/);
});

test("aborting a parent aborts the children it waits on; the stream shows them to subscribers that ask", async t => {
  const r = await runtime(t, body => {
    if (systemText(body).includes("SLOW")) return { role: "assistant", content: "too late", delayMs: 30_000 };
    return toolResults(body).length ? { role: "assistant", content: "after" } : toolCall("delegate", { instructions: "You are SLOW.", task: "wait" }, "call_slow");
  });
  const { id: parent, token } = (await r.call("/v1/agents", { body: { builtins: ["delegate"], delegate: { instructions: true } } })).json;
  const nested = await watchEvents(t, `${r.base}/v1/agents/${parent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "watch=1&subagents=1" });
  const plain = await watchEvents(t, `${r.base}/clients/${parent}/events`, { Authorization: `Bearer ${token}` });
  const accepted = await r.call(`/v1/agents/${parent}/prompt`, { body: { text: "go" } });
  const start = await until(() => nested.frames.find(frame => frame.data.event?.type === "subagent_start"), "subagent_start");
  const child = start.data.event.agentId;
  // The child's own events are relayed as it works.
  await until(() => nested.frames.some(frame => frame.data.event?.type === "subagent_event" && frame.data.event.agentId === child && frame.data.event.event.type === "turn_opened"), "the child's run began, relayed");
  const aborted = Date.now();
  assert.equal((await r.call(`/v1/agents/${parent}/abort`, { method: "POST" })).status, 200);
  const childRun = await until(async () => (await r.call(`/v1/agents/${child}`)).json.requests.find((request: any) => request.method === "prompt" && request.state === "completed"), "the child's run ended");
  assert.ok(childRun.endedAt - aborted < 10_000, "the child stopped at the abort, not when its model would have answered");
  const parentRun = await until(async () => { const record = (await r.call(`/v1/agents/${parent}/requests/${accepted.json.id}`)).json; return record.state === "completed" && record; }, "the parent's run ended");
  assert.ok(parentRun.outcome, JSON.stringify(parentRun));
  await sleep(200);
  assert.ok(nested.frames.some(frame => frame.data.event?.type === "subagent_end" && frame.data.event.agentId === child));
  assert.ok(!plain.frames.some(frame => String(frame.data.event?.type).startsWith("subagent_")), "a subscriber that did not ask gets none");
});
