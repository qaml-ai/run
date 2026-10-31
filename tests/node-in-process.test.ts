import { test } from "node:test";
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps, type RuntimeNode } from "../src/node.ts";
import { Ownership } from "../src/ownership.ts";
import type { Db } from "../src/db.ts";
import { REAL_NETWORK, type Network } from "../src/node-context.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { fakeModel, lastUser, toolCall, toolResults, until } from "./runtime-server.ts";
import { fakeExecutor } from "./fake-executor.ts";

// Two runtime nodes in one process (createNode, src/node.ts), each with its own configuration, sharing a database and
// storage as a cluster does: what a simulation runs many of.
test("two nodes run in one process, each serving its own agents and forwarding to the other's", async t => {
  // Every interval a node starts is its own, and stops when it closes.
  const intervals = new Map<number, string>();
  const hook = createHook({
    init(id, type, _trigger, resource) { if (type === "Timeout" && (resource as { _repeat?: unknown })._repeat) intervals.set(id, new Error().stack!.split("\n").filter(line => line.includes("file://")).slice(0, 3).join("\n")); },
    destroy(id) { intervals.delete(id); },
  });
  // "code: <script>" asks for js_exec once; its result is the answer.
  const model = await fakeModel(t, body => {
    const asked = lastUser(body), results = toolResults(body);
    if (asked.startsWith("code: ") && !results.length) return toolCall("js_exec", { code: asked.slice(6) });
    return { role: "assistant", content: results.length ? `ran: ${results.join(" ")}` : `answered: ${asked}` };
  });
  const executor = fakeExecutor();
  const root = await mkdtemp(join(tmpdir(), "agent-in-process-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key" } } } }));
  const { db, url: databaseUrl } = await testDatabase();
  hook.enable();
  const nodes: RuntimeNode[] = [];
  const counted = countingDb();
  const recorded = recordingNetwork();
  t.after(async () => { for (const node of nodes) await node.close().catch(() => {}); });
  for (const name of ["a", "b"]) await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_OPENROUTER_MODELS_URL: "", AGENT_SESSION_SECRET: "in-process-session-secret-with-32-chars!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: model.url, AGENT_SERVICE_NAME: `node-${name}`,
    });
    // Node b's database is not a pg.Pool: anything with Db's methods will do. Its network is its own too.
    const deps = await nodeDeps(config);
    const node = await createNode(config, name === "b" ? { ...deps, db: counted.wrap(deps.db), network: recorded.network, codeExecutor: executor } : deps);
    try { assert.equal((await node.start()).port, port); } catch (error) { await node.close().catch(() => {}); throw error; }
    nodes.push(node);
  });
  const [a, b] = nodes.map(node => node.node);
  assert.notEqual(a, b);
  const call = async (base: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    return { status: response.status, json: await response.json() as any };
  };
  const prompt = async (base: string, agent: string, text: string) => {
    const accepted = await call(base, `/v1/agents/${agent}/prompt`, { text });
    assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
    return until(async () => { const record = (await call(base, `/v1/agents/${agent}/requests/${accepted.json.id}`)).json; return record.state === "completed" && record; }, "the turn to end");
  };

  // Each node makes and runs an agent of its own: one turn each, on its own node.
  const agents: string[] = [];
  for (const [index, base] of [a, b].entries()) {
    const created = await call(base, "/v1/agents", { name: `agent-${index}` });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    agents.push(created.json.id);
    const record = await prompt(base, created.json.id, `hello ${index}`);
    assert.equal(record.outcome.error, undefined, JSON.stringify(record));
    assert.equal(record.outcome.result.reply, `answered: hello ${index}`);
  }
  assert.deepEqual((await db.query("select node from actor_owners where actor = any($1) order by array_position($1, actor)", [agents])).rows.map(row => row.node), [a, b]);
  assert.equal(model.bodies.length, 2);
  // A request to the other node goes to the agent's owner, in the same process.
  const forwarded = await prompt(b, agents[0], "via b");
  assert.equal(forwarded.outcome.result.reply, "answered: via b");
  // Node b's queries and transactions all went through the Db it was given.
  assert.ok(counted.queries > 0 && counted.transactions > 0, JSON.stringify(counted));
  // And whatever node b's code reached outside went through its network, wherever that code ran (its inline agent's
  // model call too); node a's never did: b's one model call, then the prompt for a's agent forwarded to a.
  const toModel = recorded.calls.filter(call => call.startsWith(`fetch ${model.url}`));
  assert.equal(toModel.length, 1, recorded.calls.join("\n"));
  assert.ok(recorded.calls.includes(`request ${a}/v1/agents/${agents[0]}/prompt`), recorded.calls.join("\n"));
  // Node b's agents run js_exec on the executor it was given.
  const ran = await prompt(b, agents[1], "code: print hi\nreturn 42");
  assert.equal(executor.opened, 1);
  assert.match(ran.outcome.result.reply, /^ran: .*hi.*42/s);

  // Both leave: the database shows neither, and neither leaves an interval running.
  for (const node of nodes.splice(0)) await node.close();
  assert.deepEqual((await db.query("select node from runtime_nodes")).rows, []);
  // Destroy hooks are delivered a little later than the clearInterval that causes them.
  await until(() => intervals.size === 0, "the nodes' intervals to stop", 2_000).catch(() => {
    assert.fail(`intervals still running after close:\n${[...intervals.values()].join("\n---\n")}`);
  });
  hook.disable();
});

/** A Db that wraps another, counting queries and the connections transactions take. */
function countingDb() {
  const counts = { queries: 0, transactions: 0 };
  return Object.assign(counts, {
    wrap: (pool: Db): Db => ({
      query: (text, values) => { counts.queries++; return pool.query(text, values); },
      connect: async () => {
        counts.transactions++;
        const client = await pool.connect();
        return { query: (text, values) => { counts.queries++; return client.query(text, values); }, release: error => client.release(error), on: (event, listener) => client.on(event, listener), off: (event, listener) => client.off(event, listener) };
      },
      end: () => pool.end(),
      get totalCount() { return pool.totalCount; },
      get idleCount() { return pool.idleCount; },
      get waitingCount() { return pool.waitingCount; },
    }),
  });
}

/** The real network, recording what goes through it: `fetch <url>` and `request <url>`. */
function recordingNetwork() {
  const calls: string[] = [];
  const network: Network = {
    ...REAL_NETWORK,
    fetch: (input, init) => { calls.push(`fetch ${input instanceof Request ? input.url : String(input)}`); return REAL_NETWORK.fetch(input, init); },
    request: ((url: URL, ...rest: unknown[]) => { calls.push(`request ${url}`); return (REAL_NETWORK.request as (...args: unknown[]) => unknown)(url, ...rest); }) as Network["request"],
  };
  return { calls, network };
}

for (const state of ["stop", "current", "waiting", "superseded", "unknown"] as const) test(`memory retirement uses ${state} and keeps HTTP alive until the first external signal`, { timeout: 60_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-memory-retire-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { db, url } = await testDatabase();
  const nodes: RuntimeNode[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let fallback = false;
  let stops = 0;
  t.after(async () => { release.resolve(); for (const node of nodes) await node.close().catch(() => {}); });
  const logs: any[] = [];
  const log = console.log;
  t.mock.method(console, "log", (line: string) => { try { logs.push(JSON.parse(line)); } catch {} log(line); });
  for (const name of ["peer", "high"]) await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: url,
      AGENT_DATA_DIR: root, AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline",
      AGENT_TENANT: "alice", AGENT_OPERATOR_TOKEN: token,
      AGENT_OPENROUTER_MODELS_URL: "", AGENT_SESSION_SECRET: "memory-retirement-test-session-secret", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_MEMORY_HIGH_BYTES: name === "high" ? "1" : undefined, AGENT_MEMORY_RETIRE_MS: "1",
    });
    const deps = await nodeDeps(config);
    if (name === "high") {
      const query = deps.db.query.bind(deps.db);
      deps.db.query = async (text, values) => {
        if (text.startsWith("update runtime_nodes set draining = true")) { entered.resolve(); await release.promise; }
        return query(text, values);
      };
    }
    const check = Object.assign(async () => state === "stop" ? "current" as const : state === "unknown" ? "waiting" as const : state, {
      stopTask: async () => { stops++; if (state !== "stop") throw new Error("AccessDenied"); },
    });
    const node = await createNode(config, { ...deps, supersession: async () => state === "unknown" ? undefined : check,
      random: { float: () => 0, bytes: randomBytes }, memoryRetired: () => { fallback = true; } });
    nodes.push(node);
    await node.start();
  });
  const high = nodes[1];
  if (!["stop", "current"].includes(state)) {
    await until(() => logs.some(entry => entry.type === "node_memory_retire_deferred" && entry.node === high.node), "claim deferred", 45_000);
    assert.deepEqual((await db.query("select memory_retiring, draining from runtime_nodes where node = $1", [high.node])).rows[0], { memory_retiring: false, draining: true });
    assert.equal((await fetch(`${high.node}/healthz`)).status, 200);
    assert.equal(stops, state === "unknown" ? 0 : 1);
    release.resolve();
    return;
  }
  await entered.promise;
  assert.equal(stops, 1);
  assert.equal((await fetch(`${high.node}/healthz`)).status, state === "stop" ? 200 : 503);
  assert.equal((await db.query("select memory_retiring, draining from runtime_nodes where node = $1", [high.node])).rows[0].memory_retiring, true);
  assert.ok(logs.some(entry => entry.type === "node_memory_retire" && entry.rssMb > 0 && entry.heldMs >= 1));
  release.resolve();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await fetch(`${high.node}/healthz`)).status, state === "stop" ? 200 : 503);
  assert.equal((await db.query("select 1 from runtime_nodes where node = $1", [high.node])).rowCount, 1);
  await high.drain("SIGTERM");
  assert.equal(fallback, false, "an external signal never invokes the fallback exit");
  assert.equal((await db.query("select 1 from runtime_nodes where node = $1", [high.node])).rowCount, 0);
  assert.ok(logs.some(entry => entry.type === "drain_finished" && entry.node === high.node));
  assert.equal((await fetch(`${nodes[0].node}/healthz`)).status, 200);
});

test("SIGTERM during a memory drain hands the running turn to a peer, which goes on with it", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-memory-signal-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { db, url } = await testDatabase();
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key" } } } }));
  const release = Promise.withResolvers<void>();
  const model = await fakeModel(t, (_body, index) => index === 0
    ? { ...toolCall("js_exec", { code: "return 42" }), wait: release.promise }
    : { role: "assistant", content: "finished on the peer" });
  let high = false;
  t.mock.method(process.memoryUsage, "rss", () => high ? 2 : 0);
  const nodes: RuntimeNode[] = [];
  t.after(async () => { release.resolve(); for (const node of nodes) await node.close().catch(() => {}); });
  for (const name of ["peer", "high"]) await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: url,
      AGENT_DATA_DIR: root, AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline",
      AGENT_TENANTS_FILE: join(root, "tenants.json"),
      AGENT_OPENROUTER_MODELS_URL: "", AGENT_SESSION_SECRET: "memory-retirement-test-session-secret", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: model.url,
      AGENT_MEMORY_HIGH_BYTES: name === "high" ? "1" : undefined, AGENT_MEMORY_RETIRE_MS: "1",
    });
    const node = await createNode(config, { ...await nodeDeps(config), supersession: async () => async () => "current", random: { float: () => 0, bytes: randomBytes } });
    nodes.push(node);
    await node.start();
  });
  const [peer, retiring] = nodes;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const created = await (await fetch(`${retiring.node}/v1/agents`, { method: "POST", headers, body: JSON.stringify({ name: "memory-signal" }) })).json() as any;
  const accepted = await (await fetch(`${retiring.node}/v1/agents/${created.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "go" }) })).json() as any;
  await until(() => model.bodies.length === 1, "the first model step to start");
  high = true;
  await until(async () => (await fetch(`${retiring.node}/healthz`)).status === 503, "memory retirement to begin");
  // The running turn is handed off at once: the peer makes the model request the close cut again.
  await retiring.drain("SIGTERM");
  release.resolve();
  const record = await until(async () => {
    const result = await (await fetch(`${peer.node}/v1/agents/${created.id}/requests/${accepted.id}`, { headers })).json() as any;
    return result.state === "completed" && result;
  }, "the handed-off turn to finish");
  assert.equal(record.outcome.error, undefined, JSON.stringify(record));
  assert.equal(record.outcome.result.reply, "finished on the peer");
  assert.ok(record.handoffs.some((handoff: any) => handoff.reason === "memory"), JSON.stringify(record));
  assert.equal((await db.query("select node from actor_owners where actor = $1", [created.id])).rows[0].node, peer.node);
});

for (const fails of [false, true]) test(`memory fallback exits ${fails ? 1 : 0} after the drain ${fails ? "fails" : "finishes"}`, { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-memory-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { url } = await testDatabase();
  const nodes: RuntimeNode[] = [];
  t.after(async () => { for (const node of nodes) await node.close().catch(() => {}); });
  const retired = Promise.withResolvers<number>();
  for (const name of ["peer", "high"]) await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: url,
      AGENT_DATA_DIR: root, AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline",
      AGENT_TENANT: "alice", AGENT_OPERATOR_TOKEN: token,
      AGENT_OPENROUTER_MODELS_URL: "", AGENT_SESSION_SECRET: "memory-retirement-test-session-secret", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_MEMORY_HIGH_BYTES: name === "high" ? "1" : undefined, AGENT_MEMORY_RETIRE_MS: "1", AGENT_MEMORY_RETIRE_FALLBACK_MS: "100",
    });
    const deps = await nodeDeps(config);
    if (name === "high" && fails) {
      const end = deps.db.end.bind(deps.db);
      deps.db.end = async () => { await end(); throw new Error("test drain failure"); };
    }
    const node = await createNode(config, { ...deps, supersession: async () => async () => "current", random: { float: () => 0, bytes: randomBytes }, memoryRetired: code => retired.resolve(code) });
    nodes.push(node);
    await node.start();
  });
  assert.equal(await retired.promise, fails ? 1 : 0);
});


test("SIGTERM during a memory claim releases the flag without undraining", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-memory-bail-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const { db, url } = await testDatabase();
  const nodes: RuntimeNode[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let signal: Promise<void> | undefined;
  t.after(async () => { release.resolve(); for (const node of nodes) await node.close().catch(() => {}); });
  const retire = Ownership.prototype.retireForMemory;
  const drain = Ownership.prototype.drain;
  const undrain = t.mock.method(Ownership.prototype, "undrain");
  t.mock.method(Ownership.prototype, "drain", async function(this: Ownership) {
    entered.resolve();
    await release.promise;
    await drain.call(this);
  });
  t.mock.method(Ownership.prototype, "retireForMemory", async function(this: Ownership, retry?: boolean) {
    const claimed = await retire.call(this, retry);
    if (claimed) { signal = nodes[1].drain("SIGTERM"); await entered.promise; }
    return claimed;
  });
  for (const name of ["peer", "high"]) await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: url,
      AGENT_DATA_DIR: root, AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline",
      AGENT_TENANT: "alice", AGENT_OPERATOR_TOKEN: token,
      AGENT_OPENROUTER_MODELS_URL: "", AGENT_SESSION_SECRET: "memory-retirement-test-session-secret", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_MEMORY_HIGH_BYTES: name === "high" ? "1" : undefined, AGENT_MEMORY_RETIRE_MS: "1",
    });
    const node = await createNode(config, { ...await nodeDeps(config), random: { float: () => 0, bytes: randomBytes } });
    nodes.push(node);
    await node.start();
  });
  await entered.promise;
  await until(async () => (await db.query("select memory_retiring from runtime_nodes where node = $1", [nodes[1].node])).rows[0]?.memory_retiring === false, "memory claim released");
  assert.equal((await db.query("select draining from runtime_nodes where node = $1", [nodes[1].node])).rows[0].draining, true);
  assert.equal(undrain.mock.callCount(), 0);
  release.resolve();
  await signal;
});
