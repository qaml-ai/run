import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { Agents, RunError, schema, tool, toolServer, type StreamPart } from "../clients/node.ts";
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
  assert.equal(deployed, 0);
  const resumed = await run.inputs[0].answer(true);
  assert.equal(resumed.status, "completed");
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

test("Agents defaults to the hosted runtime, and needs an API key to make agents", async () => {
  const seen: string[] = [];
  const agents = new Agents({ apiKey: "k".repeat(32), fetch: async input => { seen.push(String(input)); return Response.json({ error: "stop here" }, { status: 400 }); } });
  await assert.rejects(agents.upsert("demo"), /stop here/);
  assert.ok(seen[0].startsWith("https://agents.camelai.dev/"), seen[0]);
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
