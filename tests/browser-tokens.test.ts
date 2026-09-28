import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, OPERATOR, OTHER_OPERATOR, runtime, sleep, toolCall, until, watchEvents } from "./runtime-server.ts";

const usage = { prompt_tokens: 100, completion_tokens: 20 };
async function setup(t: Parameters<typeof runtime>[0]) {
  const r = await runtime(t, (_body, index) => index % 2 === 0 ? { ...toolCall("js_exec", { code: "console.log('hi'); return 1" }, `call_${index}`), usage } : { content: "done", usage });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const other = (await r.call("/v1/agents", { body: { name: "other" } })).json.id as string;
  const mint = async (body: object = {}, id = agent, token?: string) => r.call(`/v1/agents/${id}/browser-tokens`, { body, token });
  return { r, agent, other, mint };
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

test("a browser token reads its one agent's events, state, history and inputs, and nothing else", async t => {
  const { r, agent, other, mint } = await setup(t);
  const minted = await mint({ subject: "user_1" });
  assert.equal(minted.status, 201, minted.text);
  assert.equal(minted.json.agentId, agent);
  assert.ok(minted.json.expiresAt > Date.now() + 800_000 && minted.json.expiresAt <= Date.now() + 900_000, "15 minutes by default");
  assert.equal(minted.json.url, "https://agents.example.test");
  const token = minted.json.token as string;

  const watcher = await watchEvents(t, `${r.base}/v1/agents/${agent}/events`, bearer(token), { query: "snapshot=1" });
  assert.equal(watcher.status, 200);
  const done = await r.prompt(agent, "go");
  await until(() => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === done.id), "the outcome");
  const events = watcher.frames.filter(frame => frame.data.type === "event").map(frame => frame.data.event.type);
  assert.ok(events.includes("message_update") && events.includes("tool_execution_end"));
  for (const internal of ["codemode", "compaction_usage"]) assert.ok(!events.includes(internal), `${internal} is the runtime's own`);
  assert.deepEqual(watcher.frames.find(frame => frame.data.type === "response")!.data, { type: "response", id: done.id, outcome: {} }, "an outcome, not its result");
  assert.equal(watcher.frames[0].data.watch, true);

  const state = await r.call(`/v1/agents/${agent}/state`, { token });
  assert.equal(state.status, 200);
  assert.deepEqual(Object.keys(state.json.requests.find((request: any) => request.id === done.id)).sort(), ["began", "endedAt", "id", "method", "outcome", "startedAt", "state"]);
  assert.equal((await r.call(`/v1/agents/${agent}/history?limit=10`, { token })).json.entries.length, 4);
  assert.equal((await r.call(`/v1/agents/${agent}/history`, { token })).json.messages.length, 4);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/inputs?state=pending`, { token })).json, []);
  // Polled from the snapshot's cursor, the same events, as the token sees them.
  const polled = await (await fetch(`${r.base}/v1/agents/${agent}/events?poll=1`, { headers: { ...bearer(token), "Last-Event-ID": String(watcher.frames.find(frame => frame.data.type === "snapshot")!.id) } })).json() as any;
  assert.ok(polled.events.some((event: any) => event.data.type === "response"));
  assert.ok(polled.events.every((event: any) => event.data.type !== "event" || event.data.event.type !== "codemode"));

  // It cannot act for the tenant, read anything else, or read another agent, of its tenant or any other.
  const refused = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await r.call(path, { ...init, token });
    assert.equal(response.status, 403, `${init.method ?? (init.body ? "POST" : "GET")} ${path}: ${response.text}`);
  };
  await refused(`/v1/agents/${agent}/prompt`, { body: { text: "hi" } });
  await refused(`/v1/agents/${agent}/abort`, { body: {} });
  await refused(`/v1/agents/${agent}/inputs/input_x`, { body: { action: "accept" } });
  await refused(`/v1/agents/${agent}/inputs`, { body: { answers: [] } });
  await refused(`/v1/agents/${agent}/configuration`, { method: "PATCH", body: { model: "openai/gpt-4o" } });
  await refused(`/v1/agents/${agent}/browser-tokens`, { body: {} });
  await refused(`/v1/agents/${agent}`, { method: "DELETE" });
  await refused(`/v1/agents/${agent}`);
  await refused(`/v1/agents/${agent}/requests/${done.id}`);
  await refused(`/v1/agents/${agent}/schedules`);
  await refused("/v1/agents");
  await refused("/v1/me");
  await refused("/v1/tokens");
  await refused(`/v1/agents/${other}/events?poll=1`);
  await refused(`/v1/agents/${other}/history`);
  const bobs = (await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR })).json.id;
  await refused(`/v1/agents/${bobs}/state`);
  // The agent's own routes take only its own token.
  assert.equal((await fetch(`${r.base}/clients/${agent}/state`, { headers: bearer(token) })).status, 401);
  assert.equal((await r.call(`/registry/${agent}`, { token })).status, 401);
  // Another tenant cannot mint one for this agent.
  assert.equal((await mint({}, agent, OTHER_OPERATOR)).status, 404);
  assert.equal(minted.json.token.includes(OPERATOR), false);
});

test("a browser token's scopes, event list and redaction limit what it reads; a forged or expired one reads nothing", async t => {
  const { r, agent, mint } = await setup(t);
  assert.equal((await mint({ ttlSeconds: 1 })).status, 400);
  assert.equal((await mint({ ttlSeconds: 3601 })).status, 400);
  assert.equal((await mint({ scopes: ["prompt"] })).status, 400);
  assert.equal((await mint({ redact: ["toolCall.arguments"] })).status, 400);
  assert.equal((await mint({ owner: "x" })).status, 400);

  const history = (await mint({ scopes: ["history"] })).json.token;
  assert.equal((await r.call(`/v1/agents/${agent}/events?poll=1`, { token: history })).status, 403);
  assert.equal((await r.call(`/v1/agents/${agent}/history`, { token: history })).status, 200);

  const narrow = (await mint({ events: ["message_end"], redact: ["usage.cost"] })).json.token;
  const watcher = await watchEvents(t, `${r.base}/v1/agents/${agent}/events`, bearer(narrow), { query: "" });
  const done = await r.prompt(agent, "go");
  await until(() => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === done.id), "the outcome");
  const events = watcher.frames.filter(frame => frame.data.type === "event").map(frame => frame.data.event);
  assert.ok(events.length > 0 && events.every(event => event.type === "message_end"), "only the listed events");
  const assistant = events.find(event => event.message.role === "assistant").message;
  assert.ok(assistant.usage && !("cost" in assistant.usage), "no cost in the stream");
  // Nor anywhere else in a frame: every event, whatever holds the messages.
  const everything = await (await fetch(`${r.base}/v1/agents/${agent}/events?poll=1`, { headers: { ...bearer((await mint({ redact: ["usage.cost"] })).json.token), "Last-Event-ID": String(watcher.frames.find(frame => frame.id && frame.data.type !== "snapshot")!.id! - 1) } })).json() as any;
  const costs = (value: any): number => !value || typeof value !== "object" ? 0 : (value.usage && typeof value.usage === "object" && "cost" in value.usage ? 1 : 0) + Object.values(value).reduce((sum: number, item) => sum + costs(item), 0);
  assert.ok(everything.events.some((event: any) => event.data.event?.type === "agent_end"), "agent_end is there to check");
  assert.equal(costs(everything), 0, "no usage anywhere carries its cost");
  const page = (await r.call(`/v1/agents/${agent}/history?limit=10`, { token: narrow })).json;
  for (const entry of page.entries.filter((entry: any) => entry.message.role === "assistant")) assert.ok(!("cost" in entry.message.usage), "nor in history");
  const tenants = (await r.call(`/v1/agents/${agent}/history?limit=10`)).json.entries.find((entry: any) => entry.message.role === "assistant").message;
  assert.ok("cost" in tenants.usage, "the tenant still sees it");

  const [payload, mac] = narrow.slice(4).split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  const forged = `abt_${Buffer.from(JSON.stringify({ ...claims, scopes: ["events", "state", "history", "inputs"], agent: "client_" + "0".repeat(40) })).toString("base64url")}.${mac}`;
  assert.equal((await r.call(`/v1/agents/${agent}/state`, { token: forged })).status, 401);

  // A token lives as long as it was minted for; its stream ends then, and after it reads nothing.
  const brief = (await mint({ ttlSeconds: 5 })).json.token;
  const ending = await watchEvents(t, `${r.base}/v1/agents/${agent}/events`, bearer(brief), { query: "" });
  assert.equal(ending.status, 200);
  await until(() => ending.ended, "the stream to end as its token expires", 10_000);
  assert.equal((await r.call(`/v1/agents/${agent}/state`, { token: brief })).status, 401);
  await sleep(0);
});

test("a snapshot shows a token's reader only what its scopes and event list let it read", { timeout: 60_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const model = await listen(t, async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ content: "half " });
    await gate.promise;
    chunk({ content: "done" });
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: `${model}/v1` });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "go" } });
  const snapshot = async (body: object) => {
    const { token } = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body })).json;
    return (await (await fetch(`${r.base}/v1/agents/${agent}/events?poll=1&snapshot=1`, { headers: bearer(token) })).json() as any).events[0].data;
  };
  await until(async () => (await snapshot({})).turn?.partial, "the answer to start");
  // Its messages and the message streaming: history's, or the stream's when the token gets them there.
  assert.equal((await snapshot({ scopes: ["events"], events: ["agent_start", "agent_end"] })).turn, null);
  const streamed = (await snapshot({ scopes: ["events"], events: ["message_update", "message_end"] })).turn;
  assert.equal(streamed.messages.length, 1);
  assert.ok(streamed.partial);
  const ended = (await snapshot({ scopes: ["events"], events: ["message_end"] })).turn;
  assert.equal(ended.messages.length, 1);
  assert.equal(ended.partial, null, "no message_update: not the message streaming either");
  const historic = (await snapshot({ scopes: ["events", "history"], events: ["agent_end"] })).turn;
  assert.equal(historic.messages.length, 1);
  assert.equal(historic.partial, null);
  gate.resolve();
});
