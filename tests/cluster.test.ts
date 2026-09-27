import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, memoryJournalStore, schema, tool } from "../clients/typescript.ts";
import { testDatabase } from "./database.ts";
import { watchEvents } from "./runtime-server.ts";
import { balancer, cluster, fakeEcs, fakeModel, freePort, jsExec, lookup, sha, sleep, token, toolMessages, until } from "./cluster-helpers.ts";

test("a node with single-host file storage refuses to start beside another node on the same database", { timeout: 60_000 }, async t => {
  const c = await cluster(t);
  await c.start("a");
  await assert.rejects(c.start("b", { AGENT_STORAGE: "file" }), /node b exited: 1/);
});

test("any node serves any agent: requests are forwarded to the owner, and a survivor takes over when it dies", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const calls: string[] = [];

  // Created through A, so A owns it.
  const viaA = await new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() }).createAgent({ tools: lookup(calls), idempotencyKey: "shared-agent" });
  assert.equal((await viaA.execute('return await tools.lookup({ key: "one" })')).output[0], "value-of-one");
  await viaA.close();

  // A client attached to B reaches the same agent: its requests and SSE stream are forwarded to A.
  const viaB = await new AgentRuntime({ url: b.url, apiKey: token, journalStore: memoryJournalStore() }).connectAgent(viaA.session, { tools: lookup(calls) });
  t.after(() => viaB.close());
  assert.equal((await viaB.execute('return await tools.lookup({ key: "two" })')).output[0], "value-of-two");
  const state = async () => (await (await fetch(`${b.url}/clients/${viaA.session.id}/state`, { headers: { Authorization: `Bearer ${viaA.session.token}` } })).json()) as any;
  assert.equal((await state()).requests.length, 2, "both requests are in the one journal A keeps");
  assert.deepEqual(calls, ["one", "two"]);

  // A wake-up scheduled through B is delivered to the agent on A, by whichever node claims it.
  const schedule = await viaB.schedule({ code: 'return await tools.lookup({ key: "timer" })', inSeconds: 0 });
  const wakeId = `schedule-${schedule.id}-${schedule.dueAt}`;
  for (let tries = 0; !(await state()).requests.some((request: any) => request.id === wakeId); tries++) {
    assert.ok(tries < 100, "the wake-up was delivered");
    await sleep(100);
  }
  const woken = await viaB.waitForRequest(wakeId, { timeoutMs: 20_000 });
  assert.equal(woken.output[0], "value-of-timer");
  assert.deepEqual(await viaB.schedules(), []);
  calls.splice(calls.indexOf("timer"), 1);

  // Re-provisioning through B returns the same agent without starting a second copy.
  const again = await fetch(`${b.url}/client-sessions`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "shared-agent" },
    body: JSON.stringify({ mcp: { tools: [{ name: "lookup", description: "Look up a value", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false } }] } }),
  });
  assert.equal(again.status, 201, await again.clone().text());
  assert.equal((await again.json() as any).id, viaA.session.id);

  // A dies without releasing anything, its latest journal and transcript records still only in the tail.
  // Once its heartbeat expires, B serves the agent from storage and the tail.
  assert.ok((await c.db.query("select count(*) as count from log_records where actor = $1", [viaA.session.id])).rows[0].count > 0);
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  await sleep(1500 + 500);
  const result = await viaB.execute('return await tools.lookup({ key: "three" })', { timeoutMs: 20_000 });
  assert.equal(result.output[0], "value-of-three");
  assert.ok((await state()).requests.length >= 4, "the journal A wrote is intact under B");
  assert.deepEqual(calls, ["one", "two", "three"]);
  const agents = await (await fetch(`${b.url}/v1/agents`, { headers: { Authorization: `Bearer ${token}` } })).json() as any[];
  assert.deepEqual(agents.map(agent => agent.id), [viaA.session.id]);
});

test("watchers on any node share the owner's stream: each gets every event, beside the application's connection", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const calls: string[] = [];
  const agent = await new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() }).createAgent({ tools: lookup(calls) });
  t.after(() => agent.close());
  const auth = { Authorization: `Bearer ${agent.session.token}` };
  const onA = await watchEvents(t, `${a.url}/clients/${agent.session.id}/events`, auth);
  // B does not own the agent: its watcher is forwarded to A.
  const onB = await watchEvents(t, `${b.url}/clients/${agent.session.id}/events`, auth);
  assert.equal(onB.status, 200);
  assert.equal((await agent.execute('return await tools.lookup({ key: "k" })', { idempotencyKey: "run" })).output[0], "value-of-k");
  const settled = (watcher: typeof onA) => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === "run");
  await until(() => settled(onA) && settled(onB), "both watchers to see the outcome");
  const ids = (watcher: typeof onA) => watcher.frames.filter(frame => frame.id).map(frame => frame.id);
  assert.deepEqual(ids(onA), ids(onB));
  assert.equal(await c.owner(agent.session.id), a.url);
  assert.deepEqual(calls, ["k"]);
});

test("a volume is served by one node: other nodes forward to it, agents anywhere reach it, and a survivor takes over", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const viaA = new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() });
  const viaB = new AgentRuntime({ url: b.url, apiKey: token, journalStore: memoryJournalStore() });
  const { id } = await viaA.createVolume({ name: "shared" });
  const first = await viaA.volume(id).write("plan.md", "draft");
  assert.equal(await c.owner(id), a.url, "the node that first served the volume owns it");

  // Through B, reads and conditional writes are forwarded to A.
  assert.equal(await viaB.volume(id).readText("plan.md"), "draft");
  await assert.rejects(viaB.volume(id).write("plan.md", "stale", { version: first.version + 1 }), (error: any) => error.status === 412);
  assert.equal(await c.owner(id), a.url);

  // An agent served by B mounts the volume; its file tools reach the owner on A.
  const agent = await viaB.createAgent({ tools: {}, idempotencyKey: "volume-agent", mounts: [{ volumeId: id, path: "/shared", mode: "rw" }] });
  t.after(() => agent.close());
  const edited = JSON.parse((await agent.execute(`
    const read = await tools.read({ path: "/shared/plan.md" });
    return await tools.edit({ path: "/shared/plan.md", old: "draft", new: "final", version: read.version });`)).output[0]);
  assert.equal(edited.version, first.version + 1);
  assert.equal(await viaA.volume(id).readText("plan.md"), "final");
  assert.equal(await c.owner(id), a.url, "the volume did not move to the agent's node");
  await assert.rejects(agent.execute(`return await tools.edit({ path: "/shared/plan.md", old: "final", new: "x", version: ${first.version} })`), /changed since you read it/);

  // A dies owning the volume. Once its heartbeat expires, B serves it from storage.
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  await sleep(1500 + 500);
  assert.equal(await viaB.volume(id).readText("plan.md"), "final");
  assert.equal(await c.owner(id), b.url);
  assert.equal(JSON.parse((await agent.execute('return await tools.read({ path: "/shared/plan.md" })', { timeoutMs: 20_000 })).output[0]).version, edited.version);
  await agent.execute('await tools.write({ path: "/shared/after.md", content: "written after takeover" })');
  assert.deepEqual((await viaB.volume(id).list()).files.map(file => file.path), ["/after.md", "/plan.md"]);
});

test("a draining node finishes the turn in flight, leaves queued runs for the next owner, releases, and exits 0", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const tools = {
    slow: tool({ description: "Wait for the test", input: schema.Object({}, { additionalProperties: false }), execute: async () => { entered.resolve(); await gate.promise; return "slow-done"; } }),
  };
  const created = await new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() }).createAgent({ tools, idempotencyKey: "draining-agent" });
  await created.close();
  assert.equal(await c.owner(created.session.id), a.url);

  // The client reaches A through B, as it would through the load balancer.
  const client = await new AgentRuntime({ url: b.url, apiKey: token, journalStore: memoryJournalStore() }).connectAgent(created.session, { tools });
  t.after(() => client.close());
  const first = client.execute("return await tools.slow({})", { timeoutMs: 60_000 });
  await entered.promise;

  const exited = once(a.child, "exit");
  a.child.kill("SIGTERM");
  for (let tries = 0; (await fetch(`${a.url}/healthz`)).status !== 503; tries++) { assert.ok(tries < 50, "/healthz fails while draining"); await sleep(50); }
  assert.ok(a.logs.some(entry => entry.type === "drain_started"));
  // Accepted by A while it drains, but never begun there.
  const second = client.execute('return "after the move"', { timeoutMs: 60_000 });
  await sleep(500);
  assert.equal(await c.owner(created.session.id), a.url, "A holds the agent while its turn runs");
  const pending = await (await fetch(`${b.url}/clients/${created.session.id}/state`, { headers: { Authorization: `Bearer ${created.session.token}` } })).json() as any;
  assert.deepEqual(pending.requests.map((request: any) => [request.state, !!request.began]), [["running", true], ["running", false]]);

  gate.resolve();
  assert.equal((await first).output[0], "slow-done", "the turn in flight finished on A");
  const [code] = await exited;
  assert.equal(code, 0);
  const finished = a.logs.find(entry => entry.type === "drain_finished");
  assert.equal(finished?.unfinished, 0);
  assert.equal((await c.db.query("select count(*) as count from runtime_nodes where node = $1", [a.url])).rows[0].count, 0, "A deleted its heartbeat");

  // The client's stream closed after the release; it reconnected through B, which now serves the agent and runs the queued request.
  assert.equal((await second).output[0], "after the move");
  assert.equal(await c.owner(created.session.id), b.url);
  const state = await (await fetch(`${b.url}/clients/${created.session.id}/state`, { headers: { Authorization: `Bearer ${created.session.token}` } })).json() as any;
  assert.ok(state.requests.every((request: any) => request.state === "completed" && !request.outcome.error), JSON.stringify(state.requests));
});

test("a draining node sends requests for actors it does not hold to a live peer", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const tools = { slow: tool({ description: "Wait", input: schema.Object({}, { additionalProperties: false }), execute: async () => { entered.resolve(); await gate.promise; return "ok"; } }) };
  const viaA = new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() });
  const busy = await viaA.createAgent({ tools, idempotencyKey: "keeps-a-draining" });
  t.after(() => busy.close());
  const running = busy.execute("return await tools.slow({})", { timeoutMs: 60_000 });
  await entered.promise;
  a.child.kill("SIGTERM");
  for (let tries = 0; (await fetch(`${a.url}/healthz`)).status !== 503; tries++) { assert.ok(tries < 50); await sleep(50); }

  // A new agent and a new volume asked of A while it drains are made on B.
  const agent = await viaA.createAgent({ tools: {}, idempotencyKey: "made-during-drain" });
  await agent.close();
  assert.equal(await c.owner(agent.session.id), b.url);
  const { id } = await viaA.createVolume({ name: "during-drain" });
  await viaA.volume(id).write("a.txt", "x");
  assert.equal(await c.owner(id), b.url);
  gate.resolve();
  await running;
  assert.equal((await once(a.child, "exit"))[0], 0);
});

test("a stale owner cache entry heals: a request to a dead owner drops it, and the next is served by a live node", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  // A long lease, so only the cache (not heartbeat expiry) can send B to the dead node.
  const a = await c.start("a", { AGENT_LEASE_TTL_MS: "60000" });
  const b = await c.start("b", { AGENT_LEASE_TTL_MS: "60000" });
  const created = await new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() }).createAgent({ tools: {}, idempotencyKey: "cached-agent" });
  await created.close();
  const state = () => fetch(`${b.url}/clients/${created.session.id}/state`, { headers: { Authorization: `Bearer ${created.session.token}` } });
  assert.equal((await state()).status, 200, "served by A through B, which now caches A as the owner");

  a.child.kill("SIGKILL");
  await once(a.child, "close");
  // A's heartbeat lapses; the database no longer names it, but B's cache entry is still fresh.
  await c.db.query("update runtime_nodes set expires_at = now() - interval '1 second' where node = $1", [a.url]);
  assert.equal((await state()).status, 502, "the cached owner was unreachable");
  const healed = await state();
  assert.equal(healed.status, 200, await healed.clone().text());
  assert.equal(await c.owner(created.session.id), b.url);
});

test("with no live peer, a draining node answers 503 with Retry-After for anything it would have to take", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a", { AGENT_IDLE_MS: "1000" });
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const tools = { slow: tool({ description: "Wait", input: schema.Object({}, { additionalProperties: false }), execute: async () => { entered.resolve(); await gate.promise; return "ok"; } }) };
  const runtime = new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() });
  const idle = await runtime.createAgent({ tools: {}, idempotencyKey: "released-early" });
  await idle.close();
  const busy = await runtime.createAgent({ tools, idempotencyKey: "keeps-a-draining" });
  t.after(() => busy.close());
  const running = busy.execute("return await tools.slow({})", { timeoutMs: 60_000 });
  await entered.promise;
  // The idle agent unloads, so A no longer holds it.
  for (let tries = 0; await c.owner(idle.session.id); tries++) { assert.ok(tries < 100, "the idle agent was released"); await sleep(100); }
  a.child.kill("SIGTERM");
  for (let tries = 0; (await fetch(`${a.url}/healthz`)).status !== 503; tries++) { assert.ok(tries < 50); await sleep(50); }

  const created = await fetch(`${a.url}/client-sessions`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "during-drain" }, body: "{}" });
  assert.equal(created.status, 503, await created.clone().text());
  assert.equal(created.headers.get("retry-after"), "1");
  const loaded = await fetch(`${a.url}/clients/${idle.session.id}/state`, { headers: { Authorization: `Bearer ${idle.session.token}` } });
  assert.equal(loaded.status, 503);
  assert.equal(loaded.headers.get("retry-after"), "1");
  gate.resolve();
  assert.equal((await running).output[0], "ok");
  assert.equal((await once(a.child, "exit"))[0], 0);
});

test("a turn whose node died between model steps resumes on the next owner, calling the model once more", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? jsExec('return await tools.lookup({ key: "k" })') : index === 1 ? undefined : { role: "assistant", content: "all done" });
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const calls: string[] = [];
  const created = await new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() }).createAgent({ tools: lookup(calls), idempotencyKey: "resumed-agent" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token, journalStore: memoryJournalStore() }).connectAgent(created.session, { tools: lookup(calls) });
  t.after(() => client.close());
  const run = client.prompt("go", { idempotencyKey: "turn-1", timeoutMs: 60_000 });

  await until(() => model.bodies.length === 2, "A made the second model call");
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const result = await run;
  assert.equal(result.reply, "all done");
  assert.equal(result.error, null);

  const observer = await new AgentRuntime({ url: b.url, apiKey: token, journalStore: memoryJournalStore() }).connectAgent(created.session, { tools: lookup([]) });
  t.after(() => observer.close());
  assert.equal((await observer.waitForRequest("turn-1", { timeoutMs: 10_000 })).reply, "all done");
  assert.equal(model.bodies.length, 3, "one more model call, not a new turn");
  const resumed = model.bodies[2];
  assert.equal(resumed.messages.filter((message: any) => message.role === "user").length, 1, "the prompt was not submitted again");
  assert.ok(toolMessages(resumed).some((content: string) => content.includes("value-of-k")), "the finished step's tool result carried over");
  assert.deepEqual(calls, ["k"]);
  assert.equal(await c.owner(created.session.id), b.url);
  const state = await (await fetch(`${b.url}/clients/${created.session.id}/state`, { headers: { Authorization: `Bearer ${created.session.token}` } })).json() as any;
  assert.equal(state.requests.find((request: any) => request.id === "turn-1").resumes, 1);
});

test("a turn whose node died during a tool call continues with the outcome unknown, without calling the tool again", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? jsExec("return await tools.slow({})") : { role: "assistant", content: "noted the unknown outcome" });
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  let executions = 0;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const tools = { slow: tool({ description: "A side effect", input: schema.Object({}, { additionalProperties: false }), execute: async () => { executions++; entered.resolve(); await gate.promise; return "effect-done"; } }) };
  const created = await new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() }).createAgent({ tools, idempotencyKey: "tool-in-flight" });
  await created.close();
  const client = await new AgentRuntime({ url: b.url, apiKey: token, journalStore: memoryJournalStore() }).connectAgent(created.session, { tools });
  t.after(() => client.close());
  const run = client.prompt("do it", { idempotencyKey: "turn-2", timeoutMs: 60_000 });

  await entered.promise;
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const result = await run;
  assert.equal(result.reply, "noted the unknown outcome");
  assert.equal(executions, 1, "the call was never sent again");
  assert.equal(model.bodies.length, 2);
  assert.ok(toolMessages(model.bodies[1]).some((content: string) => /outcome is unknown/.test(content)), "the model was told the outcome is unknown");
});

test("a turn that keeps killing its node is resumed at most twice, then fails as uncertain", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, () => undefined);
  const port = await freePort();
  let node = await c.start("a", model.env, port);
  const created = await new AgentRuntime({ url: node.url, apiKey: token, journalStore: memoryJournalStore() }).createAgent({ tools: {}, idempotencyKey: "doomed-agent" });
  await created.close();
  const client = await new AgentRuntime({ url: node.url, apiKey: token, journalStore: memoryJournalStore() }).connectAgent(created.session, { tools: {} });
  t.after(() => client.close());
  const run = client.prompt("hang", { idempotencyKey: "turn-3", timeoutMs: 100_000 });
  run.catch(() => {});
  for (let restart = 1; restart <= 3; restart++) {
    await until(() => model.bodies.length === restart, `model call ${restart}`);
    node.child.kill("SIGKILL");
    await once(node.child, "close");
    // The same address takes the old heartbeat over, so the restarted node owns the agent at once.
    node = await c.start(`a${restart}`, model.env, port);
  }
  await assert.rejects(run, /runtime restarted during this request/);
  assert.equal(model.bodies.length, 3, "the first attempt and two resumes");
  const state = await (await fetch(`${node.url}/clients/${created.session.id}/state`, { headers: { Authorization: `Bearer ${created.session.token}` } })).json() as any;
  const request = state.requests.find((entry: any) => entry.id === "turn-3");
  assert.equal(request.resumes, 2);
  assert.equal(request.outcome.uncertain, true);
});
