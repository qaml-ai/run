import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, Agents, schema, tool, toolServer } from "../clients/node.ts";
import { OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

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
