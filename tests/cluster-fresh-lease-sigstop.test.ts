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

test("a SIGSTOP shorter than the fresh window: no takeover, no cut, and effects go on as soon as the node wakes", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const model = await servingModel(t);
  const a = await c.start("a", { ...model.env("a"), ...PROD });
  const b = await c.start("b", { ...model.env("b"), ...PROD });
  const calls: { key: string; at: number }[] = [];
  const runtime = new AgentRuntime({ url: a.url, apiKey: token });
  const looping = await runtime.createAgent({ tools: slowLookup(calls), idempotencyKey: "looping" });
  t.after(() => looping.close());
  const run = looping.prompt("loop", { idempotencyKey: "loop-turn", timeoutMs: 120_000 });
  await until(() => calls.length >= 5, "the tool loop to run");

  // 4 s: under the 6 s fresh window, though up to 7 s after the last renewal began.
  a.child.kill("SIGSTOP");
  await sleep(4_000);
  a.child.kill("SIGCONT");
  const woke = Date.now();
  await until(() => calls.some(call => call.at > woke), "a tool call after A woke", 10_000);
  const next = calls.find(call => call.at > woke)!.at - woke;
  assert.ok(next < 1_000, `the next tool call came ${next} ms after A woke`);
  const result = await run;
  assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.reply, "answered by a");
  assert.equal(calls.length, 160);
  assert.ok(model.served.every(entry => entry.node === "a" && !entry.cut), "every model call was A's, and none was cut");
  assert.ok(!a.logs.some(entry => entry.type === "lease_interrupt" || entry.type === "self_fence"), "no cut, no fence");
  assert.ok(!b.logs.some(entry => entry.type === "node_reaped"), "B found A alive");
  assert.equal(await c.owner(looping.session.id), a.url);
});
