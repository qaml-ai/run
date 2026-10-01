import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fromMcpServer } from "../clients/mcp.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentClient, AgentRuntime, tool, schema } from "../clients/node.ts";
import { attach, until, watchEvents } from "./runtime-server.ts";
import { token, sleep, fixture, echo } from "./client-fixture.ts";

test("SDK provisions scoped SSE sessions, infers tools, and controls lifecycle without raw HTTP", async t => {
  const f = await fixture(t);
  const a = await f.start({ echo: echo(() => "A") });
  const b = await f.start({ echo: echo(() => "B") });
  // Separate processes unless agents are hosted inline.
  if (f.supervisor.hosting === "process") assert.notEqual((await a.status()).pid, (await b.status()).pid);
  const result = await Promise.all([a, b].map(agent => agent.execute('return await tools.echo({value:"hi"})')));
  assert.deepEqual(result.map(result => result.output), [["A"], ["B"]]);
  const headers = { Authorization: `Bearer ${b.session.token}` };
  assert.equal((await fetch(`${f.url}/clients/${a.session.id}/state`, { headers })).status, 401);
  assert.equal((await fetch(`${f.url}/clients/${a.session.id}/events?token=${a.session.token}`)).status, 401);
  assert.equal((await fetch(`${f.url}/clients/${a.session.id}/state`, { headers: { Authorization: `Bearer ${a.session.token}`, Origin: "https://evil.example" } })).status, 401);
  await assert.rejects(a.execute("return process.env"), /process/);
  await assert.rejects(a.request("execute", { code: "return 1", runtime: "/bin/sh" }), /Unknown codemode option/);
  await a.destroy();
  assert.equal((await fetch(`${f.url}/clients/${a.session.id}/state`, { headers: { Authorization: `Bearer ${a.session.token}` } })).status, 410);
  assert.equal((await b.status()).busy, false);
});

test("an application's tools are an attached MCP server: code gets their data, and any MCP SDK server can be attached", async t => {
  const f = await fixture(t);
  const failing = tool({ description: "Always fails", input: schema.Object({}), execute: () => { throw new Error("no stock data"); } });
  const own = await f.start({ echo: echo(({ value }) => [value, value.length]), failing });
  assert.deepEqual((await own.execute('return await tools.echo({value:"hi"})')).output, ['["hi",2]'], "a JSON result reaches code as data");
  await assert.rejects(own.execute("return await tools.failing({})"), /no stock data/, "a tool's failure is an MCP error result, thrown in code");

  // A server written with the MCP SDK, attached as is; the runtime's call IDs reach it as _meta.
  const seen: unknown[] = [];
  const server = new McpServer({ name: "shop", version: "1.0.0" });
  server.registerTool("price", { description: "Price of a SKU", inputSchema: { sku: z.string() } }, async ({ sku }, extra) => {
    seen.push(extra._meta?.["agent-runtime/callId"]);
    return { content: [{ type: "text", text: `${sku} costs 3` }], structuredContent: { sku, cents: 300 } };
  });
  server.registerTool("stock.level", { description: "A name MCP allows and tools do not" }, async () => ({ content: [{ type: "text", text: "12" }] }));
  const attached = await fromMcpServer(server);
  t.after(() => attached.close());
  const agent = await f.start(undefined, { mcp: attached });
  assert.deepEqual((await f.header(agent.session.id)).definitions.map((tool: any) => tool.name).sort(), ["price", "stock_level"]);
  assert.deepEqual(JSON.parse((await agent.execute('return [await tools.price({sku:"BEAN-01"}), await tools.stock_level({})]')).output[0]), [{ sku: "BEAN-01", cents: 300 }, 12]);
  assert.equal(seen.length, 1);
  assert.match(String(seen[0]), /^[0-9a-f-]{36}$/);
});

test("parallel calls correlate reversed replies and schemas reject invalid arguments", async t => {
  const f = await fixture(t);
  const invoked: string[] = [];
  // The first call finishes only after the second has: its reply comes back last.
  const secondDone = Promise.withResolvers<void>();
  const agent = await f.start({ echo: echo(async ({ value }) => {
    if (value === "first") await secondDone.promise;
    invoked.push(value);
    if (value === "second") secondDone.resolve();
    return value;
  }) });
  const result = await agent.execute('return await Promise.all([tools.echo({value:"first"}),tools.echo({value:"second"})])');
  assert.deepEqual(JSON.parse(result.output[0]), ["first", "second"]);
  assert.deepEqual(invoked, ["second", "first"]);
  await assert.rejects(agent.execute('return await tools.echo({value: 1})'), /Invalid arguments/);
  assert.equal(invoked.length, 2);
});

test("lost request/result POST acknowledgements retry recorded outcomes, not executions", async t => {
  const f = await fixture(t);
  let writes = 0, lostRequest = false, lostResult = false;
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const path = String(input);
    if ((!lostRequest && path.endsWith("/requests")) || (!lostResult && path.endsWith("/mcp") && String(init?.body).includes('"result"') && String(init?.body).includes("saved"))) {
      if (path.endsWith("/requests")) lostRequest = true; else lostResult = true;
      await response.text();
      throw new TypeError("Simulated acknowledgement lost after server commit");
    }
    return response;
  };
  const agent = await f.start({ echo: echo(() => { writes++; return { saved: true }; }) }, {}, { fetch: transport });
  const result = await agent.execute('return await tools.echo({value:"write"})', { idempotencyKey: "stable-request" });
  assert.deepEqual(JSON.parse(result.output[0]), { saved: true });
  const repeated = await agent.execute('return await tools.echo({value:"write"})', { idempotencyKey: "stable-request" });
  assert.deepEqual(repeated, result);
  assert.equal(writes, 1);
  assert.equal(lostRequest, true); assert.equal(lostResult, true);
  await assert.rejects(agent.execute("return 999", { idempotencyKey: "stable-request" }), /different arguments/);
});

test("a dropped connection ends the tool calls on it as unknown, never running them again; the client reconnects", async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const events: any[] = [];
  const agent = await f.start({ echo: echo(async () => { writes++; entered.resolve(); await release.promise; return "saved"; }) }, { onEvent: event => events.push(event) });
  const pid = (await agent.status()).pid;
  const running = agent.execute('text("before"); return await tools.echo({value:"write"})');
  await entered.promise;
  f.sessions.sessions.get(agent.session.id)!.response!.destroy();
  await assert.rejects(running, /may or may not have taken effect/);
  release.resolve();
  await sleep(200);
  assert.equal(writes, 1, "the call was not sent again");
  assert.equal((await agent.status()).pid, pid);
  assert.ok(events.length >= 1);
  // Another process takes the agent over once this one has gone.
  await agent.close();
  const again = Promise.withResolvers<void>();
  const next = await new AgentRuntime(f.runtimeOptions).connectAgent(agent.session, { tools: { echo: echo(() => { again.resolve(); return "later"; }) } });
  f.clients.push(next);
  assert.deepEqual((await next.execute('return await tools.echo({value:"x"})')).output, ["later"]);
});

test("a run stays in flight until its outcome is durable and published, so a drain never closes the stream first", async t => {
  const f = await fixture(t);
  const release = Promise.withResolvers<void>();
  const agent = await f.start({ echo: echo(async () => { await release.promise; return "done"; }) });
  const running = agent.execute('return await tools.echo({value:"x"})', { timeoutMs: 20_000 });
  let session;
  for (let i = 0; !(session = f.sessions.sessions.get(agent.session.id))?.inflight; i++) { assert.ok(i < 500, "the tool call was sent"); await sleep(10); }
  // Hold the durable flush that records the run as completed, as a slow database would.
  const flushing = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const flush = session.log.flush.bind(session.log);
  session.log.flush = async durable => {
    if (durable && [...session.requests.values()].some(request => request.state === "completed")) { flushing.resolve(); await proceed.promise; }
    return flush(durable);
  };
  release.resolve();
  await flushing.promise;
  const inFlight = f.sessions.inFlight();
  // What SIGTERM does: wait until nothing is in flight, then close every stream.
  const drained = (async () => {
    while (f.sessions.inFlight()) await sleep(10);
    const published = session.events.some(event => event.data.type === "response");
    await f.sessions.close();
    return published;
  })();
  await sleep(100);
  proceed.resolve();
  assert.equal(inFlight, 1, "a completed run whose outcome is not yet durable is still in flight");
  assert.equal(await drained, true, "the response was published before the drain closed the stream");
  assert.deepEqual((await running).output, ["done"]);
});

test("a call goes to one connection: another client is refused while it serves, and one that takes over never runs it: the first one still answers it", async t => {
  const f = await fixture(t, { timeout: 5000 });
  let executions = 0;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const tools = { echo: echo(async ({ value }) => { executions++; entered.resolve(); await gate.promise; return value; }) };
  const first = await f.start(tools);
  const running = first.execute('return await tools.echo({value:"once"})');
  await entered.promise;
  // A second process (a new container, say) is refused while the first serves the agent's tools...
  const refused = await attach(t, f.url, first.session.id, first.session.token);
  assert.equal(refused.status, 409);
  assert.match(refused.body, /APPLICATION_CONNECTED/);
  // ...and one that takes over gets calls from then on, never the one in flight: the first still answers that one.
  const second = await attach(t, f.url, first.session.id, first.session.token, () => { executions++; }, "?takeover=true");
  assert.equal(second.status, 200);
  gate.resolve();
  assert.deepEqual((await running).output, ["once"]);
  await sleep(300);
  assert.equal(executions, 1, "the call went to the first client only");
});

test("watchers each get the whole stream beside the application's connection, never evicting it or each other, and resume from their own cursors", async t => {
  const f = await fixture(t, { maxWatchers: 2 });
  let executions = 0;
  const agent = await f.start({ echo: echo(({ value }) => { executions++; return value; }) });
  const events = `${f.url}/clients/${agent.session.id}/events`;
  const auth = { Authorization: `Bearer ${agent.session.token}` };
  const first = await watchEvents(t, events, auth);
  const second = await watchEvents(t, events, auth);
  assert.equal(first.status, 200);
  assert.deepEqual((await until(() => second.frames[0], "the ready frame")).data, { version: 5, agentId: agent.session.id, watch: true });
  // The application's connection still answers tool calls: no watcher replaced it.
  assert.deepEqual((await agent.execute('return await tools.echo({value:"seen"})', { idempotencyKey: "one" })).output, ["seen"]);
  assert.equal(executions, 1);
  const settled = (watcher: typeof first, id: string) => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === id);
  await until(() => settled(first, "one") && settled(second, "one"), "both watchers to see the outcome");
  const ids = (watcher: typeof first) => watcher.frames.filter(frame => frame.id).map(frame => frame.id);
  assert.deepEqual(ids(first), ids(second), "every watcher gets every event, in order");
  assert.ok(ids(first).length > 1);
  assert.equal((await watchEvents(t, events, auth)).status, 429, "subscribers are bounded per agent");

  // A watcher that reconnects resumes from its own cursor; the other keeps streaming meanwhile.
  first.close();
  const middle = ids(second)[0]!;
  const resumed = await watchEvents(t, events, auth, { cursor: middle });
  await agent.execute('return await tools.echo({value:"again"})', { idempotencyKey: "two" });
  await until(() => settled(resumed, "two") && settled(second, "two"), "the resumed watcher to see the next outcome");
  assert.deepEqual(ids(resumed), ids(second).filter(id => id! > middle));

  // A poll answers with the events after its cursor and where to poll from next, or waits for the next one.
  const last = ids(second).at(-1)!;
  const poll = (cursor: number, query = "") => fetch(`${events}?poll=1${query}`, { headers: { ...auth, "Last-Event-ID": String(cursor) } }).then(async response => ({ status: response.status, json: await response.json() as any }));
  assert.deepEqual((await poll(last)).json, { cursor: last, events: [] });
  assert.equal((await poll(middle)).json.events.length, ids(second).filter(id => id! > middle).length);
  // A waiting poll takes a subscriber's place: the resumed watcher gives its up.
  resumed.close();
  await sleep(100);
  const waiting = poll(last, "&wait=10");
  await sleep(100);
  await agent.execute("return 3", { idempotencyKey: "three" });
  const woken = await waiting;
  assert.ok(woken.json.events.length > 0 && woken.json.events[0].id === last + 1, "a waiting poll answers with the next event");
  assert.equal(woken.json.cursor, woken.json.events.at(-1).id);
  assert.equal((await poll(1, "&snapshot=0")).status, 409, "a cursor behind the buffer is a replay gap, for one that asks for no snapshot");
  assert.equal((await watchEvents(t, events, auth, { cursor: 1, query: "watch=1&snapshot=0" })).status, 409);
  assert.equal((await poll(1)).json.events[0].data.type, "snapshot", "by default, a snapshot");
  assert.equal(executions, 2);
});

test("waiting polls count as subscribers, and subscribers are bounded per node and per tenant as well as per agent", async t => {
  const f = await fixture(t, { maxWatchers: 2, maxTenantWatchers: 3 });
  const [a, b] = [await f.start(), await f.start()];
  const events = (agent: AgentClient) => `${f.url}/clients/${agent.session.id}/events`;
  const auth = (agent: AgentClient) => ({ Authorization: `Bearer ${agent.session.token}` });
  const cursor = async (agent: AgentClient) => String((await (await fetch(`${f.url}/clients/${agent.session.id}/state`, { headers: auth(agent) })).json() as any).cursor);
  const aborts = new AbortController();
  t.after(() => aborts.abort());
  const waiting = (agent: AgentClient) => { void fetch(`${events(agent)}?poll=1&wait=20`, { headers: { ...auth(agent), "Last-Event-ID": lastA }, signal: aborts.signal }).catch(() => {}); };
  const lastA = await cursor(a);
  waiting(a); waiting(a);
  await sleep(200);
  assert.equal((await watchEvents(t, events(a), auth(a))).status, 429, "two polls waiting fill the agent's subscribers");
  assert.equal((await fetch(`${events(a)}?poll=1&wait=20`, { headers: { ...auth(a), "Last-Event-ID": lastA } })).status, 429);
  assert.equal((await fetch(`${events(a)}?poll=1`, { headers: { ...auth(a), "Last-Event-ID": lastA } })).status, 200, "a poll that does not wait holds nothing");
  assert.equal((await watchEvents(t, events(b), auth(b))).status, 200);
  assert.equal((await watchEvents(t, events(b), auth(b))).status, 429, "the tenant has 3");
  aborts.abort();
  await until(async () => (await watchEvents(t, events(b), auth(b))).status === 200, "the polls' places to free up");

  const node = await fixture(t, { maxNodeWatchers: 1 });
  const c = await node.start();
  assert.equal((await watchEvents(t, `${node.url}/clients/${c.session.id}/events`, { Authorization: `Bearer ${c.session.token}` })).status, 200);
  assert.equal((await watchEvents(t, `${node.url}/clients/${c.session.id}/events`, { Authorization: `Bearer ${c.session.token}` })).status, 429, "the node has 1");
});

test("a watcher refused for capacity leaves nothing behind for its idle agent", async t => {
  const f = await fixture(t, { idleMs: 1000, maxNodeWatchers: 1 });
  const [a, b] = [await f.start(), await f.start()];
  await Promise.all([a.close(), b.close()]);
  await until(() => !f.sessions.sessions.has(a.session.id) && !f.sessions.sessions.has(b.session.id), "both idle sessions to unload", 10_000);
  const watch = (agent: AgentClient) => watchEvents(t, `${f.url}/clients/${agent.session.id}/events`, { Authorization: `Bearer ${agent.session.token}` });
  assert.equal((await watch(a)).status, 200);
  assert.equal((await watch(b)).status, 429);
  assert.equal((f.sessions as any).idle.has(b.session.id), false, "no empty idle entry is left");
});

test("an idle agent's watchers stay without its session and resume across its unload and reload without a gap", async t => {
  const f = await fixture(t, { idleMs: 1000 });
  const agent = await f.start();
  const id = agent.session.id;
  await agent.execute("return 1");
  await agent.close();
  const events = `${f.url}/clients/${id}/events`;
  const auth = { Authorization: `Bearer ${agent.session.token}` };
  const watcher = await watchEvents(t, events, auth);
  await until(() => !f.sessions.sessions.has(id), "the idle session to unload", 10_000);
  await sleep(300);
  assert.equal(watcher.ended, false, "its watcher stays, and the session goes");
  const last = watcher.frames.filter(frame => frame.id).at(-1)!.id!;

  // Watchers and polls of the unloaded agent load nothing, and are caught up at the cursor it stopped at.
  const again = await watchEvents(t, events, auth, { cursor: last });
  assert.equal(again.status, 200);
  const poll = (cursor: number, query = "") => fetch(`${events}?poll=1${query}`, { headers: { ...auth, "Last-Event-ID": String(cursor) } }).then(async response => ({ status: response.status, json: await response.json() as any }));
  for (let index = 0; index < 5; index++) assert.deepEqual((await poll(last)).json, { cursor: last, events: [] });
  assert.equal((await poll(last - 1)).status, 409, "a cursor behind it missed events");
  assert.equal((await poll(last - 1, "&snapshot=1")).json.events[0].data.turn, null);
  assert.equal(f.sessions.sessions.has(id), false, "nothing loaded it");
  const waiting = poll(last, "&wait=10");
  // Waiting, idle, before the run below loads the agent (else it would be a poll of the loaded agent).
  await until(() => (f.sessions as any).idle.get(id)?.polls.size === 1, "the poll to wait, idle");

  // The next run loads it: the idle watchers go on from the same cursor, and the waiting poll answers.
  const connected = await new AgentRuntime(f.runtimeOptions).connectAgent(agent.session, { tools: {} });
  f.clients.push(connected);
  await connected.execute("return 2", { idempotencyKey: "next" });
  const settled = (frames: typeof watcher.frames) => frames.some(frame => frame.data.type === "response" && frame.data.id === "next");
  await until(() => settled(watcher.frames) && settled(again.frames), "both idle watchers to see the next run");
  assert.equal(watcher.frames.filter(frame => frame.id && frame.id > last)[0].id, last + 1, "no gap");
  assert.deepEqual((await waiting).json.events, []);
  assert.ok((await poll(last)).json.events.some((event: any) => event.data.type === "response" && event.data.id === "next"), "a poll at the old cursor replays the reloaded session's events");
});

test("history answers while the agent is starting, whole or in pages", async t => {
  const f = await fixture(t, { idleMs: 1000 });
  const agent = await f.start();
  await agent.execute("return 1");
  await until(() => !f.supervisor.agents.has(agent.session.id), "the idle agent to stop", 10_000);
  const headers = { Authorization: `Bearer ${agent.session.token}` };
  const statuses: string[] = [];
  // A run starts the agent; history is read meanwhile, as a client recovering from a replay gap does.
  const run = agent.execute("return 2", { idempotencyKey: "starts-it" });
  let done = false;
  void run.finally(() => { done = true; });
  while (!done) {
    for (const path of ["/history", "/history?limit=5"]) {
      const response = await fetch(`${f.url}/clients/${agent.session.id}${path}`, { headers });
      if (response.status !== 200) statuses.push(`${path}: ${response.status} ${await response.text()}`);
      else await response.body?.cancel();
    }
  }
  await run;
  assert.deepEqual(statuses, []);
});
