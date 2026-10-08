import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { clock, network, random, REAL_CLOCK, REAL_NETWORK, REAL_RANDOM, runFor, type Clock, type NodeContext } from "../src/node-context.ts";
import { Ownership } from "../src/ownership.ts";
import { testDatabase } from "./database.ts";

/** A clock that moves only when told: `advance` runs the timers that come due, in order. */
function manualClock(start = 0) {
  let now = start;
  const timers = new Map<object, { at: number; every?: number; callback: () => void }>();
  const timer = (callback: () => void, ms: number, every?: number) => {
    const handle = { unref: () => handle, ref: () => handle, hasRef: () => false };
    timers.set(handle, { at: now + Math.max(0, ms), every, callback });
    return handle as unknown as ReturnType<typeof setTimeout>;
  };
  const clear = (handle: unknown) => { timers.delete(handle as object); };
  const clock: Clock = {
    now: () => Date.UTC(2030, 0, 1) + now, monotonic: () => now,
    setTimeout: (callback, ms) => timer(callback, ms), clearTimeout: clear,
    setInterval: (callback, ms) => timer(callback, ms, Math.max(1, ms)), clearInterval: clear,
    sleep: ms => new Promise(resolve => timer(() => resolve(), ms)),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [handle, entry] = due;
      now = entry.at;
      if (entry.every) entry.at += entry.every; else timers.delete(handle);
      entry.callback();
    }
    now = until;
  };
  return { clock, advance, get pending() { return timers.size; } };
}

const context = (overrides: Partial<NodeContext> = {}): NodeContext => ({ network: REAL_NETWORK, clock: REAL_CLOCK, random: REAL_RANDOM, ...overrides });

test("code finds the context of the node it runs for wherever it runs, and the real ones outside any", async () => {
  const node = context({ random: { float: () => 0.25, bytes: size => Buffer.alloc(size, 7) } });
  const seen: NodeContext["random"][] = [];
  const emitter = new EventEmitter();
  await runFor(node, async () => {
    seen.push(random());
    await new Promise(resolve => setTimeout(resolve, 1));
    seen.push(random());
    await Promise.resolve().then(() => seen.push(random()));
    emitter.on("event", () => seen.push(random()));
  });
  // A listener runs in the context of whoever emits, not of whoever listened: a simulator emits for a node inside it.
  emitter.emit("event");
  assert.deepEqual(seen, [node.random, node.random, node.random, REAL_RANDOM]);
  assert.equal(random(), REAL_RANDOM);
  assert.equal(clock(), REAL_CLOCK);
  assert.equal(network(), REAL_NETWORK);
});

test("a node's lease runs on its own clock: it expires and fences when that clock says, not the process's", async t => {
  const { db } = await testDatabase();
  const time = manualClock(1_000);
  const node = context({ clock: time.clock });
  const ownership = await runFor(node, async () => {
    const ownership = new Ownership(db, { node: "http://node-a", ttlMs: 60_000 });
    await ownership.start();
    return ownership;
  });
  t.after(() => runFor(node, () => ownership.close()));
  const fences: string[] = [];
  ownership.onFence(reason => fences.push(reason));
  const acquired = await runFor(node, () => ownership.acquire("agent_a"));
  assert.ok("claim" in acquired);
  // Called from outside, the node's code would read the process's clock: a test, like a simulator, calls in for the node.
  const holds = () => runFor(node, () => ownership.holds(acquired.claim));
  assert.ok(holds() && runFor(node, () => ownership.fresh()), "a claim holds right after the node registered");
  // Its watchdog, heartbeat and staleness timers are on the node's clock, not the process's.
  assert.ok(time.pending >= 3, `timers on the node's clock: ${time.pending}`);
  // A minute on the node's clock and no renewal (a stalled node): the claim stops holding at the lease's deadline,
  // 0.9 of its TTL after the last renewal began, and the watchdog fences the node, with no real time passing.
  const started = Date.now();
  runFor(node, () => time.advance(53_999));
  assert.ok(holds(), "still within the deadline");
  assert.deepEqual(fences, []);
  runFor(node, () => time.advance(2));
  assert.equal(holds(), false);
  assert.deepEqual(fences, ["heartbeat_expired"]);
  assert.ok(Date.now() - started < 1_000);
});
