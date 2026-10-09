import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { cluster, databaseLink, freePort, nodeLink, sha, sleep, token, until } from "./cluster-helpers.ts";
import { PROD, type Served, servingModel, slowLookup, busyAgents } from "./fresh-lease-helpers.ts";

test("a 20 s database outage with no partition: nobody is reaped, effects pause and then go on, every turn completes, and nothing is served twice", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  // 100 lookups (25 s) plus the pause (about 14 s) fit js_exec's 60 s with room to spare. 160 took 58 s here and past 60 s
  // on a loaded CI runner, where the execution timed out after 140.
  const model = await servingModel(t, { lookups: 100 });
  const database = await databaseLink(new URL(c.databaseUrl));
  t.after(() => database.close());
  const a = await c.start("a", { ...model.env("a"), ...PROD, AGENT_DATABASE_URL: database.url, AGENT_DATABASE_QUERY_TIMEOUT_MS: "2000" });
  const b = await c.start("b", { ...model.env("b"), ...PROD, AGENT_DATABASE_URL: database.url, AGENT_DATABASE_QUERY_TIMEOUT_MS: "2000" });
  const calls: { key: string; at: number }[] = [];
  const { runs } = await busyAgents(t, a.url, calls, model.served);

  database.down("reset");
  const down = Date.now();
  await sleep(20_000);
  database.up();
  const up = Date.now();
  const [loop, stream] = await Promise.all(runs);
  assert.equal(loop.error, null, JSON.stringify(loop));
  assert.equal(stream.error, null, JSON.stringify(stream));
  assert.equal(stream.reply, "answered by a", "the cut stream was asked again and answered");

  // Paused: from two renewals after the database went away (6 s, plus a renewal's slack) until it came back.
  const paused = calls.filter(call => call.at > down + 7_000 && call.at < up);
  assert.deepEqual(paused, [], "no tool call while the lease was stale");
  assert.ok(calls.some(call => call.at > up), "tool calls went on after the outage");
  assert.equal(new Set(calls.map(call => call.key)).size, calls.length, "no lookup was made twice");
  assert.equal(calls.length, 100);
  const started = model.served.filter(entry => entry.started > down + 7_000 && entry.started < up);
  assert.deepEqual(started, [], "no model call started while the lease was stale");
  assert.ok(model.served.every(entry => entry.node === "a"), "only A served its agents");
  assert.ok(model.served.some(entry => entry.prompt === "stream" && entry.cut), "the stream in flight was cut, not left running");
  for (const node of [a, b]) {
    assert.ok(!node.logs.some(entry => entry.type === "node_reaped" || entry.type === "self_fence"), `${node.name}: no reap, no fence`);
    assert.ok(node.logs.some(entry => entry.type === "lease_fresh"), `${node.name} went stale and fresh again`);
  }
});
