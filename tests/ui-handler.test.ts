import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, runtime, toolCall, toolResults, until } from "./runtime-server.ts";
import { agentKeyFor, createAgentHandler, type AgentHandlerOptions } from "../clients/handler.ts";
import { schema, tool } from "../clients/typescript.ts";

type R = Awaited<ReturnType<typeof runtime>>;
const USERS: Record<string, { id: string; name: string }> = { "cookie-alice": { id: "alice", name: "Alice" }, "cookie-bob": { id: "bob", name: "Bob" } };

/** A handler whose users are known by their cookie, as an app's session check would. */
function handlerFor(t: { after(fn: () => unknown): void }, r: R, options: Partial<AgentHandlerOptions> = {}) {
  const handler = createAgentHandler({
    apiKey: OPERATOR, url: r.base, browserToken: { url: r.base },
    authorize: request => {
      const user = USERS[request.headers.get("cookie") ?? ""];
      return user ? { userId: user.id, name: user.name } : null;
    },
    agent: { instructions: "You help." },
    ...options,
  });
  t.after(() => handler.close());
  return handler;
}
const post = (handler: (request: Request) => Promise<Response>, body: unknown, init: { cookie?: string; headers?: Record<string, string> } = {}) =>
  handler(new Request("https://app.example/api/agent", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(init.cookie !== undefined ? { cookie: init.cookie } : { cookie: "cookie-alice" }), ...init.headers },
  })).then(async response => ({ status: response.status, json: await response.json() as any }));
const record = (r: R, agent: string, id: string) =>
  until(async () => { const value = (await r.call(`/v1/agents/${agent}/requests/${id}`)).json; return value.state === "completed" && value; }, `request ${id}`);

test("agentKeyFor is stable, a valid agent key, and distinct per user and thread without collisions", async () => {
  const key = await agentKeyFor("alice", "t1");
  assert.equal(key, await agentKeyFor("alice", "t1"));
  assert.match(key, /^[A-Za-z0-9_-]{1,80}$/);
  // "a-b" + "x" and "a" + "b-x" must differ: the user and thread are hashed apart.
  assert.notEqual(await agentKeyFor("a-b", "x"), await agentKeyFor("a", "b-x"));
  assert.notEqual(await agentKeyFor("alice"), await agentKeyFor("alice", "t1"));
  assert.notEqual(await agentKeyFor("alice"), await agentKeyFor("bob"));
});

test("the handler mints a browser token for the user's own agent, and each user and thread has its own", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "hi" }));
  const handler = handlerFor(t, r);
  assert.equal((await post(handler, { action: "token" }, { cookie: "" })).status, 401);
  const alice = await post(handler, { action: "token" });
  assert.equal(alice.status, 200, JSON.stringify(alice.json));
  assert.equal(alice.json.url, r.base);
  assert.ok(alice.json.expiresAt > Date.now());
  const again = await post(handler, { action: "token" });
  assert.equal(again.json.agentId, alice.json.agentId, "the same user's agent");
  const thread = await post(handler, { action: "token", thread: "t2" });
  const bob = await post(handler, { action: "token" }, { cookie: "cookie-bob" });
  assert.equal(new Set([alice.json.agentId, thread.json.agentId, bob.json.agentId]).size, 3);
  // The token reads that agent's history and nothing else; the agent acts for its user.
  assert.equal((await r.call(`/v1/agents/${alice.json.agentId}/history`, { token: alice.json.token })).status, 200);
  assert.equal((await r.call(`/v1/agents/${bob.json.agentId}/history`, { token: alice.json.token })).status, 403);
  assert.equal((await r.call(`/v1/agents/${alice.json.agentId}/prompt`, { body: { text: "x" }, token: alice.json.token })).status, 403);
  // The agent is the keyed agent for this user.
  const keyed = await r.call("/v1/agents", { body: { systemPrompt: "You help.", subject: "alice" }, headers: { "Idempotency-Key": await agentKeyFor("alice") } });
  assert.equal(keyed.json.id, alice.json.agentId, keyed.text);
  // A browser's thread is a name, not an agent id.
  assert.equal((await post(handler, { action: "token", thread: 7 })).status, 400);
  assert.equal((await post(handler, { action: "token", thread: "x".repeat(201) })).status, 400);
});

test("a send prompts as the user, is idempotent by its client id, and keeps the client id on the message", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo ${body.messages.length}` }));
  const handler = handlerFor(t, r);
  const { json: { agentId } } = await post(handler, { action: "token" });
  const sent = await post(handler, { action: "send", text: "hello", clientId: "cm_00000001" });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.requestId, "cm_00000001");
  const retried = await post(handler, { action: "send", text: "hello", clientId: "cm_00000001" });
  assert.equal(retried.json.requestId, "cm_00000001");
  await record(r, agentId, "cm_00000001");
  const history = (await r.call(`/v1/agents/${agentId}/history`)).json.messages;
  const users = history.filter((message: any) => message.role === "user");
  assert.equal(users.length, 1, "sent once");
  assert.equal(users[0].requestId, "cm_00000001");
  assert.deepEqual(users[0].from, { id: "alice", name: "Alice" });
  // A client id the runtime would not take, or no text, is refused before it gets there.
  assert.equal((await post(handler, { action: "send", text: "x", clientId: "bad id!" })).status, 400);
  assert.equal((await post(handler, { action: "send", clientId: "cm_00000002" })).status, 400);
  assert.equal((await post(handler, { action: "send", text: "x", clientId: "cm_00000003", whileRunning: "now" })).status, 400);
  // A browser cannot say who it is.
  const forged = await post(handler, { action: "send", text: "hi", clientId: "cm_00000004", from: { id: "bob" }, metadata: { role: "admin" } });
  await record(r, agentId, forged.json.requestId);
  const last = (await r.call(`/v1/agents/${agentId}/history`)).json.messages.filter((message: any) => message.role === "user").at(-1);
  assert.deepEqual(last.from, { id: "alice", name: "Alice" });
  assert.equal(last.metadata, undefined);
});

test("onSend sees the client's data, may rewrite the message or add metadata, and may refuse it", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const seen: unknown[] = [];
  const handler = handlerFor(t, r, {
    onSend: ({ auth, text, data }) => {
      seen.push({ user: auth.userId, text, data });
      if (text === "blocked") throw new Response(JSON.stringify({ error: { code: "quota", message: "Out of messages" } }), { status: 429 });
      return { text: `${text}!`, metadata: { page: String((data as { page?: string })?.page) } };
    },
  });
  const { json: { agentId } } = await post(handler, { action: "token" });
  const sent = await post(handler, { action: "send", text: "hi", clientId: "cm_00000010", data: { page: "/orders" } });
  await record(r, agentId, sent.json.requestId);
  const user = (await r.call(`/v1/agents/${agentId}/history`)).json.messages.find((message: any) => message.role === "user");
  assert.equal(user.content.map?.((part: any) => part.text).join("") ?? user.content, "hi!");
  assert.equal(user.metadata.page, "/orders");
  assert.deepEqual(seen[0], { user: "alice", text: "hi", data: { page: "/orders" } });
  const refused = await post(handler, { action: "send", text: "blocked", clientId: "cm_00000011" });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.error.code, "quota");
});

test("answers go to the user's own agent as the user; another user's input is not theirs to answer", async t => {
  const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };
  const r = await runtime(t, (body, index) => index % 2 === 0 ? toolCall("ask_user", ASK, `call_ask_${index}`)
    : { role: "assistant", content: `Deploying to ${JSON.parse(toolResults(body).at(-1)).answers["Which region?"]}` });
  const definition = (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json.id;
  const handler = handlerFor(t, r, { agent: { definition } });
  const { json: { agentId } } = await post(handler, { action: "token" });
  const sent = await post(handler, { action: "send", text: "Deploy", clientId: "cm_00000020" });
  const suspended = await record(r, agentId, sent.json.requestId);
  const [input] = suspended.outcome.result.inputs;
  // Bob's handler call reaches Bob's agent, where there is no such input.
  const bob = await post(handler, { action: "answer", inputId: input.id, answer: { action: "accept", content: { answers: { "Which region?": "EU" } } } }, { cookie: "cookie-bob" });
  assert.equal(bob.status, 404, JSON.stringify(bob.json));
  assert.equal((await post(handler, { action: "answer", inputId: input.id, answer: { action: "maybe" } })).status, 400);
  const answered = await post(handler, { action: "answer", inputId: input.id, answer: { action: "accept", content: { answers: { "Which region?": "EU" } } } });
  assert.equal(answered.status, 200, JSON.stringify(answered.json));
  assert.equal(answered.json.input.answer.by.from.id, "alice");
  const resumed = await record(r, agentId, answered.json.request.id);
  assert.equal(resumed.outcome.result.reply, "Deploying to EU");
});

test("stop aborts the user's running turn", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "slow", delayMs: 5_000 }));
  const handler = handlerFor(t, r);
  const { json: { agentId } } = await post(handler, { action: "token" });
  const sent = await post(handler, { action: "send", text: "go", clientId: "cm_00000030" });
  await until(async () => (await r.call(`/v1/agents/${agentId}/state`)).json.requests?.some((request: any) => request.id === sent.json.requestId && request.began), "the run to start");
  const stopped = await post(handler, { action: "stop" });
  assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
  const done = await record(r, agentId, sent.json.requestId);
  assert.ok(done.outcome, "the run ended");
});

test("link signs a download of a file in the user's agent's mounts", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const handler = handlerFor(t, r);
  const { json: { agentId } } = await post(handler, { action: "token" });
  const keyed = await r.call("/v1/agents", { body: { systemPrompt: "You help.", subject: "alice" }, headers: { "Idempotency-Key": await agentKeyFor("alice") } });
  assert.equal(keyed.json.id, agentId);
  const put = await fetch(`${r.base}/clients/${agentId}/files/workspace/report.txt`, { method: "PUT", headers: { Authorization: `Bearer ${keyed.json.token}`, "Content-Type": "text/plain" }, body: "the report" });
  assert.ok(put.ok, await put.text());
  const link = await post(handler, { action: "link", path: "/workspace/report.txt" });
  assert.equal(link.status, 200, JSON.stringify(link.json));
  const url = new URL(link.json.url);
  assert.equal(await (await fetch(`${r.base}${url.pathname}`)).text(), "the report");
  assert.equal((await post(handler, { action: "link" })).status, 400);
});

test("the handler refuses what is not a JSON POST from the same site", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const handler = handlerFor(t, r, { allowedOrigins: ["https://partner.example"] });
  const status = async (init: RequestInit) => (await handler(new Request("https://app.example/api/agent", { method: "POST", ...init, headers: { cookie: "cookie-alice", ...init.headers as Record<string, string> } }))).status;
  assert.equal(await status({ method: "GET" }), 405);
  assert.equal(await status({ body: JSON.stringify({ action: "token" }), headers: { "Content-Type": "text/plain" } }), 415, "a form post cannot reach it");
  assert.equal(await status({ body: "{", headers: { "Content-Type": "application/json" } }), 400);
  assert.equal(await status({ body: JSON.stringify({ action: "nope" }), headers: { "Content-Type": "application/json" } }), 400);
  assert.equal(await status({ body: JSON.stringify({ action: "token" }), headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" } }), 403);
  assert.equal(await status({ body: JSON.stringify({ action: "token" }), headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site", Origin: "https://partner.example" } }), 200);
  assert.equal(await status({ body: JSON.stringify({ action: "token" }), headers: { "Content-Type": "application/json; charset=utf-8", "Sec-Fetch-Site": "same-origin" } }), 200);
});

test("an agent's own tools run in the handler's process, for the user it acts for", async t => {
  const r = await runtime(t, (body, index) => index % 2 === 0 ? toolCall("whoami", {}, `call_who_${index}`) : { role: "assistant", content: `You are ${toolResults(body).at(-1)}` });
  const seen: unknown[] = [];
  const handler = handlerFor(t, r, {
    agent: auth => ({
      instructions: `You help ${auth.name}.`,
      tools: { whoami: tool({ description: "Who the user is", input: schema.Object({}), execute: (_args, { identity }) => { seen.push(identity?.subject); return auth.userId; } }) },
    }),
  });
  const { json: { agentId } } = await post(handler, { action: "token" });
  const sent = await post(handler, { action: "send", text: "who am I?", clientId: "cm_00000040" });
  const done = await record(r, agentId, sent.json.requestId);
  assert.equal(done.outcome.result.reply, 'You are "alice"');
  assert.deepEqual(seen, ["alice"]);
  await handler.close();
});

test("an agent several users share (authorize names its key) takes each user's messages as theirs", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const team: Partial<AgentHandlerOptions> = {
    authorize: request => {
      const user = USERS[request.headers.get("cookie") ?? ""];
      return user ? { userId: user.id, name: user.name, agentKey: "team-acme" } : null;
    },
  };
  const handler = handlerFor(t, r, team);
  // Bob comes through another process, which has not seen the agent: it upserts it again.
  const elsewhere = handlerFor(t, r, team);
  const alice = await post(handler, { action: "token" });
  const bob = await post(elsewhere, { action: "token" }, { cookie: "cookie-bob" });
  assert.equal(bob.status, 200, JSON.stringify(bob.json));
  assert.equal(alice.json.agentId, bob.json.agentId, "one agent");
  const first = await post(handler, { action: "send", text: "from alice", clientId: "cm_team_0001" });
  await record(r, alice.json.agentId, first.json.requestId);
  const second = await post(elsewhere, { action: "send", text: "from bob", clientId: "cm_team_0002" }, { cookie: "cookie-bob" });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  await record(r, alice.json.agentId, second.json.requestId);
  const senders = (await r.call(`/v1/agents/${alice.json.agentId}/history`)).json.messages.filter((message: any) => message.role === "user").map((message: any) => message.from.id);
  assert.deepEqual(senders, ["alice", "bob"]);
  // Its subject is the team's, whoever opened it first.
  const keyed = await r.call("/v1/agents", { body: { systemPrompt: "You help.", subject: "team-acme" }, headers: { "Idempotency-Key": "team-acme" } });
  assert.equal(keyed.status, 201, keyed.text);
});
