import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, memoryJournalStore, schema, tool } from "../clients/typescript.ts";
import { lastUser, listen, OPERATOR, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";
import { mayAnswer } from "../src/inputs.ts";

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
  assert.ok(input.expiresAt - Date.now() > 6 * 86_400_000, "inputs wait 7 days by default");
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

test("abort cancels waiting inputs and closes the turn without the model; expiry does the same", async t => {
  const r = await runtime(t, () => toolCall("ask_user", ASK));
  const agent = await asker(r);
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
  await until(async () => /expired/.test((await r.call(`/v1/agents/${agent}/history`)).json.messages.at(-1)?.content?.[0]?.text ?? ""), "the call to be closed");
  assert.equal(r.model.bodies.length, 2);
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
  assert.equal((await answer()).status, 202, "an answer naming no one has the token's authority");
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
  assert.deepEqual({ ...input.detail, argumentsHash: undefined }, { tool: "shop__delete_item", source: "shop", arguments: '{"id":"a"}', argumentsHash: undefined });
  assert.equal(shop.calls.length, 0, "nothing ran before the approval");

  const approved = await r.call(`/v1/agents/${agent}/inputs/${input.id}`, { body: { action: "accept", actor: "ops-1" } });
  assert.equal(approved.status, 202, approved.text);
  const resumed = await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${approved.json.request.id}`)).json; return record.state === "completed" && record; }, "the resume");
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
    toolCall("js_exec", { code: "return await tools.tools__rename({})" }), { role: "assistant", content: toolResults(body).at(-1) }][index] ?? { role: "assistant", content: "?" }, LOCAL);
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

  // Code cannot wait for a person: the call from js_exec fails and says how to make it.
  const fromCode = await r.prompt(agent, "Rename from code");
  assert.match(fromCode.outcome.result.reply, /tools__rename needs the user's input: call tools__rename directly/);
  assert.equal(fromCode.outcome.result.stopped, undefined);
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
  const agent = await new AgentRuntime({ url: r.base, apiKey: OPERATOR, journalStore: memoryJournalStore() }).createAgent({ tools });
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
  const agent = await new AgentRuntime({ url: r.base, apiKey: OPERATOR, journalStore: memoryJournalStore() }).createAgent({ tools, onInput: input => { seen.push(input); return { action: "accept", actor: "ops" }; } });
  t.after(() => agent.close());
  const suspended = await agent.prompt("Wipe d1", { timeoutMs: 30_000 });
  assert.equal(suspended.stopped, "input_required");
  await until(() => r.model.bodies.length === 2, "the resumed turn");
  assert.deepEqual(wiped, ["d1"]);
  assert.equal(seen[0].detail.tool, "wipe");
  assert.equal(seen[0].detail.source, "application");
  assert.deepEqual((await agent.inputs())[0].answer?.by, { via: "agent", actor: "ops" });
});

test("a remote MCP tool sets its own exposure in _meta, over its source's; an approval still makes it direct", async t => {
  const plain = { call: () => ({ content: [{ type: "text", text: "ok" }] }) };
  const exposure = (value: string) => ({ ...plain, _meta: { "agent-runtime/exposure": value } });
  const server = await rawMcp(t, { key: exposure("direct"), hidden: exposure("codemode"), gated: exposure("codemode"), plain });
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Exposed", mcpServers: [{ name: "s", url: server.url, exposure: "codemode", approval: { tools: { gated: "always" } } }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  const tools = Object.fromEntries((await r.call(`/v1/agents/${agent}`)).json.toolSources.find((source: any) => source.name === "s").tools.map((tool: any) => [tool.name, tool.exposure]));
  assert.deepEqual(tools, { s__key: "direct", s__hidden: "codemode", s__gated: "direct", s__plain: "codemode" });
});
