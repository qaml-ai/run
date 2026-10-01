import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { AgentRuntime, Agents, RunError, schema, tool, toolServer, type StreamPart } from "../clients/node.ts";
import { OPERATOR, runtime, sleep, toolCall, toolResults, until } from "./runtime-server.ts";

/** A runtime whose model answers with `respond`, and an Agents client for it. */
async function setup(t: { after(fn: () => Promise<void> | void): void }, respond: Parameters<typeof runtime>[1], env: Record<string, string> = {}) {
  const r = await runtime(t, respond, env);
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  /** An agent made over REST, then held by the simple API. */
  const make = async (config: Parameters<Agents["agent"]>[1] = {}) => {
    const created = await r.call("/v1/agents", { body: { ttlSeconds: null, ...(config.tools ? { mcp: { tools: await toolServer(config.tools).listTools() } } : {}) } });
    assert.equal(created.status, 201, created.text);
    return agents.agent({ id: created.json.id, token: created.json.token, expiresAt: null }, config);
  };
  return { r, agents, make };
}
const echo = (execute: (args: { value: string }, context: any) => unknown) => tool({
  description: "Echo a value", input: schema.Object({ value: schema.String() }, { additionalProperties: false }), execute,
});

test("run() resolves with a typed Run; the agent's id is public and its token stays out of logs", async t => {
  const { make } = await setup(t, () => ({ role: "assistant", content: "Hello there." }));
  const agent = await make();
  const run = await agent.run("Hi", { user: "u1" });
  assert.equal(run.status, "completed");
  assert.equal(run.text, "Hello there.");
  assert.deepEqual(run.inputs, []);
  assert.equal(run.error, null);
  assert.match(run.id, /^[0-9a-f-]{36}$/);
  assert.match(agent.id, /^client_[a-f0-9]{40}$/);
  const token = agent.session.token;
  assert.ok(token.length > 20, "the token is still there for code that needs it");
  for (const shown of [JSON.stringify(agent), JSON.stringify(agent.session), inspect(agent), inspect(agent.session), inspect(agent.client), JSON.stringify(agent.client)]) {
    assert.ok(!shown.includes(token), `no token in ${shown}`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(agent)), { id: agent.id });
});

test("a failed run throws a RunError with the run, or resolves with it given throwOnError: false", async t => {
  const { make } = await setup(t, () => ({ httpStatus: 400, message: "model says no" }));
  const agent = await make();
  const error = await agent.run("Hi").then(() => assert.fail("expected a RunError"), error => error);
  assert.ok(error instanceof RunError);
  assert.equal(error.run.status, "failed");
  assert.equal(error.code, "model_error");
  assert.match(error.message, /model says no/);
  const run = await agent.run("Again", { throwOnError: false });
  assert.equal(run.status, "failed");
  assert.equal(run.error?.code, "model_error");
});

test("stream() yields tool calls, results and text, then done with the run", async t => {
  const { make } = await setup(t, (body, index) => index === 0 ? toolCall("echo", { value: "ping" }, "call_echo")
    : { role: "assistant", content: `Echoed ${JSON.parse(toolResults(body).at(-1)).value}` });
  const agent = await make({ tools: { echo: echo(({ value }) => ({ value })) } });
  const parts: StreamPart[] = [];
  const stream = agent.stream("Echo ping");
  for await (const part of stream) parts.push(part);
  assert.deepEqual(parts.map(part => part.type), ["tool_call", "tool_result", "text", "done"]);
  const [call, result, text, done] = parts as any[];
  assert.deepEqual([call.name, call.arguments], ["echo", { value: "ping" }]);
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.output), { value: "ping" });
  assert.equal(text.text, "Echoed ping");
  assert.equal(done.run.text, "Echoed ping");
  assert.equal((await stream.result()).id, stream.id);
});

test("a tool that returns nothing succeeds with null; its context has a stable idempotency key and reports progress", async t => {
  const { make, r } = await setup(t, (body, index) => index === 0 ? toolCall("save", { value: "x" }, "call_save") : { role: "assistant", content: "Saved." });
  const keys: string[] = [];
  const events: any[] = [];
  const save = echo(async (_args, context) => {
    keys.push(context.idempotencyKey);
    context.progress("halfway");
    await sleep(300);
  });
  const agent = await make({ tools: { save }, onEvent: event => { events.push(event); } });
  const run = await agent.run("Save x");
  assert.equal(run.text, "Saved.");
  assert.equal(toolResults(r.model.bodies[1]).at(-1), "null", "the model hears null, not a failure");
  assert.equal(keys.length, 1);
  assert.match(keys[0], /^[0-9a-f]{32}$/, "the runtime's key for this call");
  await until(() => events.some(event => event.type === "tool_execution_update" && JSON.stringify(event.partialResult).includes("halfway")), "the progress event");
});

test("a slow onEvent never holds up the agent's tool calls", async t => {
  const { make } = await setup(t, (body, index) => index < 3 ? toolCall("echo", { value: `v${index}` }, `call_${index}`) : { role: "assistant", content: "Done." }, {});
  let handled = 0;
  const agent = await make({
    tools: { echo: echo(({ value }) => value) },
    // Far slower than the runtime's 15 s tool timeout, in all.
    onEvent: async () => { await sleep(1000); handled++; },
  });
  const started = Date.now();
  const run = await agent.run("Echo three times");
  assert.equal(run.text, "Done.");
  assert.ok(Date.now() - started < 10_000, "the run did not wait for onEvent");
  assert.ok(handled < 10, "events were still being handled when the run ended");

  // Closing stops onEvent: the call in progress finishes, and the backlog is dropped.
  const closing = Date.now();
  await agent.close();
  assert.ok(Date.now() - closing < 1_500, "close waited only for the call in progress");
  const atClose = handled;
  await sleep(2_500);
  assert.equal(handled, atClose, "no queued event reached onEvent after close");
});

test("an onEvent that throws is reported to onError, and the connection goes on", async t => {
  const { make } = await setup(t, () => ({ role: "assistant", content: "Fine." }));
  const errors: Error[] = [];
  const agent = await make({ onEvent: () => { throw new Error("display broke"); }, onError: error => errors.push(error) });
  assert.equal((await agent.run("One")).text, "Fine.");
  assert.equal((await agent.run("Two")).text, "Fine.");
  assert.ok(errors.some(error => /display broke/.test(error.message)));
});

test("an approval: the run waits with its input, and answering it resolves with the resumed run", async t => {
  const { make } = await setup(t, (body, index) => index === 0 ? toolCall("deploy", { value: "prod" }, "call_deploy") : { role: "assistant", content: `Result: ${toolResults(body).at(-1)}` });
  let deployed = 0;
  const deploy = tool({
    description: "Deploy", input: schema.Object({ value: schema.String() }), needsApproval: true,
    execute: () => { deployed++; return "deployed"; },
  });
  const agent = await make({ tools: { deploy } });
  const run = await agent.run("Deploy");
  assert.equal(run.status, "input_required");
  assert.equal(run.inputs.length, 1);
  assert.equal(run.inputs[0].kind, "approval");
  assert.deepEqual(run.toolCalls, [{ tool: "deploy", toolCallId: "call_deploy", ok: false, code: "input_required" }]);
  assert.equal(deployed, 0);
  const resumed = await run.inputs[0].answer(true);
  assert.equal(resumed.status, "completed");
  assert.deepEqual(resumed.toolCalls, [{ tool: "deploy", toolCallId: "call_deploy", ok: true }]);
  assert.equal(deployed, 1);
  assert.match(resumed.text, /deployed/);
});

test("a run's wait has no timeout, and an AbortSignal stops the wait without stopping the run", async t => {
  const { make } = await setup(t, () => ({ role: "assistant", content: "Late.", delayMs: 1500 }));
  const agent = await make();
  await assert.rejects(agent.run("Slow", { signal: AbortSignal.timeout(100), idempotencyKey: "slow-1" }), (error: Error) => error.name === "TimeoutError");
  // The same key observes the same run, which went on.
  assert.equal((await agent.run("Slow", { idempotencyKey: "slow-1" })).text, "Late.");
});

test("the same key sent again while its run goes on joins that run, and one caller's timeout leaves the other waiting", async t => {
  const { make, r } = await setup(t, () => ({ role: "assistant", content: "Late.", delayMs: 1000 }));
  const agent = await make();
  const [first, again, impatient] = await Promise.allSettled([
    agent.run("Slow", { idempotencyKey: "same-run" }),
    agent.run("Slow", { idempotencyKey: "same-run" }),
    agent.run("Slow", { idempotencyKey: "same-run", signal: AbortSignal.timeout(100) }),
  ]);
  assert.equal(first.status === "fulfilled" && first.value.text, "Late.");
  assert.equal(again.status === "fulfilled" && again.value.text, "Late.");
  assert.equal(impatient.status === "rejected" && impatient.reason.name, "TimeoutError");
  assert.equal(r.model.bodies.length, 1, "one run");
  assert.equal((await agent.client.waitForRequest("same-run")).reply, "Late.");
});

test("Agents defaults to the hosted runtime, and needs an API key to make agents", async () => {
  const seen: string[] = [];
  const agents = new Agents({ apiKey: "k".repeat(32), fetch: async input => { seen.push(String(input)); return Response.json({ error: "stop here" }, { status: 400 }); } });
  await assert.rejects(agents.upsert("demo"), /stop here/);
  assert.ok(seen[0].startsWith("https://run.camelai.com/"), seen[0]);
  const saved = process.env.CAMELAI_API_KEY;
  delete process.env.CAMELAI_API_KEY;
  try { await assert.rejects(new Agents({ url: "http://127.0.0.1:1" }).upsert("demo"), /CAMELAI_API_KEY/); }
  finally { if (saved !== undefined) process.env.CAMELAI_API_KEY = saved; }
});

test("upsert: the same key is the same agent, and a changed configuration reconfigures it", async t => {
  const { agents, r } = await setup(t, () => ({ role: "assistant", content: "ok" }));
  const first = await agents.upsert("support-triage", { instructions: "You are terse." });
  assert.equal((await first.run("hi")).text, "ok");
  await first.close();
  const again = await agents.upsert("support-triage", { instructions: "You are terse." });
  assert.equal(again.id, first.id);
  const added = echo(({ value }) => `added ${value}`);
  const changed = await agents.upsert("support-triage", { instructions: "You are verbose.", tools: { added } });
  assert.equal(changed.id, first.id, "a new configuration is the same agent");
  await changed.run("again");
  const system = r.model.bodies.at(-1).messages.find((message: any) => message.role === "system" || message.role === "developer").content;
  assert.match(JSON.stringify(system), /You are verbose/);
  assert.deepEqual((await changed.client.execute('return await tools.added({value:"x"})')).output, ["added x"]);
  await assert.rejects(agents.upsert("not a key!"), /letters, digits/);
});

test("the same create sent twice at once makes one agent, and the same prompt twice at once runs once", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const body = { name: "thread", ttlSeconds: null, systemPromptAppend: "Be brief.", subject: "user_1", context: { org: "org_1" } };
  const made = await Promise.all([1, 2].map(() => r.call("/v1/agents", { body, headers: { "Idempotency-Key": "thread_1" } })));
  assert.deepEqual(made.map(result => result.status), [201, 201], JSON.stringify(made.map(result => result.json)));
  assert.equal(made[0].json.id, made[1].json.id);
  assert.deepEqual((await r.call("/v1/agents")).json.map((agent: any) => agent.id), [made[0].json.id]);
  const id = made[0].json.id;
  const sent = await Promise.all([1, 2].map(() => r.call(`/v1/agents/${id}/prompt`, { body: { text: "hi", requestId: "send_1" } })));
  assert.ok(sent.every(result => [200, 202].includes(result.status) && result.json.id === "send_1"), JSON.stringify(sent.map(result => [result.status, result.json])));
  await until(async () => (await r.call(`/v1/agents/${id}/requests/send_1`)).json.state === "completed", "the turn to end");
  assert.equal(r.model.bodies.length, 1, "one turn, one model call");
});

test("a create can carry the first prompt: sent once per requestId, a refused one leaves the agent made, a malformed one makes nothing", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const create = (prompt: unknown, key = "thread_2") => r.call("/v1/agents", { body: { name: "thread", ttlSeconds: null, prompt }, headers: { "Idempotency-Key": key } });
  const made = await create({ text: "hi", requestId: "send_1", metadata: { source: "web" } });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual([made.json.prompt.id, made.json.prompt.method, made.json.prompt.metadata], ["send_1", "prompt", { source: "web" }]);
  const again = await create({ text: "hi", requestId: "send_1", metadata: { source: "web" } });
  assert.deepEqual([again.status, again.json.id, again.json.prompt.id], [201, made.json.id, "send_1"]);
  await until(async () => (await r.call(`/v1/agents/${made.json.id}/requests/send_1`)).json.state === "completed", "the turn to end");
  assert.equal(r.model.bodies.length, 1, "a retried create sends its prompt once");

  const refused = await create({ text: "hi", requestId: "send_2", files: [{ path: "/workspace/missing.txt" }] }, "thread_3");
  assert.equal(refused.status, 201, refused.text);
  assert.deepEqual(Object.keys(refused.json.prompt), ["error"]);
  assert.equal(refused.json.prompt.error.status, 400);
  assert.equal(typeof refused.json.prompt.error.code, "string");
  assert.equal((await r.call(`/v1/agents/${refused.json.id}`)).status, 200, "the agent was made");

  const malformed = await create({ requestId: "send_3" }, "thread_4");
  assert.equal(malformed.status, 400);
  assert.equal((await r.call("/v1/agents")).json.length, 2, "nothing made for a malformed prompt");
});

test("one process serves an agent's tools at a time; others may still run it, and takeover replaces the one serving", async t => {
  const { r } = await setup(t, () => ({ role: "assistant", content: "ok" }));
  const one = new Agents({ url: r.base, apiKey: OPERATOR }), two = new Agents({ url: r.base, apiKey: OPERATOR }), three = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(async () => { await one.close(); await two.close(); await three.close(); });
  const tools = { echo: echo(({ value }) => value) };
  const errors: Error[] = [];
  const serving = await one.upsert("shared", { tools, onError: error => errors.push(error) });
  await assert.rejects(two.upsert("shared", { tools }), (error: any) => error.code === "APPLICATION_CONNECTED" && /takeover/.test(error.message));
  // A process that declares the tools without serving them runs the agent, however many there are.
  const follower = await three.upsert("shared", { tools, attach: false });
  assert.equal((await follower.run("hi")).text, "ok");
  // Taking over: the process that served them stops, rather than take them back.
  const taken = await two.upsert("shared", { tools, takeover: true });
  assert.equal(taken.id, serving.id);
  await until(() => errors.some((error: any) => error.code === "APPLICATION_REPLACED"), "the replaced process to hear it");
  assert.deepEqual((await taken.client.execute('return await tools.echo({value:"mine"})')).output, ["mine"]);
});

test("a browser token minted through the SDK reads its agent, and only that", async t => {
  const { agents, make, r } = await setup(t, () => ({ role: "assistant", content: "ok" }));
  const agent = await make();
  const other = await make();
  const minted = await agents.runtime.browserToken(agent.id, { ttlSeconds: 60 });
  assert.equal(minted.agentId, agent.id);
  const read = (id: string) => fetch(`${r.base}/v1/agents/${id}/state`, { headers: { Authorization: `Bearer ${minted.token}` } });
  assert.equal((await read(agent.id)).status, 200);
  assert.equal((await read(other.id)).status, 403);
});

test("a process that connects with other tools than the agent has declares them; one with none connected is refused unless it allows that", async t => {
  const { agents, r } = await setup(t, () => ({ role: "assistant", content: "ok" }));
  const created = await r.call("/v1/agents", { body: { ttlSeconds: null, mcp: { tools: await toolServer({ old: echo(() => "old") }).listTools() } } });
  const session = { id: created.json.id, token: created.json.token, expiresAt: null };
  // Nobody serves the agent's tools: a run is refused rather than run without them.
  const follower = await agents.agent(session);
  await assert.rejects(follower.run("hi"), (error: any) => error.code === "APPLICATION_NOT_CONNECTED");
  assert.equal((await follower.run("hi", { allowDisconnected: true })).text, "ok");
  // A process restarted with changed tools brings the agent up to date as it connects.
  const serving = await agents.agent(session, { tools: { fresh: echo(({ value }) => `fresh ${value}`) } });
  await until(async () => {
    const result = await serving.client.execute('return await tools.fresh({value:"x"})').catch(() => undefined);
    return result?.output?.[0] === "fresh x";
  }, "the new tools to be declared");
});

test("steer is a run: with no turn running, it starts one and resolves with it; run itself queues", async t => {
  const { make, r } = await setup(t, () => ({ role: "assistant", content: "noted" }));
  const agent = await make();
  assert.equal((await agent.steer("Also check the logs")).text, "noted");
  assert.equal(r.model.bodies.length, 1);
  assert.equal("followUp" in agent, false);
  assert.equal("followUp" in agent.client, false);
});

test("the lower-level createAgent makes a scratch agent (a day's lifetime) unless the caller gives it a key", async t => {
  const { r } = await setup(t, () => ({ role: "assistant", content: "ok" }));
  const runtime = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const scratch = await runtime.createAgent({});
  t.after(() => scratch.close());
  assert.ok(scratch.session.expiresAt && Math.abs(scratch.session.expiresAt - Date.now() - 86_400_000) < 60_000, `expires in a day: ${scratch.session.expiresAt}`);
  const keyed = await runtime.createAgent({ idempotencyKey: "mine" });
  t.after(() => keyed.close());
  assert.equal(keyed.session.expiresAt, null, "a key of the caller's makes a durable agent");
});

test("upsert gives an agent builtins without a definition", async t => {
  const { r, agents } = await setup(t, () => ({ role: "assistant", content: "ok" }));
  const agent = await agents.upsert("researcher", { builtins: ["web_fetch", "ask_user"] });
  assert.deepEqual((await r.call(`/v1/agents/${agent.id}`)).json.builtins, ["web_fetch", "ask_user"]);
});

test("an agent's history is the list of its messages", async t => {
  const { make } = await setup(t, () => ({ role: "assistant", content: "ok" }));
  const agent = await make();
  await agent.run("hello");
  const history = await agent.history();
  assert.ok(Array.isArray(history));
  assert.deepEqual(history.map(message => message.role), ["user", "assistant"]);
});

test("a run takes a budget of its own", async t => {
  // Every response costs something and asks for another tool call: only the budget ends the run.
  const { make } = await setup(t, (_body, index) => ({ ...toolCall("js_exec", { code: `return ${index}` }, `call_${index}`), usage: { prompt_tokens: 100_000, completion_tokens: 0 } }));
  const agent = await make();
  const run = await agent.run("Go", { spendLimit: { usd: 0.001 }, throwOnError: false });
  assert.equal(run.raw?.stopped, "spend_limit");
  assert.match(run.error!.message, /This run has reached its spend limit/);
});
