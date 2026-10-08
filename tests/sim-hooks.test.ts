import { test } from "node:test";
import assert from "node:assert/strict";
import { PerformanceObserver } from "node:perf_hooks";
import { always, installAssertions, reachable, sometimes, unreachable } from "../src/assert.ts";
import { buggify, installBuggify } from "../src/buggify.ts";
import { postgresTail } from "../src/log-tail.ts";
import { testDatabase } from "./database.ts";

test("in production: buggify never fires, and a failed always or a reached unreachable logs once per message", t => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => { lines.push(line); });
  assert.equal(buggify("ownership.renew.fails"), false);
  assert.equal(buggify("ownership.renew.fails", 1), false);
  for (let i = 0; i < 3; i++) {
    always(true, "test: holds");
    always(false, "test: does not hold");
    sometimes(false, "test: never true");
    reachable("test: reached");
    unreachable("test: reached anyway");
  }
  assert.deepEqual(lines.map(line => JSON.parse(line)), [
    { type: "assert", kind: "always", assertion: "test: does not hold" },
    { type: "assert", kind: "unreachable", assertion: "test: reached anyway" },
  ]);
});

test("a simulator decides each BUGGIFY site and records every assertion: a lost append answer is repeated and counts", async t => {
  const { db } = await testDatabase();
  const fired: string[] = [];
  const recorded: string[] = [];
  installBuggify(site => { if (site !== "tail.append.lost_ack" || fired.includes(site)) return false; fired.push(site); return true; });
  installAssertions({
    always: (condition, message) => recorded.push(`always ${condition} ${message}`),
    sometimes: (condition, message) => recorded.push(`sometimes ${condition} ${message}`),
    reachable: message => recorded.push(`reachable ${message}`),
    unreachable: message => recorded.push(`unreachable ${message}`),
  });
  t.after(() => { installBuggify(undefined); installAssertions(undefined); });
  const tail = postgresTail(db, { retryMs: 5_000, unfenced: true });
  assert.equal(await tail.append("log-a", undefined, [{ seq: 1, snapshot: false, body: "one", blob: null }]), true);
  assert.deepEqual(fired, ["tail.append.lost_ack"]);
  assert.deepEqual(recorded, ["reachable a tail append was repeated while the database was unavailable"]);
  assert.deepEqual((await tail.rows("log-a")).map(row => row.body), ["one"]);
});

test("disabled, the hooks allocate nothing: millions of calls run no garbage collection", async () => {
  let collections = 0;
  const observer = new PerformanceObserver(list => { collections += list.getEntries().length; });
  observer.observe({ entryTypes: ["gc"] });
  let fired = 0;
  for (let i = 0; i < 5_000_000; i++) {
    if (buggify("bench.site")) fired++;
    always(i >= 0, "bench: always");
    sometimes(i < 0, "bench: sometimes");
    reachable("bench: reachable");
  }
  // Entries are delivered asynchronously.
  await new Promise(resolve => setTimeout(resolve, 50));
  observer.disconnect();
  assert.equal(fired, 0);
  // Nothing in the loop allocates, so it starts no collection; one the file's earlier tests left under way (a busy CI
  // machine's GC runs late) may still end during it. Allocating one small object per iteration runs about 80 here.
  assert.ok(collections <= 2, `${collections} garbage collections`);
});
