import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { AgentRuntime } from "../clients/typescript.ts";
import { watchEvents } from "./runtime-server.ts";
import { cluster, fakeModel, lookup, sleep, token, until } from "./cluster-helpers.ts";

/** The nodes whose heartbeat is live: the cluster as its peers see it. */
const live = async (c: Awaited<ReturnType<typeof cluster>>) => (await c.db.query("select node from runtime_nodes where expires_at > now() order by node")).rows.map(row => row.node);

test("a node with single-host file storage refuses to start beside another node on the same database, and leaves no heartbeat", { timeout: 60_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  // It waits out its lease for the peer to go, renewing its own heartbeat, which would be live seconds after it failed.
  await assert.rejects(c.start("b", { AGENT_STORAGE: "file", AGENT_LEASE_TTL_MS: "4000" }), /node b exited: 1/);
  assert.deepEqual(await live(c), [a.url]);
});

test("a node whose port is taken leaves the cluster it joined before it fails: peers never count its heartbeat", { timeout: 60_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  // Whatever holds the port accepts connections, so a peer's probe would find the failed node alive for its whole lease.
  const holder = createServer().listen(0, "127.0.0.1");
  await once(holder, "listening");
  t.after(() => new Promise<void>(resolve => holder.close(() => resolve())));
  const port = (holder.address() as { port: number }).port;
  await assert.rejects(c.start("b", { AGENT_LEASE_TTL_MS: "60000" }, port), /node b exited: 1/);
  assert.deepEqual(await live(c), [a.url]);
});

test("any node serves any agent: requests are forwarded to the owner, and a survivor takes over when it dies", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const calls: string[] = [];

  // Created through A, so A owns it.
  const viaA = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: lookup(calls), idempotencyKey: "shared-agent" });
  assert.equal((await viaA.execute('return await tools.lookup({ key: "one" })')).output[0], "value-of-one");
  await viaA.close();

  // A client attached to B reaches the same agent: its requests and SSE stream are forwarded to A.
  const viaB = await new AgentRuntime({ url: b.url, apiKey: token }).connectAgent(viaA.session, { tools: lookup(calls) });
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
  // The claiming node drops a one-shot wake-up once its delivery returns, which can be just after the run it started ends.
  await until(async () => (await viaB.schedules()).length === 0, "the delivered wake-up to be dropped");
  calls.splice(calls.indexOf("timer"), 1);

  // Re-provisioning through B returns the same agent without starting a second copy.
  const again = await fetch(`${b.url}/v1/agents`, {
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
  const agent = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: lookup(calls) });
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

test("watching an idle agent loads it nowhere; when a node loads it, other nodes' idle watchers move to it at once", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  // A lease that outlasts a database or CPU stall on a loaded runner. Under the cluster's 1.5 s, a stall of about a second
  // fenced both nodes after the watcher had reconnected: A's session was lost and the watcher's stream ended before the
  // run it waits for (a client would reconnect; this one does not). Nothing here waits for a lease to run out.
  const env = { AGENT_IDLE_MS: "1000", AGENT_LEASE_TTL_MS: "6000" };
  const a = await c.start("a", env);
  const b = await c.start("b", env);
  const agent = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: lookup([]) });
  await agent.execute("return 1");
  await agent.close();
  await until(async () => !(await c.owner(agent.session.id)), "the idle agent to be released", 20_000);
  const auth = { Authorization: `Bearer ${agent.session.token}` };
  // Held by B, which does not load it: no node owns it after.
  const idle = await watchEvents(t, `${b.url}/clients/${agent.session.id}/events`, auth);
  assert.equal(idle.status, 200);
  await sleep(500);
  assert.ok(!await c.owner(agent.session.id), "no node owns it");
  // A loads it for a run: B's watcher ends at once (not at B's 20 s check), and reconnecting through B reaches A.
  const started = Date.now();
  const running = await new AgentRuntime({ url: a.url, apiKey: token }).connectAgent(agent.session, { tools: lookup([]) });
  t.after(() => running.close());
  await until(() => idle.ended, "B's idle watcher to end", 10_000);
  assert.ok(Date.now() - started < 10_000);
  const moved = await watchEvents(t, `${b.url}/clients/${agent.session.id}/events`, auth, { query: "watch=1&snapshot=1" });
  assert.equal((await running.execute("return 2", { idempotencyKey: "after" })).output[0], "2");
  await until(() => moved.frames.some(frame => frame.data.type === "response" && frame.data.id === "after"), "the reconnected watcher to see the run on A");
});

test("a load that fails after reading the agent leaves no session behind: the node forwards to whoever loads it next", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, () => ({ role: "assistant", content: "ok" }));
  // A lease that outlasts a database or CPU stall on a loaded runner: under the cluster's 1.5 s, a stall just after the
  // create fenced A, which leaves its ownership row naming its old session, so the raw row never cleared.
  const env = { ...model.env, AGENT_IDLE_MS: "1000", AGENT_ORPHAN_SWEEP_MS: "0", AGENT_LEASE_TTL_MS: "6000" };
  const a = await c.start("a", env);
  const b = await c.start("b", env);
  const call = (base: string, path: string, body?: unknown) => fetch(base + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const made = await (await call(a.url, "/v1/agents", {})).json() as any;
  const agent = made.id as string;
  // Released, or let go by a fence: either way no node holds it.
  await until(async () => !await c.liveOwner(agent), "the idle agent to be released", 20_000);
  // The first write clearing its pending mark fails (a sequence counts it: a failed transaction does not undo that),
  // as a database failover might make it fail.
  await c.db.query(`create table fail_once (agent text primary key); create sequence fail_once_count;
    create function fail_once() returns trigger language plpgsql as $$ begin
      if old.pending_runs and not new.pending_runs and exists (select from fail_once where agent = new.id) and nextval('fail_once_count') = 1 then raise exception 'injected failure'; end if;
      return new; end $$;
    create trigger fail_once before update on agents for each row execute function fail_once();`);
  await c.db.query("update agents set pending_runs = true where id = $1", [agent]);
  await c.db.query("insert into fail_once values ($1)", [agent]);
  const failed = await fetch(`${b.url}/clients/${agent}/events`, { headers: { Authorization: `Bearer ${made.token}` } });
  await failed.body?.cancel();
  // Whichever node holds the agent now, a prompt through either reaches the one session it has.
  assert.equal((await call(a.url, `/v1/agents/${agent}/prompt`, { text: "one", requestId: "via-a" })).status, 202);
  assert.equal((await call(b.url, `/v1/agents/${agent}/prompt`, { text: "two", requestId: "via-b" })).status, 202);
  const state = await (await call(a.url, `/v1/agents/${agent}/state`)).json() as any;
  assert.deepEqual(["via-a", "via-b"].filter(id => state.requests.some((request: any) => request.id === id)), ["via-a", "via-b"]);
});

test("a volume is served by one node: other nodes forward to it, agents anywhere reach it, and a survivor takes over", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const viaA = new AgentRuntime({ url: a.url, apiKey: token });
  const viaB = new AgentRuntime({ url: b.url, apiKey: token });
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
  await agent.execute(`
    await tools.read({ path: "/shared/plan.md" });
    return await tools.edit({ path: "/shared/plan.md", old: "draft", new: "final" });`);
  const edited = await viaA.volume(id).read("plan.md");
  assert.equal(edited.version, first.version + 1);
  assert.equal(new TextDecoder().decode(edited.data), "final");
  assert.equal(await c.owner(id), a.url, "the volume did not move to the agent's node");
  // Someone else changes it: the agent's next edit, based on what it read, is refused until it reads again.
  await viaA.volume(id).write("plan.md", "final", { version: edited.version });
  await assert.rejects(agent.execute('return await tools.edit({ path: "/shared/plan.md", old: "final", new: "x" })'), /changed since you last read it/);

  // A dies owning the volume. Once its heartbeat expires, B serves it from storage.
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  await sleep(1500 + 500);
  assert.equal(await viaB.volume(id).readText("plan.md"), "final");
  assert.equal(await c.owner(id), b.url);
  assert.equal(JSON.parse((await agent.execute('return await tools.read({ path: "/shared/plan.md" })', { timeoutMs: 20_000 })).output[0]).content, "final");
  await agent.execute('await tools.write({ path: "/shared/after.md", content: "written after takeover" })');
  assert.deepEqual((await viaB.volume(id).list()).files.map(file => file.path), ["/after.md", "/plan.md"]);
});

test("a stale owner cache entry heals: a request to a dead owner drops it, and the next is served by a live node", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  // A long lease, so only the cache (not heartbeat expiry) can send B to the dead node.
  const a = await c.start("a", { AGENT_LEASE_TTL_MS: "60000" });
  const b = await c.start("b", { AGENT_LEASE_TTL_MS: "60000" });
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "cached-agent" });
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
