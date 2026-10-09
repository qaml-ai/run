import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { cluster, databaseLink, nodeLink, onFreePort, sha, sleep, token, until } from "./cluster-helpers.ts";
import { PROD, type Served, servingModel, slowLookup, busyAgents } from "./fresh-lease-helpers.ts";

test("a node cut off from its peers and the database is reaped, and from the moment a peer resumes its agents it makes no model or tool call", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const model = await servingModel(t);
  const database = await databaseLink(new URL(c.databaseUrl));
  t.after(() => database.close());
  // A's peers reach it through a link to its port, so the port is chosen first (and again if it was taken).
  const { peers, a } = await onFreePort(async port => {
    const peers = await nodeLink(port);
    try { return { peers, a: await c.start("a", { ...model.env("a"), ...PROD, AGENT_NODE_URL: peers.url, AGENT_DATABASE_URL: database.url, AGENT_DATABASE_QUERY_TIMEOUT_MS: "2000" }, port) }; }
    catch (error) { peers.cut(); throw error; }
  });
  const b = await c.start("b", { ...model.env("b"), ...PROD });
  const calls: { key: string; at: number }[] = [];
  const { looping, streaming } = await busyAgents(t, a.url, calls, model.served);

  // A still reaches the model and its client (the test), but neither its peers nor Postgres.
  peers.cut();
  database.down("reset");
  const partitioned = Date.now();
  await until(() => model.served.filter(entry => entry.node === "b").length >= 2, "B to resume both agents", 60_000);
  const resumed = Math.min(...model.served.filter(entry => entry.node === "b").map(entry => entry.started));
  assert.ok(b.logs.some(entry => entry.type === "node_reaped" && entry.node === peers.url), "B found A dead");
  // Long enough for A to have kept going, were it going to: its tool loop has 30 s of calls left, its stream 30 s.
  // (Before the fresh lease, A went on until it fenced: its stream ran 71 s past B's resume, its tool calls 31 s.)
  await sleep(8_000);

  const fromA = model.served.filter(entry => entry.node === "a");
  const lastToolCall = Math.max(...calls.map(call => call.at));
  const lastModel = Math.max(...fromA.map(entry => entry.ended ?? Date.now()));
  const overlap = Math.max(lastToolCall, lastModel) - resumed;
  t.diagnostic(`B resumed ${resumed - partitioned} ms after the partition; A's last tool call ${lastToolCall - partitioned} ms, its last model byte ${lastModel - partitioned} ms after it; overlap ${overlap} ms`);
  assert.ok(fromA.every(entry => entry.started < resumed), "A started no model call once B resumed");
  assert.ok(fromA.every(entry => entry.ended !== undefined && entry.ended < resumed), "A's stream was cut before B resumed");
  assert.ok(fromA.some(entry => entry.cut), "A cut its stream in flight");
  assert.ok(lastToolCall < resumed, "A made no tool call once B resumed");
  assert.ok(a.logs.some(entry => entry.type === "lease_interrupt"), "A's lease went stale and it cut its model requests");
  assert.ok(!a.logs.some(entry => entry.type === "self_fence"), "A has not reached its deadline");
  assert.equal(await c.owner(looping.session.id), b.url);
  assert.equal(await c.owner(streaming.session.id), b.url);
});
