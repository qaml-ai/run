import { test } from "node:test";
import assert from "node:assert/strict";
import FakeTimers from "@sinonjs/fake-timers";
import { MemoryRetirement } from "../src/memory-retirement.ts";
import { REAL_CLOCK, REAL_NETWORK, runFor } from "../src/node-context.ts";

function setup(t: { after(fn: () => void): void }, options: { ms?: number; jitter?: number } = {}) {
  const timers = FakeTimers.install({ toFake: ["setInterval", "clearInterval", "performance"] });
  t.after(() => timers.uninstall());
  const state = { high: true, peer: true, held: false, attempts: 0, error: false, failures: 0, deferred: false, claimGate: undefined as Promise<void> | undefined, retired: [] as number[] };
  const make = () => runFor({ clock: REAL_CLOCK, network: REAL_NETWORK, random: { float: () => options.jitter ?? 0, bytes: size => Buffer.alloc(size) } }, () => {
    const retirement = new MemoryRetirement({
      ms: options.ms ?? 600_000,
      high: () => state.high,
      acquire: async () => {
        state.attempts++;
        if (state.error) throw new Error("database unavailable");
        if (!state.peer || state.held) return false;
        state.held = true;
        await state.claimGate;
        return true;
      },
      retire: async heldMs => { state.retired.push(heldMs); if (state.deferred) { state.held = false; return false; } },
      failed: () => { state.failures++; },
    });
    retirement.start();
    t.after(() => retirement.stop());
    return retirement;
  });
  return { timers, state, make };
}

test("retires once after sustained memory pressure plus the node's jitter", async t => {
  const { timers, state, make } = setup(t, { jitter: 0.5 });
  make();
  await timers.tickAsync(900_999);
  assert.equal(state.retired.length, 0);
  await timers.tickAsync(1);
  assert.deepEqual(state.retired, [900_000]);
  await timers.tickAsync(600_000);
  assert.equal(state.retired.length, 1);
});

test("memory falling below the threshold restarts the continuous window", async t => {
  const { timers, state, make } = setup(t);
  make();
  await timers.tickAsync(500_000);
  state.high = false;
  await timers.tickAsync(1_000);
  state.high = true;
  await timers.tickAsync(600_000);
  assert.equal(state.retired.length, 0);
  await timers.tickAsync(1_000);
  assert.deepEqual(state.retired, [600_000]);
});

test("without a live peer it keeps refusing and retries once a peer joins", async t => {
  const { timers, state, make } = setup(t);
  state.peer = false;
  make();
  await timers.tickAsync(620_000);
  assert.equal(state.retired.length, 0);
  assert.equal(state.attempts, 1);
  state.peer = true;
  await timers.tickAsync(10_999);
  assert.equal(state.attempts, 1);
  await timers.tickAsync(1);
  assert.deepEqual(state.retired, [630_000]);
});

test("database errors back off for thirty seconds", async t => {
  const { timers, state, make } = setup(t);
  state.error = true;
  make();
  await timers.tickAsync(601_000);
  assert.equal(state.failures, 1);
  state.error = false;
  await timers.tickAsync(29_999);
  assert.equal(state.attempts, 1);
  await timers.tickAsync(1);
  assert.deepEqual(state.retired, [630_000]);
});

test("zero disables memory retirement", async t => {
  const { timers, state, make } = setup(t, { ms: 0 });
  make();
  await timers.tickAsync(3_600_000);
  assert.equal(state.attempts, 0);
  assert.equal(state.retired.length, 0);
});

test("stopping during a successful claim still delivers it for drain or cleanup", async t => {
  const { timers, state, make } = setup(t);
  const gate = Promise.withResolvers<void>();
  state.claimGate = gate.promise;
  const retirement = make();
  await timers.tickAsync(601_000);
  assert.equal(state.held, true);
  retirement.stop();
  gate.resolve();
  await timers.tickAsync(0);
  assert.deepEqual(state.retired, [600_000]);
});


test("a deferred retirement retries after backoff without restarting the pressure window", async t => {
  const { timers, state, make } = setup(t);
  state.deferred = true;
  make();
  await timers.tickAsync(601_000);
  assert.deepEqual(state.retired, [600_000]);
  state.deferred = false;
  await timers.tickAsync(29_999);
  assert.equal(state.attempts, 1);
  await timers.tickAsync(1);
  assert.deepEqual(state.retired, [600_000, 630_000]);
});
