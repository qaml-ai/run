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
import type { Db } from "../src/db.ts";
import { freePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { fakeModel, lastUser, until } from "./runtime-server.ts";

// Two runtime nodes in one process (createNode, src/node.ts), each with its own configuration, sharing a database and
// storage as a cluster does: what a simulation runs many of.
test("two nodes run in one process, each serving its own agents and forwarding to the other's", async t => {
  // Every interval a node starts is its own, and stops when it closes.
  const intervals = new Map<number, string>();
  const hook = createHook({
    init(id, type, _trigger, resource) { if (type === "Timeout" && (resource as { _repeat?: unknown })._repeat) intervals.set(id, new Error().stack!.split("\n").filter(line => line.includes("file://")).slice(0, 3).join("\n")); },
    destroy(id) { intervals.delete(id); },
  });
  const model = await fakeModel(t, body => ({ role: "assistant", content: `answered: ${lastUser(body)}` }));
  const root = await mkdtemp(join(tmpdir(), "agent-in-process-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key" } } } }));
  const { db, url: databaseUrl } = await testDatabase();
  hook.enable();
  const nodes: RuntimeNode[] = [];
  const counted = countingDb();
  t.after(async () => { for (const node of nodes) await node.close().catch(() => {}); });
  for (const name of ["a", "b"]) {
    const port = await freePort();
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "in-process-session-secret-with-32-chars!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: model.url, AGENT_SERVICE_NAME: `node-${name}`,
    });
    // Node b's database is not a pg.Pool: anything with Db's methods will do.
    const deps = await nodeDeps(config);
    const node = await createNode(config, name === "b" ? { ...deps, db: counted.wrap(deps.db) } : deps);
    nodes.push(node);
    assert.equal((await node.start()).port, port);
  }
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
