import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { lastUser, listen, OPERATOR, runtime, toolCall, toolResults, until, watchEvents, type T } from "./runtime-server.ts";
import { mayAnswer } from "../src/inputs.ts";
import { resumeId } from "../src/client-sessions/inputs.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

/** A stateless MCP server answering in JSON: each tool is (arguments, params) => result, or { error } for a JSON-RPC error. It records each call's params and credentials. */
async function rawMcp(t: T, tools: Record<string, { annotations?: object; _meta?: object; call: (args: any, params: any) => object }>) {
  const calls: { params: any; authorization?: string }[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const message = JSON.parse(text);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: object) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "raw", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: Object.entries(tools).map(([name, tool]) => ({ name, description: name, inputSchema: { type: "object", properties: { id: { type: "string" } } }, ...(tool.annotations ? { annotations: tool.annotations } : {}), ...(tool._meta ? { _meta: tool._meta } : {}) })) });
    if (message.method === "tools/call") {
      calls.push({ params: message.params, authorization: req.headers.authorization });
      const result = tools[message.params.name].call(message.params.arguments, message.params) as { error?: object };
      if (result.error) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: result.error }));
      return reply(result);
    }
    reply({});
  });
  return { url: `${url}/mcp`, calls };
}
const claims = (authorization?: string) => JSON.parse(Buffer.from(authorization!.split(".")[1], "base64url").toString());

const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }], allowOther: true }] };

/** An agent with ask_user, from a definition. */
async function asker(r: Awaited<ReturnType<typeof runtime>>, humanInput?: object) {
  const definition = (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"], ...(humanInput ? { humanInput } : {}) } })).json;
  const created = await r.call("/v1/agents", { body: { definition: definition.id, ttlSeconds: null } });
  assert.equal(created.status, 201, created.text);
  return created.json.id as string;
}
const request = (r: Awaited<ReturnType<typeof runtime>>, agent: string, id: string) =>
  until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${id}`)).json; return record.state === "completed" && record; }, `request ${id}`);

test("ask_user suspends the turn; the answer, after the agent unloaded, resumes it with the answer as the call's result", async t => {
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("ask_user", ASK, "call_ask")
    : { role: "assistant", content: `Deploying to ${JSON.parse(toolResults(body).at(-1)).answers["Which region?"]}` }, { AGENT_IDLE_MS: "1000" });
  const agent = await asker(r);
  const suspended = await r.prompt(agent, "Deploy it");
  assert.equal(suspended.outcome.result.stopped, "input_required");
  const [input] = suspended.outcome.result.inputs;
  assert.equal(input.kind, "question");
  assert.equal(input.message, "Which region?");
  assert.equal(input.toolCallId, "call_ask");
  assert.deepEqual(input.detail.questions[0].options.map((option: any) => option.label), ["EU", "US"]);
  assert.ok(Math.abs(input.expiresAt - Date.now() - 15 * 60_000) < 60_000, "inputs wait 15 minutes by default");
  assert.equal(r.model.bodies.length, 1, "the model is not called while the turn waits");
  const system = r.model.bodies[0].messages.find((message: any) => message.role === "system" || message.role === "developer").content;
  assert.match(system, /ask them with ask_user; your turn pauses until they answer/);

  // Nothing runs while it waits: the agent unloads, and the transcript holds the call open with no result.
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(history.at(-1).role, "assistant");
  assert.equal(history.filter((message: any) => message.role === "toolResult").length, 0);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/inputs?state=pending`)).json.map((entry: any) => entry.id), [input.id]);

  // Answers must fit the question.
  for (const content of [undefined, { answers: {} }, { answers: { "Which region?": ["EU"] } }]) {
    assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content } })).status, 400);
  }
  const answered = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } }, from: { id: "u1", name: "Ada" } } });
  assert.equal(answered.status, 202, answered.text);
  assert.equal(answered.json.input.state, "answered");
  assert.equal(answered.json.request.method, "resume");
  // Retrying the same answer is safe; a different one conflicts and says what was recorded.
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } }, from: { id: "u1", name: "Ada" } } })).status, 200);
  const conflict = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "decline" } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.input.state, "answered");

  const resumed = await request(r, agent, answered.json.request.id);
  assert.equal(resumed.outcome.result.reply, "Deploying to EU");
  const result = JSON.parse(toolResults(r.model.bodies[1]).at(-1));
  assert.deepEqual(result.answers, { "Which region?": "EU" });
  assert.equal(result.answeredBy, "Ada");
  assert.match(result.waited, /^\d+s$/);
  assert.equal(r.model.bodies[1].messages.filter((message: any) => message.role === "user").length, 1, "the answer is the call's result, not a new message");
});

test("a new message supersedes a waiting input; its call is closed and the prompt runs", async t => {
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("ask_user", ASK) : { role: "assistant", content: `Read: ${lastUser(body)}` });
  const agent = await asker(r);
  const [input] = (await r.prompt(agent, "Deploy it")).outcome.result.inputs;
  const next = await r.prompt(agent, "Never mind, what time is it?");
  assert.equal(next.outcome.result.reply, "Read: Never mind, what time is it?");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /Not answered: the user sent a new message instead/);
  assert.equal((await r.call(`/v1/agents/${agent}/inputs`)).json[0].state, "superseded");
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } } } })).status, 409);
});

test("abort cancels waiting inputs and closes the turn without the model; with onExpire close, expiry does the same", async t => {
  const r = await runtime(t, () => toolCall("ask_user", ASK));
  const agent = await asker(r, { onExpire: "close" });
  await r.prompt(agent, "Deploy it");
  assert.equal((await r.call(`/v1/agents/${agent}/abort`, { method: "POST" })).status, 200);
  const cancelled = (await r.call(`/v1/agents/${agent}/inputs`)).json[0];
  assert.equal(cancelled.state, "cancelled");
  await until(async () => (await r.call(`/v1/agents/${agent}/history`)).json.messages.at(-1)?.role === "toolResult", "the call to be closed");
  assert.match((await r.call(`/v1/agents/${agent}/history`)).json.messages.at(-1).content[0].text, /Cancelled by the application/);
  assert.equal(r.model.bodies.length, 1);

  // Expired inputs (made due here) are closed by the scheduler, again without the model.
  await r.prompt(agent, "Deploy it again");
  await r.db.query("update agent_inputs set expires_at = 0 where state = 'pending'");
  await until(async () => (await r.call(`/v1/agents/${agent}/inputs`)).json[0].state === "expired", "the input to expire");
  await until(async () => /did not respond in a timely manner/.test((await r.call(`/v1/agents/${agent}/history`)).json.messages.at(-1)?.content?.[0]?.text ?? ""), "the call to be closed");
  assert.equal(r.model.bodies.length, 2);
});

/** Make an agent's pending inputs due now: the scheduler then answers them for the person, as it would after their time. */
const expireNow = (r: Awaited<ReturnType<typeof runtime>>, agent: string) => r.db.query("update agent_inputs set expires_at = 0 where agent = $1 and state = 'pending'", [agent]);
const NO_RESPONSE = /^The user did not respond in a timely manner/;

test("no answer in time: the runtime answers ask_user for the person, marked as its own, and the turn goes on", async t => {
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("ask_user", ASK, "call_ask") : { role: "assistant", content: "Going on without a region" });
  const agent = await asker(r);
  const watcher = await watchEvents(t, `${r.base}/v1/agents/${agent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "snapshot=0" });
  const [input] = (await r.prompt(agent, "Deploy it")).outcome.result.inputs;
  await expireNow(r, agent);
  const resumed = await request(r, agent, resumeId(input.requestId));
  assert.equal(resumed.outcome.result.reply, "Going on without a region");
  const result = JSON.parse(toolResults(r.model.bodies[1]).at(-1));
  assert.deepEqual(result.answers, {});
  assert.equal(result.timedOut, true);
  assert.match(result.message, NO_RESPONSE);
  assert.match(result.message, /\. Continue\. \(An automatic answer from the runtime after \d+s without a response: the user did not write this\.\)$/);
  assert.equal(result.answeredBy, "the runtime");
  assert.equal(r.model.bodies[1].messages.filter((message: any) => message.role === "user").length, 1, "the automatic answer is the call's result, not a message from the user");

  // Shown as expired, answered by the runtime: in the input, and on the agent's stream.
  const settled = (await r.call(`/v1/agents/${agent}/inputs`)).json.find((entry: any) => entry.id === input.id);
  assert.equal(settled.state, "expired");
  assert.deepEqual([settled.answer.action, settled.answer.by], ["cancel", { system: "expired" }]);
  await until(() => watcher.frames.some(frame => frame.data.type === "event" && frame.data.event.type === "input_resolved" && frame.data.event.id === input.id), "input_resolved on the stream");
  const event = watcher.frames.find(frame => frame.data.event?.type === "input_resolved" && frame.data.event.id === input.id)!.data.event;
  assert.deepEqual([event.state, event.by], ["expired", { system: "expired" }]);

  // A late answer is refused, and changes nothing.
  const late = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } } } });
  assert.equal(late.status, 409);
  assert.match(late.json.error, /expired: no one answered in time/);
  assert.equal(late.json.input.state, "expired");
  assert.equal(r.model.bodies.length, 2);
});

test("no answer in time: an approval is never given; the call does not run and the model goes on", async t => {
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });
  const shop = await rawMcp(t, { delete_item: { annotations: { destructiveHint: true }, call: args => text(`deleted ${args.id}`) } });
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("shop__delete_item", { id: "a" }, "call_a") : { role: "assistant", content: `Skipped: ${toolResults(body).at(-1)}` }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Shop", humanInput: { expiresInSeconds: 600 }, mcpServers: [{ name: "shop", url: shop.url, auth: { type: "runtime" }, approval: { default: "destructive" } }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  const [input] = (await r.prompt(agent, "Delete item a")).outcome.result.inputs;
  assert.equal(input.kind, "approval");
  assert.ok(Math.abs(input.expiresAt - Date.now() - 600_000) < 60_000, "the definition's expiresInSeconds");
  await expireNow(r, agent);
  const resumed = await request(r, agent, resumeId(input.requestId));
  assert.match(resumed.outcome.result.reply, /^Skipped: The user did not respond in a timely manner, so this call was not approved and did not run\. Continue without it, or ask again later\. \(An automatic answer from the runtime/);
  assert.equal(shop.calls.length, 0, "the call never ran");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(history.find((message: any) => message.role === "toolResult").isError, true);
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept" } })).status, 409, "a late approval is refused");
  assert.equal(shop.calls.length, 0);
});

test("no answer in time: a tool's own request (an MCP form) is cancelled with the same answer; the tool is not called again", async t => {
  const form = { mode: "form", message: "New name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
  const server = await rawMcp(t, { rename: { call: () => ({ resultType: "input_required", inputRequests: { name: { method: "elicitation/create", params: form } } }) } });
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("tools__rename", {}, "call_rename") : { role: "assistant", content: toolResults(body).at(-1) }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Tools", humanInput: {}, mcpServers: [{ name: "tools", url: server.url, exposure: "direct" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  const [input] = (await r.prompt(agent, "Rename it")).outcome.result.inputs;
  assert.equal(input.kind, "form");
  await expireNow(r, agent);
  const resumed = await request(r, agent, resumeId(input.requestId));
  assert.match(resumed.outcome.result.reply, /^The user did not respond in a timely manner, so this request was cancelled and the call did not finish\. Continue without it, or ask again later\./);
  assert.equal(server.calls.length, 1, "the tool was not called again");
});

test("no answer in time from code: the waiting call gets the runtime's answer as a decline or an answer would, and the script goes on", async t => {
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });
  const server = await rawMcp(t, { remove: { annotations: { destructiveHint: true }, call: args => text(`removed ${args.id}`) } });
  const script = `let removed;
try { removed = await tools.s__remove({ id: "a" }); } catch (error) { removed = "refused: " + error.message; }
const asked = await tools.ask_user(${JSON.stringify(ASK)});
return { removed, region: asked.answers["Which region?"] ?? "none", timedOut: asked.timedOut };`;
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("codemode", { code: script }, "code") : { role: "assistant", content: toolResults(body).at(-1) }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Code waits", builtins: ["ask_user"], mcpServers: [{ name: "s", url: server.url, exposure: "codemode", approval: { default: "destructive" } }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;

  const first = await r.prompt(agent, "Clean up");
  const [approval] = first.outcome.result.inputs;
  assert.deepEqual([approval.kind, approval.toolCallId], ["approval", "code/c1"]);
  await expireNow(r, agent);
  // The script goes on past the refused call, to its question, which waits in turn.
  const second = await request(r, agent, resumeId(approval.requestId));
  assert.equal(second.outcome.result.stopped, "input_required", JSON.stringify(second.outcome));
  const [question] = second.outcome.result.inputs;
  assert.deepEqual([question.kind, question.toolCallId], ["question", "code/c2"]);
  await expireNow(r, agent);
  const done = await request(r, agent, resumeId(question.requestId));
  assert.equal(done.outcome.error, undefined, JSON.stringify(done.outcome));
  const value = JSON.parse(done.outcome.result.reply.split("\n").at(-1));
  assert.match(value.removed, /^refused: The user did not respond in a timely manner, so this call was not approved and did not run/);
  assert.deepEqual([value.region, value.timedOut], ["none", true]);
  assert.equal(server.calls.length, 0, "the unapproved call never ran");
  assert.equal(r.model.bodies.length, 2, "the model is asked only to start and to answer");
});

test("only whoever started the turn, or an approver, may answer", async t => {
  const r = await runtime(t, (_body, index) => index === 0 ? toolCall("ask_user", ASK) : { role: "assistant", content: "done" });
  const agent = await asker(r, { approvers: ["boss"] });
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "Deploy", from: { id: "alice" } } });
  const [input] = (await request(r, agent, accepted.json.id)).outcome.result.inputs;
  assert.deepEqual(input.responders, { audience: ["alice"] });
  const answer = (from?: object) => r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { answers: { "Which region?": "US" } }, ...(from ? { from } : {}) } });
  assert.equal((await answer({ id: "mallory" })).status, 403);
  assert.ok(mayAnswer(input, { from: { id: "boss" } }, ["boss"]), "an approver may answer");
  assert.ok(!mayAnswer(input, { via: "channel", from: { id: "slack:U9" } }), "a channel sender outside the audience may not");
  assert.equal((await answer()).status, 400, "an answer naming no one is refused: the input is for particular people");
  assert.equal((await answer({ id: "alice" })).status, 202);
});

test("an approval policy asks before a gated tool runs: the approved call runs once, with proof; a declined one never runs", async t => {
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });
  const shop = await rawMcp(t, {
    read_item: { annotations: { readOnlyHint: true }, call: args => text(`item ${args.id}`) },
    delete_item: { annotations: { destructiveHint: true }, call: args => text(`deleted ${args.id}`) },
  });
  const r = await runtime(t, (body, index) => [toolCall("shop__delete_item", { id: "a" }, "call_a"), { role: "assistant", content: toolResults(body).at(-1) },
    toolCall("shop__delete_item", { id: "b" }, "call_b"), { role: "assistant", content: toolResults(body).at(-1) }][index] ?? { role: "assistant", content: "?" }, LOCAL);
  const definition = await r.call("/v1/definitions", { body: { name: "Shop", mcpServers: [{ name: "shop", url: shop.url, auth: { type: "runtime" }, approval: { default: "destructive" } }] } });
  assert.equal(definition.status, 201, definition.text);
  assert.deepEqual(definition.json.mcpServers[0].approval, { default: "destructive" });
  const agent = (await r.call("/v1/agents", { body: { definition: definition.json.id } })).json.id;

  const suspended = await r.prompt(agent, "Delete item a");
  const tools = r.model.bodies[0].tools.map((entry: any) => entry.function.name);
  assert.ok(tools.includes("shop__delete_item") && tools.includes("shop__read_item"));
  assert.match(r.model.bodies[0].messages[0].content, /approves each call of these tools before it runs[^\n]*: shop__delete_item\./);
  const [input] = suspended.outcome.result.inputs;
  assert.equal(input.kind, "approval");
  assert.equal(input.message, "Allow shop__delete_item to run?");
  assert.deepEqual({ ...input.detail, argumentsHash: undefined }, { tool: "shop__delete_item", source: "shop", arguments: { id: "a" }, argumentsHash: undefined }, "arguments as an object, as a stream's tool calls have them");
  assert.equal(shop.calls.length, 0, "nothing ran before the approval");

  const watcher = await watchEvents(t, `${r.base}/v1/agents/${agent}/events`, { Authorization: `Bearer ${OPERATOR}` }, { query: "snapshot=0" });
  const approved = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", actor: "ops-1" } });
  assert.equal(approved.status, 202, approved.text);
  const resumed = await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${approved.json.request.id}`)).json; return record.state === "completed" && record; }, "the resume");
  // The resumed call starts and ends on the stream, as any call does, before its result's message.
  await until(() => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === approved.json.request.id), "the resume on the stream");
  const events = watcher.frames.filter(frame => frame.data.type === "event" && frame.data.requestId === approved.json.request.id).map(frame => frame.data.event);
  const order = events.filter(event => ["tool_execution_start", "tool_execution_end"].includes(event.type) || (event.type === "message_end" && event.message.role === "toolResult")).map(event => event.type);
  assert.deepEqual(order, ["tool_execution_start", "tool_execution_end", "message_end"]);
  const ended = events.find(event => event.type === "tool_execution_end");
  assert.deepEqual([ended.toolCallId, ended.toolName, ended.isError], ["call_a", "shop__delete_item", false]);
  assert.match(JSON.stringify(ended.result), /deleted a/);
  assert.deepEqual(events.find(event => event.type === "tool_execution_start").args, { id: "a" });
  assert.match(resumed.outcome.result.reply, /deleted a[\s\S]*Approved by ops-1 after \d+s/);
  assert.equal(shop.calls.length, 1);
  const proof = { input: input.id, by: { via: "api", actor: "ops-1" } };
  assert.deepEqual({ ...shop.calls[0].params._meta["agent-runtime/approval"], at: undefined }, { ...proof, at: undefined });
  assert.deepEqual({ ...claims(shop.calls[0].authorization).approval, at: undefined }, { ...proof, at: undefined }, "the identity token carries it too");

  const declined = await r.prompt(agent, "Delete item b");
  const [second] = declined.outcome.result.inputs;
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/${second.id}`, { body: { action: "decline", content: { reason: "keep it" } } })).status, 202);
  await until(async () => r.model.bodies.length === 4, "the model to hear of it");
  assert.match(toolResults(r.model.bodies[3]).at(-1), /The user declined this call: keep it\. It did not run/);
  assert.equal(shop.calls.length, 1);
});

test("an MCP server's input_required (form and url, and the older -32042) suspends the call; the retry carries the answers and its state", async t => {
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });
  const form = { mode: "form", message: "New name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
  const server = await rawMcp(t, {
    rename: { call: (_args, params) => params.inputResponses ? text(`renamed to ${params.inputResponses.name.content.name} (state ${params.requestState})`)
      : { resultType: "input_required", inputRequests: { name: { method: "elicitation/create", params: form } }, requestState: "opaque-state" } },
    connect: { call: (_args, params) => params.inputResponses ? text(`connected: ${params.inputResponses.url_0.action}`)
      : { error: { code: -32042, message: "Connect first", data: { elicitations: [{ mode: "url", url: "https://crm.example.test/connect", message: "Connect your CRM", elicitationId: "e1" }] } } } },
  });
  const r = await runtime(t, (body, index) => [toolCall("tools__rename", {}, "call_rename"), { role: "assistant", content: toolResults(body).at(-1) },
    toolCall("tools__connect", {}, "call_connect"), { role: "assistant", content: toolResults(body).at(-1) },
    toolCall("codemode", { code: "return await tools.tools__rename({})" }, "call_code"), { role: "assistant", content: toolResults(body).at(-1) }][index] ?? { role: "assistant", content: "?" }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Tools", humanInput: {}, mcpServers: [{ name: "tools", url: server.url, exposure: "both" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;

  const [input] = (await r.prompt(agent, "Rename it")).outcome.result.inputs;
  assert.deepEqual({ kind: input.kind, message: input.message, detail: input.detail }, { kind: "form", message: "New name?", detail: { requestedSchema: form.requestedSchema } });
  assert.deepEqual(server.calls[0].params._meta["io.modelcontextprotocol/clientCapabilities"], { elicitation: { form: {}, url: {} } }, "an agent with someone to ask says it can elicit");
  assert.equal(JSON.stringify((await r.db.query("select input from agent_inputs")).rows).includes("opaque-state"), false, "the server's state is sealed at rest");
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { name: 7 } } })).status, 400, "a form's content fits its schema");
  const answered = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", content: { name: "Bob" } } });
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/${answered.json.request.id}`)).json.state === "completed", "the retry");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /renamed to Bob \(state opaque-state\)[\s\S]*Answered by the application after/);
  assert.equal(server.calls[1].params.requestState, "opaque-state");

  const [url] = (await r.prompt(agent, "Connect the CRM")).outcome.result.inputs;
  assert.deepEqual({ kind: url.kind, message: url.message, detail: url.detail }, { kind: "url", message: "Connect your CRM", detail: { url: "https://crm.example.test/connect", origin: "https://crm.example.test" } });
  const done = await r.call(`/v1/agents/${agent}/inputs/${url.id}`, { body: { action: "accept" } });
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/${done.json.request.id}`)).json.state === "completed", "the retry");
  assert.match(toolResults(r.model.bodies[3]).at(-1), /connected: accept/);
  assert.equal(server.calls[3].params.requestState, undefined, "no state was given, so none is sent");

  // From code the same: the run waits on the form, and the call starts again with the answer as its code goes on.
  const fromCode = await r.prompt(agent, "Rename from code");
  assert.equal(fromCode.outcome.result.stopped, "input_required");
  const [named] = fromCode.outcome.result.inputs;
  assert.deepEqual([named.kind, named.toolCallId], ["form", "call_code/c1"]);
  const renamed = await r.call(`/v1/agents/${agent}/inputs/${named.id}`, { body: { action: "accept", content: { name: "Cy" } } });
  const resumed = await request(r, agent, renamed.json.request.id);
  assert.match(resumed.outcome.result.reply, /renamed to Cy \(state opaque-state\)/);
});

test("an agent with no one to ask does not tell servers it can elicit", async t => {
  const server = await rawMcp(t, { plain: { call: () => ({ content: [{ type: "text", text: "ok" }] }) } });
  const r = await runtime(t, (_body, index) => index === 0 ? toolCall("tools__plain", {}) : { role: "assistant", content: "done" }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Headless", mcpServers: [{ name: "tools", url: server.url, exposure: "direct" }] } })).json;
  await r.prompt((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id, "go");
  assert.equal(server.calls[0].params._meta?.["io.modelcontextprotocol/clientCapabilities"], undefined);
});

test("an attached tool asks with ctx.confirm and ctx.ask: the call runs again with the answers, everything before an ask included", async t => {
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("delete_app", { app: "shop" }, "call_delete") : { role: "assistant", content: toolResults(body).at(-1) });
  let runs = 0;
  const deleted: string[] = [];
  const tools = { delete_app: tool({
    description: "Delete an app", input: schema.Object({ app: schema.String() }),
    execute: async ({ app }, ctx) => {
      runs++;
      if (!await ctx.confirm(`Delete ${app}? Its URL stops working.`)) return { cancelled: true };
      const reason = await ctx.ask<{ reason: string }>("Why?", { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] });
      deleted.push(`${app}: ${reason?.reason}`);
      return { deleted: app };
    },
  }) };
  const agent = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).createAgent({ tools });
  t.after(() => agent.close());
  const first = await agent.prompt("Delete the shop app", { timeoutMs: 30_000 });
  assert.equal(first.stopped, "input_required");
  assert.deepEqual({ kind: first.inputs[0].kind, message: first.inputs[0].message }, { kind: "form", message: "Delete shop? Its URL stops working." });
  const post = (id: string, body: object) => r.call(`/v1/agents/${agent.session.id}/inputs/${id}`, { body });
  const confirmed = await post(first.inputs[0].id, { action: "accept", content: {} });
  const second = await agent.waitForRequest(confirmed.json.request.id, { timeoutMs: 30_000 });
  assert.equal(second.stopped, "input_required", "the second ask is a second round");
  assert.equal(second.inputs[0].message, "Why?");
  const reasoned = await post(second.inputs[0].id, { action: "accept", content: { reason: "retired" } });
  const done = await agent.waitForRequest(reasoned.json.request.id, { timeoutMs: 30_000 });
  assert.match(done.reply, /"deleted":"shop"/);
  assert.deepEqual(deleted, ["shop: retired"]);
  assert.equal(runs, 3, "the code before each ask ran again on every retry");
});

test("inputs from parallel calls are one suspension: answered together, all or none, and listed in the tenant's inbox", async t => {
  const call = (id: string, question: string, index: number) => ({ index, id, type: "function", function: { name: "ask_user", arguments: JSON.stringify({ questions: [{ question, header: "Q", options: [{ label: "A" }, { label: "B" }] }] }) } });
  const r = await runtime(t, (body, index) => index === 0 ? { role: "assistant", tool_calls: [call("call_1", "First?", 0), call("call_2", "Second?", 1)] }
    : { role: "assistant", content: toolResults(body).map((result: string) => Object.values(JSON.parse(result).answers)[0]).join("+") });
  const agent = await asker(r);
  const inputs = (await r.prompt(agent, "Ask me twice")).outcome.result.inputs.sort((a: any, b: any) => a.message.localeCompare(b.message));
  assert.deepEqual(inputs.map((input: any) => input.message), ["First?", "Second?"]);
  assert.deepEqual((await r.call("/v1/inputs?state=pending")).json.map((input: any) => input.id).sort(), inputs.map((input: any) => input.id).sort());

  const answers = (second: string) => ({ answers: [
    { id: inputs[0].id, action: "accept", content: { answers: { "First?": "A" } } },
    { id: inputs[1].id, action: "accept", content: { answers: { "Second?": second } } },
  ] });
  assert.equal((await r.call(`/v1/agents/${agent}/inputs`, { body: answers("C") })).status, 400);
  assert.equal((await r.call(`/v1/agents/${agent}/inputs?state=pending`)).json.length, 2, "nothing was recorded");
  const answered = await r.call(`/v1/agents/${agent}/inputs`, { body: answers("B") });
  assert.equal(answered.status, 202, answered.text);
  assert.equal(answered.json.requests.length, 1);
  assert.equal((await r.call(`/v1/agents/${agent}/inputs`, { body: answers("B") })).status, 200, "a retry is safe");
  const resumed = await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${answered.json.requests[0].id}`)).json; return record.state === "completed" && record; }, "the resume");
  assert.equal(resumed.outcome.result.reply, "A+B");
  assert.deepEqual((await r.call("/v1/inputs?state=pending")).json, []);
});

test("an application answers with onInput, from its SDK", async t => {
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("wipe", { disk: "d1" }) : { role: "assistant", content: toolResults(body).at(-1) });
  const wiped: string[] = [];
  const seen: any[] = [];
  const tools = { wipe: tool({ description: "Wipe a disk", input: schema.Object({ disk: schema.String() }), needsApproval: true, execute: ({ disk }) => { wiped.push(disk); return { wiped: disk }; } }) };
  const agent = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).createAgent({ tools, onInput: input => { seen.push(input); return { action: "accept", actor: "ops" }; } });
  t.after(() => agent.close());
  const suspended = await agent.prompt("Wipe d1", { timeoutMs: 30_000 });
  assert.equal(suspended.stopped, "input_required");
  await until(() => r.model.bodies.length === 2, "the resumed turn");
  assert.deepEqual(wiped, ["d1"]);
  assert.equal(seen[0].detail.tool, "wipe");
  assert.equal(seen[0].detail.source, "application");
  assert.deepEqual(seen[0].detail.arguments, { disk: "d1" });
  assert.deepEqual((await agent.inputs())[0].answer?.by, { via: "agent", actor: "ops" });
});

test("a remote MCP tool sets its own exposure in _meta, over its source's; approval keeps its exposure", async t => {
  const plain = { call: () => ({ content: [{ type: "text", text: "ok" }] }) };
  const exposure = (value: string) => ({ ...plain, _meta: { "agent-runtime/exposure": value } });
  const server = await rawMcp(t, { key: exposure("direct"), hidden: exposure("codemode"), gated: exposure("codemode"), plain });
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Exposed", mcpServers: [{ name: "s", url: server.url, exposure: "codemode", approval: { tools: { gated: "always" } } }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  const tools = Object.fromEntries((await r.call(`/v1/agents/${agent}`)).json.toolSources.find((source: any) => source.name === "s").tools.map((tool: any) => [tool.name, tool.exposure]));
  assert.deepEqual(tools, { s__key: "direct", s__hidden: "codemode", s__gated: "codemode", s__plain: "codemode" });
});

test("an input for particular people must be answered naming who answers", async t => {
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("ask_user", ASK, "call_ask") : { role: "assistant", content: "ok" });
  const agent = await asker(r);
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "Deploy it", from: { id: "u1" } } });
  const suspended = await request(r, agent, accepted.json.id);
  const [input] = suspended.outcome.result.inputs;
  assert.deepEqual(input.responders.audience, ["u1"]);
  const answer = { action: "accept", content: { answers: { "Which region?": "EU" } } };
  const anonymous = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: answer });
  assert.equal(anonymous.status, 400);
  assert.match(anonymous.json.error, /from or actor/);
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { ...answer, from: { id: "u2" } } })).status, 403);
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { ...answer, from: { id: "u1" } } })).status, 202);
});


test("code's calls that ask at once are one suspension: an approved one runs, a declined one rejects in the script", async t => {
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });
  const server = await rawMcp(t, { remove: { annotations: { destructiveHint: true }, call: args => text(`removed ${args.id}`) } });
  const script = `const results = await Promise.allSettled([tools.s__remove({ id: "a" }), tools.s__remove({ id: "b" })]);
return results.map(result => result.status === "fulfilled" ? result.value : "refused: " + result.reason.message);`;
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("codemode", { code: script }, "code") : { role: "assistant", content: toolResults(body).at(-1) }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Code asks twice", mcpServers: [{ name: "s", url: server.url, exposure: "codemode", approval: { default: "destructive" } }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  const suspended = await r.prompt(agent, "Remove both");
  const inputs = suspended.outcome.result.inputs;
  assert.deepEqual(inputs.map((input: any) => input.toolCallId).sort(), ["code/c1", "code/c2"]);
  const a = inputs.find((input: any) => input.detail.arguments.id === "a"), b = inputs.find((input: any) => input.detail.arguments.id === "b");
  // Answered together, all or none: the suspension resumes once.
  const answered = await r.call(`/v1/agents/${agent}/inputs`, { body: { answers: [{ id: a.id, action: "accept" }, { id: b.id, action: "decline", content: { reason: "keep b" } }] } });
  assert.equal(answered.status, 202, answered.text);
  const done = await request(r, agent, answered.json.requests[0].id);
  assert.match(done.outcome.result.reply, /\["removed a","refused: The user declined this call: keep b\. It did not run/);
  assert.deepEqual(server.calls.map(call => call.params.arguments.id), ["a"], "the declined call never ran");
});

test("code pauses for people: an approval, a question and an MCP form, a run each, and every finished call runs once", async t => {
  const text = (value: string) => ({ content: [{ type: "text", text: value }] });
  const form = { mode: "form", message: "New name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
  const server = await rawMcp(t, {
    read: { annotations: { readOnlyHint: true }, call: () => text(JSON.stringify({ items: ["a", "b"] })) },
    remove: { annotations: { destructiveHint: true }, call: args => text(`removed ${args.id}`) },
    rename: { call: (_args, params) => params.inputResponses ? text(`renamed to ${params.inputResponses.name.content.name}`)
      : { resultType: "input_required", inputRequests: { name: { method: "elicitation/create", params: form } }, requestState: "s1" } },
  });
  const script = `const { items } = await tools.s__read({});
const removed = await tools.s__remove({ id: items[0] });
const asked = await tools.ask_user(${JSON.stringify(ASK)});
const renamed = await tools.s__rename({});
return { removed, region: asked.answers["Which region?"], renamed };`;
  const r = await runtime(t, (body, index) => index === 0 ? toolCall("codemode", { code: script }, "code") : { role: "assistant", content: toolResults(body).at(-1) }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Code asks", builtins: ["ask_user"], humanInput: {}, mcpServers: [{ name: "s", url: server.url, exposure: "codemode", approval: { default: "destructive" } }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  const called = (name: string) => server.calls.filter(call => call.params.name === name).length;

  const first = await r.prompt(agent, "Clean up");
  assert.equal(first.outcome.result.stopped, "input_required");
  const [approval] = first.outcome.result.inputs;
  assert.deepEqual([approval.kind, approval.toolCallId, approval.detail.arguments], ["approval", "code/c2", { id: "a" }]);
  assert.deepEqual([called("read"), called("remove")], [1, 0], "nothing runs before the approval");
  // The agent unloads while it waits: no code slot, no memory.
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the agent to unload");

  const approved = await r.call(`/v1/agents/${agent}/inputs/${approval.id}`, { body: { action: "accept" } });
  const second = await request(r, agent, approved.json.request.id);
  assert.equal(second.outcome.result.stopped, "input_required");
  const [question] = second.outcome.result.inputs;
  assert.deepEqual([question.kind, question.toolCallId], ["question", "code/c3"]);
  assert.deepEqual([called("read"), called("remove")], [1, 1]);

  const answered = await r.call(`/v1/agents/${agent}/inputs/${question.id}`, { body: { action: "accept", content: { answers: { "Which region?": "EU" } } } });
  const third = await request(r, agent, answered.json.request.id);
  assert.equal(third.outcome.result.stopped, "input_required");
  const [named] = third.outcome.result.inputs;
  assert.deepEqual([named.kind, named.toolCallId], ["form", "code/c4"]);

  const filled = await r.call(`/v1/agents/${agent}/inputs/${named.id}`, { body: { action: "accept", content: { name: "Bob" } } });
  const done = await request(r, agent, filled.json.request.id);
  assert.equal(done.outcome.error, undefined, JSON.stringify(done.outcome));
  assert.match(done.outcome.result.reply, /"removed":"removed a"[\s\S]*"region":"EU"[\s\S]*"renamed":"renamed to Bob/);
  assert.deepEqual([called("read"), called("remove"), called("rename")], [1, 1, 2], "each finished call ran once");
  assert.equal(r.model.bodies.length, 2, "the model is asked only to start and to answer");
  assert.equal(server.calls.find(call => call.params.name === "remove")!.params._meta["agent-runtime/approval"].input, approval.id, "the approved call carries its proof");
});

test("recording a call's inputs again (a retry whose answer was lost) returns the pending ones, and asks nothing new", async () => {
  const { testDatabase } = await import("./database.ts");
  const { Inputs } = await import("../src/inputs.ts");
  const { db } = await testDatabase();
  const inputs = new Inputs({ db });
  const base = { agent: "a1", tenant: "alice", requestId: "r1", toolCallId: "code/c1", responders: {}, expiresAt: Date.now() + 60_000, tool: "approve", argumentsHash: "h" };
  const requests = [{ kind: "approval" as const, message: "Run it?", detail: {} }];
  const first = await inputs.create(base, requests);
  const again = await inputs.create(base, requests);
  assert.deepEqual(again.map(input => input.id), first.map(input => input.id));
  assert.equal(Number((await db.query("select count(*) from agent_inputs where agent = 'a1'")).rows[0].count), 1);
});
