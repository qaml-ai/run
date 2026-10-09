import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { lastUser, OPERATOR, runtime, until } from "./runtime-server.ts";
import { AgentRuntime } from "../clients/typescript.ts";
import { Agents, RunError } from "../clients/node.ts";

const system = (body: any) => body.messages.find((message: any) => message.role === "system" || message.role === "developer")?.content ?? "";

test("an agent made with an idempotency key lives until deleted by default; one made without lives a day", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const keyed = await r.call("/v1/agents", { body: {}, headers: { "Idempotency-Key": "support-thread-1" } });
  assert.equal(keyed.status, 201, keyed.text);
  assert.equal(keyed.json.expiresAt, null);
  const scratch = await r.call("/v1/agents", { body: {} });
  assert.ok(scratch.json.expiresAt - Date.now() > 23 * 3_600_000 && scratch.json.expiresAt - Date.now() <= 24 * 3_600_000);
  assert.equal((await r.call("/client-sessions", { body: {}, headers: { "Idempotency-Key": "sdk-invented" } })).status, 404, "agents are made on /v1/agents only");
  const limited = await r.call("/v1/agents", { body: { ttlSeconds: 3600 }, headers: { "Idempotency-Key": "short-lived" } });
  assert.ok(limited.json.expiresAt - Date.now() <= 3_600_000, "ttlSeconds still sets one");
});

test("an agent with an idle lifetime lives on from each run it is sent", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  assert.match((await r.call("/v1/agents", { body: { ttlSeconds: 600, idleTtlSeconds: 600 } })).text, /not both/);
  assert.equal((await r.call("/v1/agents", { body: { idleTtlSeconds: 10 } })).status, 400);
  const made = await r.call("/v1/agents", { body: { idleTtlSeconds: 600 } });
  assert.equal(made.status, 201, made.text);
  const expiry = async () => (await r.call(`/v1/agents/${made.json.id}`)).json.expiresAt as number;
  const first = await expiry();
  assert.ok(Math.abs(first - Date.now() - 600_000) < 60_000, `expires in ten minutes: ${first}`);
  // A run with most of the window left leaves the expiry be (client-lifecycle.test.ts moves it on).
  await r.prompt(made.json.id, "hi");
  assert.equal(await expiry(), first);
});

test("agents are listed with the key they were made with, and their name", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const keyed = (await r.call("/v1/agents", { body: { name: "Support" }, headers: { "Idempotency-Key": "support-7" } })).json;
  const scratch = (await r.call("/v1/agents", { body: {} })).json;
  const listed = (await r.call("/v1/agents")).json;
  const of = (id: string) => listed.find((agent: any) => agent.id === id);
  assert.deepEqual([of(keyed.id).key, of(keyed.id).name], ["support-7", "Support"]);
  assert.equal(of(scratch.id).key, null, "an agent made without a key has none");
  assert.equal((await r.call(`/v1/agents/${keyed.id}`)).json.key, "support-7");
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  assert.equal((await sdk.listAgents()).find(agent => agent.id === keyed.id)?.key, "support-7");
});

test("an agent is made without a model key; its first run says which key to set", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), {}, { tenants: { keyless: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex") } } });
  assert.equal((await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).me()).defaultModel, "openrouter/openai/gpt-4o-mini");
  const unnamed = await r.call("/v1/agents", { body: {} });
  assert.equal(unnamed.status, 201, unnamed.text);
  const accepted = await r.call(`/v1/agents/${unnamed.json.id}/prompt`, { body: { text: "hi" } });
  assert.equal(accepted.status, 202, accepted.text);
  const record = await until(async () => {
    const got = (await r.call(`/v1/agents/${unnamed.json.id}/requests/${accepted.json.id}`)).json;
    return got.state === "completed" && got;
  }, "the run to end");
  assert.match(record.error, /No openrouter API key.*openrouter\/openai\/gpt-4o-mini; set one with PUT \/v1\/providers\/openrouter\/key.*GET \/v1\/models\?available=true/);
  // It ended, and failed: the record says so on top, and the result names the cause.
  assert.equal(record.status, "failed");
  assert.equal(record.outcome.result.code, "model_key_missing");
  // The SDK's RunError carries the code and the remedy.
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const failed = await agents.upsert("keyless-sdk").then(agent => agent.run("hi")).then(() => assert.fail("expected a RunError"), error => error);
  assert.ok(failed instanceof RunError);
  assert.equal(failed.code, "model_key_missing");
  assert.equal(failed.run.status, "failed");
  assert.match(failed.message, /PUT \/v1\/providers\/openrouter\/key.*GET \/v1\/models\?available=true/);
  // A create with a first prompt is accepted too; that prompt's run says the same.
  const named = await r.call("/v1/agents", { body: { model: "anthropic/claude-sonnet-5", prompt: { text: "hi" } } });
  assert.equal(named.status, 201, named.text);
  const first = await until(async () => {
    const got = (await r.call(`/v1/agents/${named.json.id}/requests/${named.json.prompt.id}`)).json;
    return got.state === "completed" && got;
  }, "the first prompt to end");
  assert.match(first.error, /No anthropic API key.*anthropic\/claude-sonnet-5; set one with PUT \/v1\/providers\/anthropic\/key/);
});

test("a key whose agent was deleted or expired makes a fresh agent, with a new token; the old one stays gone", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const first = (await r.call("/v1/agents", { body: {}, headers: { "Idempotency-Key": "thread-a" } })).json;
  await r.prompt(first.id, "remember me");
  assert.equal((await r.call(`/v1/agents/${first.id}`, { method: "DELETE" })).status, 200);
  const second = await r.call("/v1/agents", { body: {}, headers: { "Idempotency-Key": "thread-a" } });
  assert.equal(second.status, 201, second.text);
  assert.notEqual(second.json.id, first.id);
  assert.notEqual(second.json.token, first.token);
  assert.equal((await r.call(`/v1/agents/${second.json.id}/history`)).json.messages.length, 0, "a fresh agent");
  assert.equal((await r.call(`/v1/agents/${first.id}`)).status, 404, "the deleted one stays deleted");
  assert.equal((await r.call("/v1/agents", { body: {}, headers: { "Idempotency-Key": "thread-a" } })).json.id, second.json.id, "and the key now means the new one");

  // Expired: the same, on a node that reads it from the database.
  const lapsing = (await r.call("/v1/agents", { body: { ttlSeconds: 60 }, headers: { "Idempotency-Key": "thread-b" } })).json;
  const stopped = once(r.child, "exit");
  r.child.kill("SIGTERM");
  await stopped;
  await r.db.query("update agents set expires_at = $2, header = jsonb_set(header::jsonb, '{expiresAt}', to_jsonb($2::bigint))::json where id = $1", [lapsing.id, Date.now() - 1000]);
  const next = await runtime(t, () => ({ role: "assistant", content: "ok" }), {}, undefined, { databaseUrl: r.databaseUrl });
  const renewed = await next.call("/v1/agents", { body: { ttlSeconds: 60 }, headers: { "Idempotency-Key": "thread-b" } });
  assert.equal(renewed.status, 201, renewed.text);
  assert.notEqual(renewed.json.id, lapsing.id);
});

test("the same key with a changed configuration reconfigures the agent instead of refusing; what cannot change says so", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const key = { "Idempotency-Key": "assistant-7" };
  const tool = (description: string) => ({ name: "lookup", description, inputSchema: { type: "object", properties: {} } });
  const made = (await r.call("/v1/agents", { body: { systemPrompt: "Be brief.", name: "v1", mcp: { tools: [tool("Look up v1")] } }, headers: key })).json;
  await r.prompt(made.id, "one", undefined, { allowDisconnected: true });
  assert.match(system(r.model.bodies[0]), /Be brief\./);

  const same = await r.call("/v1/agents", { body: { systemPrompt: "Be brief.", name: "v1", mcp: { tools: [tool("Look up v1")] } }, headers: key });
  assert.equal(same.status, 201);
  assert.equal(same.json.id, made.id);
  assert.ok(same.json.reconfigured, "an upsert always queues its target");

  const edited = await r.call("/v1/agents", { body: { systemPrompt: "Be thorough.", name: "v2", thinkingLevel: "low", mcp: { tools: [tool("Look up v2")] } }, headers: key });
  assert.equal(edited.status, 201, edited.text);
  assert.equal(edited.json.id, made.id);
  assert.equal(edited.json.token, made.token);
  assert.equal(edited.json.reconfigured.method, "configure");
  await until(async () => (await r.call(`/v1/agents/${made.id}/requests/${edited.json.reconfigured.id}`)).json.state === "completed", "the reconfiguration");
  const detail = (await r.call(`/v1/agents/${made.id}`)).json;
  assert.deepEqual([detail.systemPrompt, detail.name, detail.tools[0].description], ["Be thorough.", "v2", "Look up v2"]);
  await r.prompt(made.id, "two", undefined, { allowDisconnected: true });
  assert.match(system(r.model.bodies.at(-1)), /Be thorough\./);
  assert.equal(lastUser(r.model.bodies.at(-1)), "two");
  assert.equal((await r.call(`/v1/agents/${made.id}/history`)).json.messages.length, 4, "history kept");
  const repeated = (await r.call("/v1/agents", { body: { systemPrompt: "Be thorough.", name: "v2", thinkingLevel: "low", mcp: { tools: [tool("Look up v2")] } }, headers: key })).json.reconfigured;
  const settled = await until(async () => { const record = (await r.call(`/v1/agents/${made.id}/requests/${repeated.id}`)).json; return record.state === "completed" && record; }, "the repeated upsert");
  assert.equal(settled.outcome.result.changed, false, "an upsert repeated changes nothing");

  const moved = await r.call("/v1/agents", { body: { systemPrompt: "Be thorough.", subject: "someone-else" }, headers: key });
  assert.equal(moved.status, 409);
  assert.match(moved.json.error, /subject/);
});

test("the last upsert wins: back to an earlier configuration, and upserts queued behind a running turn", async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  let holding = false;
  const r = await runtime(t, async () => { if (holding) await gate.promise; return { role: "assistant", content: "ok" }; });
  const key = { "Idempotency-Key": "last-wins" };
  const upsert = async (systemPrompt: string) => (await r.call("/v1/agents", { body: { systemPrompt }, headers: key })).json;
  const settle = async (made: any) => until(async () => (await r.call(`/v1/agents/${made.id}/requests/${made.reconfigured.id}`)).json.state === "completed", "the upsert");
  const prompt = async (id: string) => (await r.call(`/v1/agents/${id}`)).json.systemPrompt;
  const a = await upsert("A.");
  for (const target of ["B.", "A.", "B."]) await settle(await upsert(target));
  assert.equal(await prompt(a.id), "B.", "B, then A, then B again: B");

  // Behind a running turn, upserts queue: the last one sent is what the agent ends up with, whatever the header says meanwhile.
  holding = true;
  await r.call(`/v1/agents/${a.id}/prompt`, { body: { text: "hold" } });
  await until(() => r.model.bodies.length === 1, "the turn to start");
  await upsert("C.");
  const last = await upsert("B.");
  holding = false;
  gate.resolve();
  await settle(last);
  assert.equal(await prompt(a.id), "B.", "C was queued, then B (the header's own value) again: B");
});
