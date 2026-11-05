import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attach, listen, until, untilRequestState, watchEvents } from "./http.ts";
import { observePollingResponse } from "./polling.ts";
import { caseTimeout } from "./timing.ts";

for (const status of [404, 405, 501]) test(`a missing required route fails its first unsatisfied poll (${status})`, async () => {
  let attempts = 0;
  await assert.rejects(until(() => {
    attempts++;
    observePollingResponse("/v1/required?secret=omitted", status);
    return false;
  }, "the required result", 90_000), new RegExp(`Cannot wait for the required result: /v1/required returned HTTP ${status}`));
  assert.equal(attempts, 1);
});

test("a negative route assertion can finish on a terminal HTTP response", async () => {
  assert.equal(await until(() => {
    observePollingResponse("/v1/deleted", 404);
    return true;
  }, "deletion"), true);
});

test("an explicitly pending resource may return 404 before concurrent admission finishes", async () => {
  let attempts = 0;
  const pendingResources = ["/v1/agents/test/requests/second"];
  assert.equal(await until(() => {
    const status = ++attempts === 1 ? 404 : 200;
    observePollingResponse(pendingResources[0], status);
    return status === 200;
  }, "SDK admission", undefined, { pendingResources }), true);
  assert.equal(attempts, 2);
  for (const [path, status, method] of [["/another-route", 404, "GET"], [pendingResources[0], 405, "GET"], [pendingResources[0], 501, "GET"], [pendingResources[0], 404, "POST"]] as const) {
    await assert.rejects(until(() => {
      observePollingResponse(path, status, undefined, method);
      return false;
    }, "SDK admission", undefined, { pendingResources }), /returned HTTP/);
  }
  await assert.rejects(until(() => {
    observePollingResponse(pendingResources[0], 404, { error: "Unsupported operation" });
    return false;
  }, "SDK admission", undefined, { pendingResources }), /returned HTTP 404/);
});

test("an explicit unsupported body fails a wait but an unrelated error does not", async () => {
  await assert.rejects(until(() => {
    observePollingResponse("/v1/required", 400, { error: { code: "unsupported_operation" } });
    return false;
  }, "supported operation"), /explicit unsupported error/);
  let attempts = 0;
  assert.equal(await until(() => {
    observePollingResponse("/v1/required", 429, { error: "rate limited" });
    return ++attempts === 2;
  }, "rate limit to clear"), true);
  assert.equal(attempts, 2);
});

test("request polling accepts its requested terminal state and rejects a different one", async () => {
  const completed = { state: "completed", result: 42 };
  assert.equal(await untilRequestState(() => completed, "completed", "turn"), completed);
  const cancelled = { state: "cancelled" };
  assert.equal(await untilRequestState(() => cancelled, "cancelled", "cancellation"), cancelled);
  await assert.rejects(untilRequestState(() => cancelled, "completed", "turn", 90_000), /terminal state cancelled, expected completed/);
});

test("concurrent polls keep terminal observations separate", async () => {
  const failed = until(async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    observePollingResponse("/missing", 404);
    return false;
  }, "missing");
  let attempts = 0;
  const healthy = until(() => ++attempts === 2, "healthy");
  await assert.rejects(failed, /HTTP 404/);
  assert.equal(await healthy, true);
});

test("an immediately satisfied poll keeps the original single-await scheduling", async () => {
  async function microtasksUntilSettled(operation: () => Promise<unknown>) {
    let ticks = 0, running = true;
    const tick = () => { ticks++; if (running) queueMicrotask(tick); };
    queueMicrotask(tick);
    await operation();
    running = false;
    return ticks;
  }
  const original = await microtasksUntilSettled(async () => { const result = await true; return result; });
  const observed = await microtasksUntilSettled(() => until(() => true, "an immediate result"));
  assert.equal(observed, original);
});

test("an MCP stream ending before initialization fails without waiting for the case timeout", async t => {
  const base = await listen(t, (_req, res) => res.writeHead(200, { "Content-Type": "text/event-stream" }).end());
  await assert.rejects(attach(t, base, "agent", "test-token"), /ended before initialization/);
});

test("missing stream responses still support negative assertions and fail unsatisfied frame waits", async t => {
  const base = await listen(t, (_req, res) => res.writeHead(404).end());
  const watcher = await watchEvents(t, base + "/events", {});
  assert.equal(watcher.status, 404);
  await assert.rejects(until(() => watcher.frames.length > 0, "first frame", 90_000), /HTTP 404/);
});

test("a finished stream keeps its existing frames available but cannot produce another", async t => {
  const base = await listen(t, (_req, res) => res.writeHead(200, { "Content-Type": "text/event-stream" }).end('data: {"value":42}\n\n'));
  const watcher = await watchEvents(t, base + "/events", {});
  await until(() => watcher.ended, "stream to end");
  assert.equal((await until(() => watcher.frames.find(frame => frame.data.value === 42), "existing frame")).data.value, 42);
  await assert.rejects(until(() => watcher.frames.find(frame => frame.data.value === 43), "another frame"), /no more frames can arrive/);
});

test("Workers defaults use measured per-case p99 and Node keeps its original default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contract-timing-"));
  const previous = { backend: process.env.CONTRACT_BACKEND, baseline: process.env.CONTRACT_NODE_BASELINE, timeout: process.env.CONTRACT_TIMEOUT_MS };
  try {
    const baseline = join(directory, "node.json");
    await writeFile(baseline, JSON.stringify({ rows: [
      { area: "test", source: "test.ts", name: "fast", status: "pass", durationMs: 12 },
      { area: "test", source: "test.ts", name: "slow", status: "pass", durationSamplesMs: [1000, 5000, 8000] },
    ] }));
    delete process.env.CONTRACT_TIMEOUT_MS;
    process.env.CONTRACT_NODE_BASELINE = baseline;
    process.env.CONTRACT_BACKEND = "node";
    assert.equal(caseTimeout("test", "test.ts", "fast"), 90_000);
    process.env.CONTRACT_BACKEND = "workers";
    assert.equal(caseTimeout("test", "test.ts", "fast"), 10_000);
    assert.equal(caseTimeout("test", "test.ts", "slow"), 24_000);
    assert.equal(caseTimeout("test", "test.ts", "unknown"), 90_000);
    process.env.CONTRACT_TIMEOUT_MS = "120000";
    assert.equal(caseTimeout("test", "test.ts", "fast"), 120_000);
  } finally {
    for (const [name, value] of [["CONTRACT_BACKEND", previous.backend], ["CONTRACT_NODE_BASELINE", previous.baseline], ["CONTRACT_TIMEOUT_MS", previous.timeout]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
