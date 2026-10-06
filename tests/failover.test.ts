import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { testDatabase } from "./database.ts";
import { databaseLink } from "./cluster-helpers.ts";

const token = "failover-operator-token-at-least-24-chars";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const TTL_MS = 3000;

/** One runtime node whose only way to its database is through `databaseLink`, with a short lease. */
async function node(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "agent-failover-"));
  const { db, url: direct } = await testDatabase();
  const link = await databaseLink(new URL(direct));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { anthropic: "fixture-key" } } } }));
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: root, PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: url, AGENT_DATABASE_URL: link.url,
      AGENT_DATA_DIR: join(root, "data"), AGENT_STORAGE: "shared-file", AGENT_LEASE_TTL_MS: String(TTL_MS), AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_DATABASE_QUERY_TIMEOUT_MS: "1000", AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "failover-session-secret-with-32-characters!",
      ...(process.env.AGENT_HOSTING ? { AGENT_HOSTING: process.env.AGENT_HOSTING } : {}),
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: any[] = [];
  let stderr = "";
  const ready = Promise.withResolvers<void>();
  let pending = "";
  child.stdout!.on("data", chunk => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) { try { logs.push(JSON.parse(line)); } catch { /* not a log record */ } }
    if (logs.some(entry => entry.type === "listening")) ready.resolve();
  });
  child.stderr!.on("data", chunk => {
    stderr += chunk;
    for (const line of String(chunk).split("\n")) { try { logs.push(JSON.parse(line)); } catch { /* not a log record */ } }
  });
  child.on("exit", code => ready.reject(new Error(`the node exited: ${code}\n${stderr}`)));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
    await link.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await ready.promise;
  const alive = () => assert.ok(child.exitCode === null && child.signalCode === null, `the node is still running\n${stderr}`);
  const owner = async (actor: string) => (await db.query("select node, session, epoch from actor_owners where actor = $1", [actor])).rows[0];
  return { url, link, logs, alive, owner, stderr: () => stderr };
}

const operator = { Authorization: `Bearer ${token}` };

/** Every answer while the database is away is a retryable 503 (or, once it is back, a success); never a 4xx or 500. */
async function probe(url: string, until: number) {
  const statuses = new Set<number>();
  do {
    for (const path of ["/v1/agents", "/registry"]) {
      const response = await fetch(`${url}${path}`, { headers: operator });
      await response.arrayBuffer();
      statuses.add(response.status);
      if (response.status !== 200) {
        assert.equal(response.status, 503, `${path} answered ${response.status}`);
        assert.ok(response.headers.get("retry-after"), "a 503 says when to retry");
      }
    }
    await sleep(100);
  } while (Date.now() < until);
  return statuses;
}

async function eventually(check: () => Promise<boolean>, ms: number, what: string) {
  for (const deadline = Date.now() + ms; !await check().catch(() => false);) {
    assert.ok(Date.now() < deadline, what);
    await sleep(100);
  }
}

const waiting = () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  return {
    gate, entered,
    tools: { wait: tool({ description: "Wait for the test", input: schema.Object({}, { additionalProperties: false }), execute: async () => { entered.resolve(); await gate.promise; return "waited"; } }) },
  };
};

for (const how of ["reset", "stall"] as const) {
  test(`a database outage shorter than the lease (${how}): no fence, a running turn waits it out, requests get 503 and Retry-After, then succeed`, { timeout: 60_000 }, async t => {
    const n = await node(t);
    const { gate, entered, tools } = waiting();
    const agent = await new AgentRuntime({ url: n.url, apiKey: token }).createAgent({ tools, idempotencyKey: `short-${how}` });
    t.after(() => agent.close());
    const before = await n.owner(agent.session.id);
    const running = agent.execute("return await tools.wait({})", { timeoutMs: 30_000 });
    await entered.promise;

    n.link.down(how);
    const restored = sleep(TTL_MS * 0.4).then(() => n.link.up());
    // The turn's tool result arrives mid-outage. Recording it durably needs the database (the journal's
    // tail is in Postgres), so the turn waits the outage out and then finishes; it does not fail.
    setTimeout(() => gate.resolve(), 300);
    // Stalled requests may simply finish once the database is back; refused ones answer 503. Many at once
    // fill the node's pool: its heartbeat must not queue behind them.
    const statuses = new Set((await Promise.all(Array.from({ length: 30 }, () => probe(n.url, Date.now() + TTL_MS * 0.3)))).flatMap(set => [...set]));
    assert.equal((await running).output[0], "waited");
    await restored;
    if (how === "reset") assert.ok(statuses.has(503), "requests needing the database were refused with 503");

    await eventually(async () => (await fetch(`${n.url}/v1/agents`, { headers: operator })).status === 200, 5_000, "requests succeed once the database is back");
    assert.equal((await agent.execute('return "after"')).output[0], "after");
    const created = await fetch(`${n.url}/v1/agents`, { method: "POST", headers: { ...operator, "Content-Type": "application/json", "Idempotency-Key": `new-${how}` }, body: "{}" });
    assert.equal(created.status, 201, await created.clone().text());
    await sleep(TTL_MS);
    assert.ok(!n.logs.some(entry => entry.type === "self_fence"), "the node did not fence");
    assert.deepEqual(await n.owner(agent.session.id), before, "the agent kept its owner and epoch");
    n.alive();
  });
}

test("a database outage longer than the lease: the node fences, then rejoins and takes its agent back under a higher epoch", { timeout: 60_000 }, async t => {
  const n = await node(t);
  const created = await new AgentRuntime({ url: n.url, apiKey: token }).createAgent({ tools: {}, idempotencyKey: "long" });
  assert.equal((await created.execute('return "before"')).output[0], "before");
  await created.close();
  const before = await n.owner(created.session.id);

  n.link.down("reset");
  await probe(n.url, Date.now() + TTL_MS * 1.5);
  assert.deepEqual(n.logs.filter(entry => entry.type === "self_fence").map(entry => entry.reason), ["heartbeat_expired"]);
  n.alive();
  n.link.up();

  const agent = await new AgentRuntime({ url: n.url, apiKey: token }).connectAgent(created.session, { tools: {} });
  t.after(() => agent.close());
  await eventually(async () => (await agent.execute('return "after"', { timeoutMs: 10_000 })).output[0] === "after", 10_000, "the agent is served again");
  const after = await n.owner(created.session.id);
  assert.equal(after.node, n.url);
  assert.notEqual(after.session, before.session, "the node rejoined under a new session");
  assert.equal(after.epoch, before.epoch + 1);
  n.alive();
});
