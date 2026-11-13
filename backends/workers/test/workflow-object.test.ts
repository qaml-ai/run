import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { WORKFLOW_LIMITS } from "../src/workflow-runner.ts";
import { FakeResults, harness } from "./workflow-harness.ts";
import { WorkflowEndings } from "../src/workflow-endings.ts";

const at = (h: ReturnType<typeof harness>) => h.runner.get();

test("one alarm multiplexes the sweep and the step-rate window", { timeout: 60_000 }, async () => {
  const h = harness();
  h.init({ code: `const review = await agent("review", { key: "review" }); return { review: review.answer, at: now() };` });
  await h.wake();
  assert.deepEqual(h.world.queue.map(effect => effect.key), ["review"]);
  h.world.queue.splice(0); // the agent's ending is lost until the sweep finds it
  assert.equal(at(h).status, "running");
  assert.equal(h.alarmAt, 5_000 + WORKFLOW_LIMITS.sweepMs, "the sweep, for the agent that has not landed");
  await h.next();
  assert.equal(h.runner.items().items.find(item => item.key === "review")!.status, "done", "the sweep found its ending");
  assert.equal(at(h).status, "completed");
  assert.deepEqual(at(h).result, { review: "re: review", at: h.clock });

  // The step-rate guard: past 5,000 steps in an hour, steps wait for the window to move.
  const busy = harness();
  busy.init({ code: `await agent("one"); return await agent("two");` });
  await busy.wake();
  const insert = busy.store.db.prepare("INSERT INTO workflow_steps (step, revision, at, results, issued, replayed, polls, snapshot_bytes, ms) VALUES (?, 1, ?, 0, 0, 0, 0, 0, 0)");
  busy.store.db.exec("BEGIN");
  for (let i = 0; i < WORKFLOW_LIMITS.stepsPerHour; i++) insert.run(-i - 1, busy.clock - 1_000);
  busy.store.db.exec("COMMIT");
  await busy.next();
  assert.equal(at(busy).throttledUntil, busy.clock - 1_000 + 3_600_000);
  assert.equal(busy.alarmAt, at(busy).throttledUntil, "the alarm waits for the window");
  assert.equal(busy.runner.items().items.length, 1, "no step ran");
  await busy.next();
  assert.equal(busy.runner.items().items.length, 2, "the window moved and the step ran");
  assert.equal(at(busy).throttledUntil, undefined);
});

test("pause, resume and abort", { timeout: 60_000 }, async () => {
  const h = harness();
  h.init({ code: `const a = await agent("a"); const b = await agent("b"); return [a.answer, b.answer, b.attempt];` });
  await h.wake();
  await h.runner.pause();
  assert.deepEqual([at(h).status, at(h).pauseReason], ["paused", "user"]);
  // A running child goes on and lands; no step runs while paused.
  await h.next();
  assert.equal(h.runner.items().items.length, 1);
  assert.equal(at(h).step, 1);
  await h.runner.resume();
  assert.equal(h.runner.items().items.length, 2, "resume ran the step the landing was waiting for");
  // A pause that stops children: the agent is cancelled, and re-issued under its next attempt on resume.
  await h.runner.pause({ children: "abort" });
  assert.equal(h.world.cancelled.length, 1);
  assert.equal(h.runner.items().items[1]!.status, "aborted");
  await h.runner.resume();
  assert.deepEqual(h.runner.items({ attempts: true }).items.filter(item => item.key === h.world.queue[0]?.key).map(item => [item.attempt, item.status, item.origin]), [[1, "aborted", "script"], [2, "running", "reissue"]]);
  await h.run();
  assert.deepEqual(at(h).result, ["re: a", "re: b", 2]);

  const gone = harness();
  gone.init({ code: `const a = await parallel([() => agent("a", { key: "a" }), () => agent("t", { key: "t" })]); return a;` });
  await gone.wake();
  await gone.runner.abort();
  assert.equal(at(gone).status, "aborted");
  assert.deepEqual(gone.world.cancelled, ["a:1", "t:1"]);
  assert.equal(gone.alarmAt, null);
  assert.deepEqual(gone.runner.items().items.map(item => item.status), ["aborted", "aborted"], "the journal stays readable");
  await gone.runner.land("a", 1, { ok: true, value: "late" });
  assert.equal(gone.runner.items().items[0]!.status, "aborted", "a late landing is ignored");
  await assert.rejects(gone.runner.resume(), /aborted workflow cannot be resumed/);
});

test("abort and start again: finished agent() results with the same arguments come from the owner's cache at no cost; new and opted-out ones run; a failing cache is a miss", { timeout: 60_000 }, async () => {
  const script = (files: string[], summary: string) => `
    const reviews = await parallel(${JSON.stringify(files)}, file => agent("review " + file, { key: "review:" + file }));
    const summary = await agent(${JSON.stringify(summary)} + reviews.length);
    return { reviews: reviews.map(r => r.answer), summary: summary.answer };`;
  const results = new FakeResults();
  const h = harness({ results });
  h.world.cost = 1;
  h.init({ code: script(["a", "b", "c"], "summarize ") });
  await h.wake();
  await h.run();
  assert.equal(at(h).status, "completed");
  assert.equal(at(h).spent.usd, 4);
  assert.equal(results.entries.size, 4, "every finished agent() was offered to the cache");
  assert.equal(at(h).counts.cached, undefined);

  // The owner adds a file: a new workflow; the three reviews it already paid for are reused.
  const again = harness({ results });
  again.world.cost = 1;
  again.init({ code: script(["a", "b", "c", "d"], "summarize ") });
  await again.wake();
  await again.run();
  assert.equal(at(again).status, "completed");
  assert.deepEqual((at(again).result as { reviews: string[] }).reviews, ["re: review a", "re: review b", "re: review c", "re: review d"]);
  assert.equal(at(again).spent.usd, 2, "review:d and the summary (its prompt counts four) ran and were paid for; a, b, c were not");
  assert.equal(at(again).counts.cached, 3);
  assert.deepEqual(again.runner.items().items.filter(item => item.origin === "cache").map(item => [item.key, item.cachedFrom, item.costUsd, item.status]),
    [["review:a", "wf_source:review:a:1", undefined, "done"], ["review:b", "wf_source:review:b:1", undefined, "done"], ["review:c", "wf_source:review:c:1", undefined, "done"]]);
  assert.equal([...again.world.starts.keys()].filter(key => key.startsWith("review:a")).length, 0, "no child started for a hit");
  assert.equal(again.runner.events().filter(event => event.type === "effect_cached").length, 3);

  // The replay after a hit reads the journal, not the cache: the lookups are one per issued effect.
  assert.equal(results.lookups, 4 + 5);

  // A volume the calls read changed (its version moved): nothing is found, and everything runs again.
  results.version = 1;
  const changed = harness({ results });
  changed.init({ code: script(["a"], "summarize ") });
  await changed.wake();
  await changed.run();
  assert.equal(at(changed).counts.cached, undefined);
  results.version = 0;

  // nocache: true runs again; a lookup that throws is a miss and the effect runs.
  const fresh = harness({ results });
  fresh.init({ code: `const a = await agent("review a", { key: "review:a", nocache: true }); return a.answer;` });
  await fresh.wake();
  await fresh.run();
  assert.equal(at(fresh).counts.cached, undefined);
  assert.equal(fresh.runner.items().items[0]!.origin, "script");
  results.failLookup = "the cache is down";
  const down = harness({ results });
  down.init({ code: script(["a"], "summarize ") });
  await down.wake();
  await down.run();
  assert.equal(at(down).status, "completed");
  assert.equal(at(down).counts.cached, undefined, "every effect ran");
});

test("a failed outcome never reaches the cache; only ok results are offered", { timeout: 60_000 }, async () => {
  const results = new FakeResults();
  const h = harness({ results });
  h.init({ code: `const [a, b] = await parallel([() => agent("fails", { key: "f" }), () => agent("ok", { key: "o" })]); return [a, b && b.answer];` });
  await h.wake();
  await h.run(effect => effect.key === "f" ? { ok: false, error: "boom" } : undefined);
  assert.equal(at(h).status, "completed");
  assert.deepEqual([...results.entries.values()].map(entry => entry.source), ["wf_source:o:1"]);
});
test("the budget ledger: past the cap the workflow is budget_exhausted; a refused child pauses it with payer_exhausted", { timeout: 60_000 }, async () => {
  const h = harness();
  h.world.cost = 1;
  h.init({ code: `const out = []; for (let i = 0; i < 5; i++) out.push((await agent("step " + i)).answer); return out;`, budgetUsd: 2.5 });
  await h.wake();
  await h.run();
  assert.equal(at(h).status, "budget_exhausted");
  assert.equal(at(h).spent.usd, 3);
  assert.equal(at(h).spent.cachedInputTokens, 150);
  assert.equal(h.runner.items({ status: "pending" }).items.length, 1, "the fourth agent is journaled, not started");
  assert.ok(h.runner.events().some(event => event.type === "budget_exhausted"));
  await h.runner.setBudget(10);
  await h.run();
  assert.equal(at(h).status, "completed");
  assert.equal(at(h).spent.usd, 5);
  await assert.rejects(h.runner.setBudget(-1), /at least 0/);

  const broke = harness();
  broke.init({ code: `const a = await agent("broke once"); return a.answer + " / " + a.attempt;` });
  await broke.wake();
  await broke.next();
  assert.deepEqual([at(broke).status, at(broke).pauseReason], ["paused", "payer_exhausted"]);
  assert.equal(broke.runner.items().items[0]!.status, "refused");
  await broke.runner.resume();
  await broke.run(effect => effect.attempt === 2 ? { ok: true, value: { answer: "paid", attempt: 2 } } : undefined);
  assert.equal(at(broke).result, "paid / 2", "resume re-issued it under the next attempt, and the script never saw the refusal");
});

test("a crash between steps: a new object over the same storage picks up where the last one committed", { timeout: 60_000 }, async () => {
  const db = new DatabaseSync(":memory:");
  const first = harness({ db });
  first.init({ code: `const a = await agent("a"); return (await agent("b")).answer + a.answer;` });
  await first.wake();
  const started = first.world.queue.shift()!;
  // The object is evicted. Its successor gets the landing, runs the step and starts the next agent.
  const second = harness({ db });
  second.clock = first.clock;
  await second.runner.land(started.key, started.attempt, { ok: true, value: { answer: "A" } });
  assert.deepEqual(second.world.queue.map(effect => (effect.args as { prompt: string }).prompt), ["b"], "the successor ran the step the landing was for");
  await second.run();
  assert.equal(at(second).result, "re: bA");
});

test("every Wrangler config adds WorkflowObject and WorkflowResults with their own new_sqlite_classes migrations, after the existing ones", () => {
  const configs = ["wrangler.jsonc", "wrangler.test.jsonc", "wrangler.pilot.jsonc", "wrangler.computers.test.jsonc"];
  for (const name of configs) {
    const config = new Function(`return (${readFileSync(new URL(`../${name}`, import.meta.url), "utf8")});`)() as {
      durable_objects: { bindings: { name: string; class_name: string; script_name?: string }[] };
      migrations: { tag: string; new_sqlite_classes?: string[] }[];
    };
    assert.deepEqual(config.durable_objects.bindings.filter(binding => binding.class_name === "WorkflowObject"), [{ name: "WORKFLOWS", class_name: "WorkflowObject" }], name);
    const tags = config.migrations.map(migration => migration.tag);
    assert.equal(new Set(tags).size, tags.length, `${name}: unique tags`);
    // After the existing ones: last, or followed only by the job hosts' (test configs, docs/design/job-hosts-plan.md).
    const index = tags.indexOf("workflow-object");
    assert.deepEqual(config.migrations[index], { tag: "workflow-object", new_sqlite_classes: ["WorkflowObject"] }, name);
    assert.deepEqual(tags.slice(index + 1).filter(tag => tag !== "job-hosts" && tag !== "workflow-results" && tag !== "repos"), [], `${name}: nothing but the job hosts' and the result cache's after it`);
    // The result cache (workflow-results.ts): bound, with only the pilot's job hosts after its migration.
    assert.deepEqual(config.durable_objects.bindings.filter(binding => binding.class_name === "WorkflowResults"), [{ name: "WORKFLOW_RESULTS", class_name: "WorkflowResults" }], name);
    assert.deepEqual(config.migrations.slice(tags.indexOf("workflow-results")), [
      { tag: "workflow-results", new_sqlite_classes: ["WorkflowResults"] },
      ...(name === "wrangler.pilot.jsonc" ? [{ tag: "job-hosts", new_sqlite_classes: ["JobHost", "HostJob", "JobHostRegistry"] }] : []),
      { tag: "repos", new_sqlite_classes: ["RepoDO"] },
    ], name);
    assert.equal(config.migrations.filter(migration => migration.new_sqlite_classes?.includes("WorkflowObject")).length, 1, name);
    // Every class bound locally has a migration that creates it.
    for (const binding of config.durable_objects.bindings.filter(binding => !binding.script_name))
      assert.ok(config.migrations.some(migration => migration.new_sqlite_classes?.includes(binding.class_name)), `${name}: ${binding.class_name}`);
  }
  assert.match(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /export \{ WorkflowObject \} from "\.\/workflow-object\.ts";/);
  assert.match(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /export \{ WorkflowResults \} from "\.\/workflow-results\.ts";/);
});

test("a failed start is recorded and retried by every later advance and by the alarm's sweep; the others still start", { timeout: 60_000 }, async () => {
  const h = harness();
  h.world.failStarts.set("a", 3);
  h.init({ code: `return (await parallel(["a", "b"], k => agent(k, { key: k }))).map(r => r.answer);` });
  await h.wake();
  assert.deepEqual(h.world.queue.map(effect => effect.key), ["b"], "b started; a did not");
  assert.deepEqual(h.runner.events().filter(event => event.type === "start_failed").map(event => event.data), [{ key: "a", attempt: 1, error: "could not start a" }]);
  assert.equal(h.runner.items({ status: "pending" }).items[0]!.key, "a");
  assert.equal(h.alarmAt, h.clock + WORKFLOW_LIMITS.sweepMs, "the sweep is armed while an effect is unstarted");
  await h.next(); // b lands; that advance tries a again (before and after b's step), and it fails again
  assert.equal(h.world.queue.length, 0);
  assert.equal(h.runner.events().filter(event => event.type === "start_failed").length, 1, "recorded once per effect");
  assert.equal((h.store.db.prepare("SELECT start_failures FROM workflow_effects WHERE key = 'a'").get() as { start_failures: number }).start_failures, 3);
  assert.equal(h.alarmAt, h.clock + WORKFLOW_LIMITS.sweepMs, "still armed: nothing else would ever try a");
  await h.next(); // the alarm, with no landing to prompt it
  assert.deepEqual(h.world.queue.map(effect => effect.key), ["a"]);
  await h.run();
  assert.deepEqual(at(h).result, ["re: a", "re: b"]);
});

test("effects issued in the step the script ends in are cancelled, never started", { timeout: 30_000 }, async () => {
  const h = harness();
  h.init({ code: `const first = await agent("first"); agent("forgotten", { key: "bg" }); return first.answer;` });
  await h.wake();
  await h.run();
  assert.equal(at(h).status, "completed");
  assert.deepEqual(h.runner.items().items.map(item => [item.kind, item.status]), [["agent", "done"], ["agent", "cancelled"]]);
  assert.equal(h.world.starts.has("bg:1"), false);
  assert.equal(h.alarmAt, null);
});

test("a refusal against the workflow's own budget share is budget_exhausted, not payer_exhausted", { timeout: 30_000 }, async () => {
  const h = harness();
  h.init({ code: `return (await agent("a")).answer;` });
  await h.wake();
  await h.next(() => ({ refused: "the child's share of the budget is spent", code: "budget_exhausted" }));
  assert.equal(at(h).status, "budget_exhausted");
  assert.equal(h.runner.items().items[0]!.status, "refused");
  await h.runner.resume();
  await h.run();
  assert.equal(at(h).result, "re: a");
});

test("a VM past the raw snapshot cap is not snapshotted: the next step replays", { timeout: 60_000 }, async () => {
  const h = harness();
  h.init({ code: `const big = "x".repeat(18 * 1024 * 1024); const a = await agent("a"); return a.answer + big.length;` });
  await h.wake();
  const dropped = h.runner.events().find(event => event.type === "snapshot_dropped");
  assert.ok(dropped && dropped.data.rawBytes > 16 * 1024 * 1024 && dropped.data.bytes === 0, JSON.stringify(dropped));
  await h.run();
  assert.equal(at(h).result, `re: a${18 * 1024 * 1024}`);
  assert.equal((h.store.db.prepare("SELECT replayed FROM workflow_steps WHERE step = 2").get() as { replayed: number }).replayed, 1);
});

test("an uncatchable VM error is the poll budget, the heap or a VM crash, told apart", async () => {
  const { classifyVmFailure, WORKFLOW_POLL_BUDGET, WORKFLOW_HEAP_BYTES } = await import("../codemode/workflow-vm.ts");
  assert.equal(classifyVmFailure("a promise job failed", WORKFLOW_POLL_BUDGET + 1, 0).code, "step_budget");
  assert.equal(classifyVmFailure("a promise job failed", 10, WORKFLOW_HEAP_BYTES).code, "out_of_memory");
  assert.equal(classifyVmFailure("InternalError: out of memory", 10, 1_000).code, "out_of_memory");
  assert.deepEqual(classifyVmFailure("a promise job failed", 10, 1_000), { code: "vm_crash", message: "The VM failed: a promise job failed" });
});

test("capacity: slots are acquired per agent, waiters start on a grant or a renew, the lease is renewed until close", { timeout: 60_000 }, async () => {
  const { FakeCapacity } = await import("./workflow-harness.ts");
  const capacity = new FakeCapacity(2);
  const h = harness({ capacity });
  h.init({ code: `const r = await parallel(["a", "b", "c"], k => agent(k, { key: k })); return r.map(x => x.answer);`, concurrency: 4 });
  await h.wake();
  assert.equal(capacity.calls[0], "open 4");
  assert.deepEqual(h.world.queue.map(effect => effect.key), ["a", "b"], "two slots");
  assert.deepEqual(capacity.waiting, ["c"]);
  // A landing releases a's slot; the limiter grants c and wakes the workflow, which starts it.
  await h.next();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(h.world.queue.map(effect => effect.key), ["b", "c"]);
  await h.run();
  assert.deepEqual(at(h).result, ["re: a", "re: b", "re: c"]);
  assert.equal(capacity.calls.at(-1), "close");
  assert.equal(capacity.held.size, 0);

  // A wake that never arrives: another workflow's release grants the slot, and the renew on the alarm hands it over.
  const shared = new FakeCapacity(1);
  shared.held.set("other workflow's child", "l0");
  const s2 = harness({ capacity: shared });
  s2.init({ code: `return (await agent("a", { key: "a" })).answer;` });
  await s2.wake();
  assert.deepEqual([s2.world.queue.length, shared.waiting], [0, ["a"]]);
  shared.dropWakes = true;
  await shared.seam().release("l0");
  const acquires = shared.calls.filter(call => call === "acquire a").length;
  s2.clock = s2.alarmAt!;
  await s2.runner.alarm();
  assert.deepEqual(s2.world.queue.map(effect => effect.key), ["a"], "the renew's held lease started a");
  assert.equal(shared.calls.filter(call => call === "acquire a").length, acquires, "without asking again");
  await s2.run();
  assert.equal(at(s2).result, "re: a");

  // A workflow whose only agent has not landed still renews.
  const idle = new FakeCapacity(1);
  const w = harness({ capacity: idle });
  w.init({ code: `return (await agent("a")).answer;` });
  await w.wake();
  w.world.queue.splice(0); // its ending is lost until the sweep finds it
  assert.equal(w.alarmAt, w.clock + idle.leaseMs / 2, "the renew is due");
  await w.next();
  assert.ok(idle.calls.includes("renew"));
  await w.run();
  assert.equal(at(w).status, "completed");
  assert.equal(idle.calls.at(-1), "close");

  // A refused open pauses the workflow until resumed.
  const full = new FakeCapacity(1);
  full.refuseOpen = "the tenant runs 32 workflows already";
  const r = harness({ capacity: full });
  r.init({ code: `return (await agent("a")).answer;` });
  await r.wake();
  assert.deepEqual([at(r).status, at(r).pauseReason], ["paused", "capacity_refused"]);
  full.refuseOpen = undefined;
  await r.runner.resume();
  await r.run();
  assert.equal(at(r).result, "re: a");
});

test("review fixes: the alarm survives a failing concern; the end stops running children", { timeout: 60_000 }, async () => {
  const { FakeCapacity } = await import("./workflow-harness.ts");
  // 1. A renew that throws, and an executor poll that throws: recorded, the rest of the alarm runs, the alarm is re-armed later.
  const capacity = new FakeCapacity(4);
  const h = harness({ capacity });
  h.init({ code: `const [a, b] = await parallel([() => agent("a", { key: "a" }), () => agent("b", { key: "b" })]); return a.answer;` });
  await h.wake();
  h.world.queue.splice(0); // a's and b's endings are lost; the sweep would poll them
  capacity.failRenew = "the limiter is down";
  h.world.poll = async () => { throw new Error("poll is down"); };
  h.clock = h.alarmAt!;
  await h.runner.alarm();
  assert.deepEqual(h.runner.events().filter(event => event.type === "alarm_failed").map(event => event.data.concern).sort(), ["capacity renew", "poll a", "poll b"]);
  assert.ok(h.alarmAt! >= h.clock + 30_000, "armed again, later, not lost");
  capacity.failRenew = undefined;
  capacity.refuseRenew = "workflow_not_open: the lease expired";
  h.clock = h.alarmAt!;
  await h.runner.alarm();
  assert.deepEqual([at(h).status, at(h).pauseReason], ["paused", "capacity_refused"], "a refused renew pauses rather than throws");
  assert.equal(h.alarmAt, h.clock + 60_000, "paused with its capacity given up, it tries again by itself in a minute");

  // 2. Completing with a child still running stops it, gives its slot back and closes the lease.
  const slots = new FakeCapacity(4);
  const c = harness({ capacity: slots });
  c.init({ code: `agent("slow", { key: "slow" }); return (await agent("fast", { key: "fast" })).answer;` });
  await c.wake();
  assert.deepEqual(c.world.queue.map(effect => effect.key), ["slow", "fast"]);
  const fast = c.world.queue.find(effect => effect.key === "fast")!;
  await c.runner.land(fast.key, fast.attempt, c.world.answer(fast));
  assert.equal(at(c).status, "completed");
  assert.ok(c.world.cancelled.includes("slow:1"), "the running child was cancelled");
  assert.deepEqual(at(c).counts, { done: 1, cancelled: 1 });
  assert.equal(slots.held.size, 0);
  assert.equal(slots.calls.at(-1), "close");
  assert.equal(c.alarmAt, null);
});

test("review fixes: a raised budget re-issues budget refusals; a paused workflow does not sweep", { timeout: 60_000 }, async () => {
  const b = harness();
  b.init({ code: `return (await agent("a")).answer;`, budgetUsd: 1 });
  await b.wake();
  await b.next(() => ({ refused: "the child's share is spent", code: "budget_exhausted" }));
  assert.equal(at(b).status, "budget_exhausted");
  await b.runner.setBudget(5);
  assert.equal(b.world.queue[0]?.attempt, 2, "re-issued under the next attempt");
  await b.run();
  assert.equal(at(b).result, "re: a");

  const p = harness();
  p.init({ code: `return (await agent("a")).answer;` });
  await p.wake();
  assert.ok(p.alarmAt !== null, "running: the sweep is armed");
  await p.runner.pause();
  assert.equal(p.alarmAt, null, "paused with nothing timed: no alarm every five minutes");
});

test("money: a redelivered ending is charged once, an ending after abort is charged but not delivered, a refusal's spend is charged", { timeout: 60_000 }, async () => {
  const usage = { costUsd: 0.25, model: "fake/model", inputTokens: 10, cachedInputTokens: 5, outputTokens: 2 };
  const ledger = (h: ReturnType<typeof harness>) => h.store.db.prepare("SELECT key, attempt, cost_usd FROM workflow_ledger ORDER BY key, attempt").all().map(row => ({ ...row }));

  const again = harness();
  again.init({ code: `const a = await agent("a", { key: "a" }); const b = await agent("b", { key: "b" }); return [a.answer, b.answer];` });
  await again.wake();
  const a = again.world.queue.shift()!;
  for (let i = 0; i < 3; i++) await again.runner.land(a.key, a.attempt, again.world.answer(a), usage);
  assert.deepEqual(ledger(again), [{ key: "a", attempt: 1, cost_usd: 0.25 }], "three deliveries, one charge");
  assert.equal(at(again).spent.usd, 0.25);
  assert.equal(again.runner.items().items.length, 2, "and one delivery to the script");

  const late = harness();
  late.init({ code: `return (await agent("a", { key: "a" })).answer;` });
  await late.wake();
  const child = late.world.queue.shift()!;
  await late.runner.abort();
  await late.runner.land(child.key, child.attempt, late.world.answer(child), usage);
  assert.deepEqual(ledger(late), [{ key: "a", attempt: 1, cost_usd: 0.25 }], "an aborted child's spend is charged");
  assert.deepEqual([at(late).status, late.runner.items().items[0]!.status], ["aborted", "aborted"], "but not delivered");
  // The same after completion, for a child the end cancelled.
  const done = harness();
  done.init({ code: `agent("slow", { key: "slow" }); return (await agent("fast", { key: "fast" })).answer;` });
  await done.wake();
  const [slow, fast] = done.world.queue.splice(0);
  await done.runner.land(fast!.key, fast!.attempt, done.world.answer(fast!), usage);
  await done.runner.land(slow!.key, slow!.attempt, done.world.answer(slow!), { ...usage, costUsd: 0.5 });
  assert.equal(at(done).spent.usd, 0.75);
  assert.equal(done.runner.items().items.find(item => item.key === "slow")!.status, "cancelled");

  const refused = harness();
  refused.init({ code: `return (await agent("a", { key: "a" })).answer;` });
  await refused.wake();
  const r = refused.world.queue.shift()!;
  await refused.runner.land(r.key, r.attempt, { refused: "spend limit reached", code: "payer_exhausted", spent: 0.4 });
  await refused.runner.land(r.key, r.attempt, { refused: "spend limit reached", code: "payer_exhausted", spent: 0.4 });
  assert.deepEqual(ledger(refused), [{ key: "a", attempt: 1, cost_usd: 0.4 }], "charged once");
  assert.deepEqual([at(refused).status, at(refused).pauseReason], ["paused", "payer_exhausted"]);
  assert.ok(refused.runner.events().filter(event => event.type === "payer_exhausted").length === 1);
  // A result too large to land inline is refused loudly, and still charged.
  const big = harness();
  big.init({ code: `return (await agent("a", { key: "a" })).answer;` });
  await big.wake();
  const g = big.world.queue.shift()!;
  await assert.rejects(big.runner.land(g.key, g.attempt, { ok: true, value: "x".repeat(10_000) }, usage), /must be landed as a handle/);
  assert.equal(at(big).spent.usd, 0.25);
});

test("a cancel that fails at the end is retried by the alarm, with backoff; a failed step on a landing backs off too", { timeout: 60_000 }, async () => {
  const h = harness();
  h.world.failCancels.set("slow", 1);
  h.init({ code: `agent("slow", { key: "slow" }); return (await agent("fast", { key: "fast" })).answer;` });
  await h.wake();
  const fast = h.world.queue.find(effect => effect.key === "fast")!;
  await h.runner.land(fast.key, fast.attempt, h.world.answer(fast));
  assert.equal(at(h).status, "completed");
  assert.equal(h.world.cancelled.length, 0, "the cancel failed");
  assert.deepEqual(h.runner.events().filter(event => event.type === "cancel_failed").map(event => event.data.key), ["slow"]);
  assert.equal(h.alarmAt, h.clock + 60_000, "a completed workflow keeps an alarm while a child is not cancelled, a minute out");
  h.clock = h.alarmAt!;
  await h.runner.alarm();
  assert.deepEqual(h.world.cancelled, ["slow:1"]);
  assert.equal(h.alarmAt, null, "nothing left: no alarm");

  // A step that fails when a result lands: the alarm retries it no sooner than 30 s later.
  let failures = 1;
  const s = harness({ rewrite: async request => { if (request.deliver && failures-- > 0) throw new Error("the sandbox is down"); return request; } });
  s.init({ code: `return (await agent("a")).answer;` });
  await s.wake();
  const a = s.world.queue.shift()!;
  await assert.rejects(s.runner.land(a.key, a.attempt, s.world.answer(a)), /the sandbox is down/);
  assert.equal(s.alarmAt, s.clock + 30_000);
  s.clock = s.alarmAt!;
  await s.runner.alarm();
  assert.equal(at(s).result, "re: a");
});


test("a cancel that always fails backs off per effect, doubling, and is given up after its attempts, through the object's alarm", { timeout: 60_000 }, async () => {
  const { runAlarm, alarmAt } = await import("../src/workflow-alarm.ts");
  const h = harness();
  h.world.failCancels.set("slow", 100);
  h.init({ code: `agent("slow", { key: "slow" }); return (await agent("fast", { key: "fast" })).answer;` });
  await h.wake();
  const fast = h.world.queue.find(effect => effect.key === "fast")!;
  await h.runner.land(fast.key, fast.attempt, h.world.answer(fast));
  assert.equal(at(h).status, "completed");
  // The object's alarm: runAlarm over the runner, arming as WorkflowObject.armBy does (only lowering; the alarm that
  // fired reads as none), never sooner than its floors.
  let armed: number | null = h.alarmAt;
  const fire = async () => {
    h.clock = armed!;
    armed = null;
    const result = await runAlarm({
      concerns: [["runner", async () => { if ((await h.runner.alarm()).failed) throw new Error("left for later"); }]],
      next: async () => alarmAt(h.runner.nextAlarm()), arm: async at => { if (armed === null || armed > at) armed = at; },
      log: () => {}, now: () => h.clock,
    });
    return result.failed;
  };
  const gaps: number[] = [];
  for (let i = 0; i < 20 && armed !== null; i++) {
    const before = h.clock;
    const failed = await fire();
    gaps.push(h.clock - before);
    if (armed !== null) assert.deepEqual(failed, ["runner"], "a failed cancel is a failed concern");
  }
  assert.equal(armed, null, "given up: no alarm");
  // The first try was at the landing; the alarm made the other seven, a minute apart and doubling (capped at an hour).
  assert.deepEqual(gaps, [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]);
  assert.equal(gaps.length, 7);
  assert.deepEqual(h.runner.events().filter(event => event.type.startsWith("cancel_")).map(event => event.type), ["cancel_failed", "cancel_gave_up"]);
  assert.match(h.runner.items().items.find(item => item.key === "slow")!.reason ?? "", /cancel gave up after 8 attempts/);
});

test("fail() ends a workflow once: what is out is cancelled, the executor aborted, and a later wake recovers nothing", { timeout: 30_000 }, async () => {
  const h = harness();
  let recovers = 0, aborts = 0;
  h.world.recover = async () => { recovers++; };
  h.world.abort = async () => { aborts++; };
  h.init({ code: `return (await agent("a", { key: "a" })).answer;` });
  await h.wake();
  assert.equal(recovers, 1);
  await h.runner.fail("no origin", "missing_origin");
  await h.runner.fail("no origin", "missing_origin");
  assert.deepEqual([at(h).status, at(h).error], ["failed", "no origin"]);
  assert.equal(h.runner.events().filter(event => event.type === "failed").length, 1, "once");
  assert.deepEqual(h.world.cancelled, ["a:1"]);
  assert.equal(aborts, 1);
  await h.runner.wake();
  assert.equal(recovers, 1, "an ended workflow does not recover its executor");
});

test("a fault ends the workflow failed with its code, cancelling what is out; a fixed workflow started again reuses the finished work", { timeout: 60_000 }, async () => {
  const workers = `const done = await parallel(["a", "b", "c"], name => agent("work " + name, { key: "work:" + name }));`;
  const results = new FakeResults();
  const h = harness({ results });
  h.world.cost = 1;
  // The pilot's script: three keyed workers, then an effect in parallel() without a key.
  h.init({ code: `${workers} const combined = await parallel([() => agent("combine")]); return combined;` });
  await h.wake();
  await h.run();
  assert.equal(at(h).status, "failed");
  assert.equal(at(h).fault?.code, "key_required");
  assert.equal(at(h).pauseReason, undefined);
  assert.equal(h.alarmAt, null, "an ended workflow has no alarm");
  await assert.rejects(h.runner.resume(), /cannot be resumed/);

  const fixed = harness({ results });
  fixed.world.cost = 1;
  fixed.init({ code: `${workers} const combined = await agent("combine " + done.length, { key: "combine" }); return combined.answer;` });
  await fixed.wake();
  await fixed.run();
  assert.deepEqual([at(fixed).status, at(fixed).result, at(fixed).counts.cached, at(fixed).spent.usd], ["completed", "re: combine 3", 3, 1]);
});

test("a payer's refusals: the alarm re-issues one effect as a probe, the rest follow once it gets through; a week without credit ends it", { timeout: 60_000 }, async () => {
  const h = harness();
  h.init({ code: `const r = await parallel(["a", "b", "c"], k => agent(k, { key: k })); return r.map(x => x.answer);` });
  await h.wake();
  let credit = false;
  const refuse = (effect: { key: string }) => credit ? undefined : ({ refused: `no credit for ${effect.key}`, code: "payer_exhausted" as const });
  while (h.world.queue.length) await h.next(refuse);
  assert.deepEqual([at(h).status, at(h).pauseReason], ["paused", "payer_exhausted"]);
  assert.equal(h.runner.items({ status: "refused" }).items.length, 3);
  // Still no credit: each try re-issues one, not three.
  h.clock = h.alarmAt!;
  await h.runner.alarm();
  assert.equal(h.world.queue.length, 1, "one probe");
  await h.next(refuse);
  assert.deepEqual([at(h).status, at(h).pauseReason], ["paused", "payer_exhausted"]);
  // Credit again: the probe gets through, and the others follow it.
  credit = true;
  h.clock = h.alarmAt!;
  await h.runner.alarm();
  assert.equal(h.world.queue.length, 1);
  await h.next();
  assert.equal(h.world.queue.length, 2, "the two still refused were re-issued once the probe landed");
  await h.run();
  assert.deepEqual([at(h).status, at(h).result], ["completed", ["re: a", "re: b", "re: c"]]);

  const broke = harness();
  broke.init({ code: `return (await agent("a", { key: "a" })).answer;` });
  await broke.wake();
  await broke.next(() => ({ refused: "no credit", code: "payer_exhausted" }));
  const since = broke.clock;
  for (let guard = 0; at(broke).status === "paused" && guard < 1000; guard++) {
    broke.clock = broke.alarmAt!;
    await broke.runner.alarm();
    while (broke.world.queue.length) await broke.next(() => ({ refused: "no credit", code: "payer_exhausted" }));
  }
  assert.deepEqual([at(broke).status, at(broke).fault?.code], ["failed", "payer_gave_up"]);
  assert.ok(broke.clock - since >= 7 * 86_400_000 && broke.clock - since < 8 * 86_400_000);
  assert.ok(broke.runner.items({ attempts: true, limit: 500 }).items.length < 7 * 48 + 10, "about one try per half hour, not more");
});

test("a cache hit writes no ledger row: no cost, no call; a late real ending for it is charged in full", { timeout: 60_000 }, async () => {
  const results = new FakeResults();
  const first = harness({ results });
  first.world.cost = 1;
  first.init({ code: `return (await agent("a", { key: "a" })).answer;` });
  await first.wake();
  await first.run();
  const h = harness({ results });
  h.init({ code: `return (await agent("a", { key: "a" })).answer;` });
  await h.wake();
  await h.run();
  assert.deepEqual([at(h).counts.cached, at(h).spent.usd, at(h).spent.calls], [1, 0, 0]);
  await h.runner.land("a", 1, { ok: true, value: { answer: "late" } }, { costUsd: 2 });
  assert.equal(at(h).spent.usd, 2, "charged once, by its own ending");
  assert.equal(at(h).result, "re: a", "and not delivered");
});

test("a payer's probe answered from the cache proves nothing: the next refused effect is the probe, until one runs", { timeout: 60_000 }, async () => {
  const results = new FakeResults();
  const h = harness({ results });
  h.init({ code: `const r = await parallel(["a", "b", "c"], k => agent(k, { key: k })); return r.map(x => x.answer);` });
  await h.wake();
  let credit = false;
  while (h.world.queue.length) await h.next(effect => credit ? undefined : ({ refused: `no credit for ${effect.key}`, code: "payer_exhausted" }));
  assert.deepEqual([at(h).status, at(h).pauseReason], ["paused", "payer_exhausted"]);
  // Meanwhile another workflow of the owner finished a: the alarm's probe (a) is answered from the cache.
  const other = harness({ results });
  other.init({ code: `return (await agent("a", { key: "a" })).answer;` });
  await other.wake();
  await other.run();
  credit = true;
  h.clock = h.alarmAt!;
  await h.runner.alarm();
  assert.equal(at(h).counts.cached, 1);
  assert.deepEqual(h.world.queue.map(effect => effect.key), ["b"], "b is the probe now, started for real");
  await h.run();
  assert.deepEqual([at(h).status, at(h).result], ["completed", ["re: a", "re: b", "re: c"]]);
});

test("the owner's ending is staged in the transaction that writes the status: across a crash at every point, each attempt's once", { timeout: 120_000 }, async () => {
  const run = async (crashAt?: number) => {
    let endings: WorkflowEndings | undefined;
    const h = harness({ crashAt, onStatus: (status, runner) => { if (status !== "running" && status !== "waiting") endings!.statusWritten(runner.get()); } });
    endings = new WorkflowEndings({
      storage: { sql: h.store.sql, transactionSync: h.store.transactionSync, list: async () => new Map() } as unknown as DurableObjectStorage,
      workflowId: "wf_1", owner: () => ({ kind: "agent", id: "owner" }), name: () => "two", receiveEnding: async () => ({ accepted: true }), arm: async () => {},
    });
    h.world.cost = 1;
    h.init({ code: `const a = await agent("one"); const b = await agent("two"); return [a.answer, b.answer];`, budgetUsd: 1 });
    await h.attempt(() => h.wake());
    await h.run();
    const staged = () => h.store.sql.exec("SELECT key, body FROM child_outbox ORDER BY key").toArray().map((row: any) => [row.key, JSON.parse(row.body).ending.record.status]);
    // Whatever committed, committed together: a stop is staged exactly when the status says it stopped.
    assert.equal(at(h).status, "budget_exhausted", `crash at ${crashAt}`);
    assert.deepEqual(staged(), [["wf_1_a000001:z", "stopped"]], `crash at ${crashAt}`);
    await h.attempt(() => h.runner.setBudget(10));
    await h.run();
    if (at(h).status === "budget_exhausted") { await h.attempt(() => h.runner.setBudget(10)); await h.run(); }
    assert.equal(at(h).status, "completed", `crash at ${crashAt}`);
    assert.deepEqual(staged(), [["wf_1_a000001:z", "stopped"], ["wf_1_a000002:z", "completed"]], `crash at ${crashAt}`);
    return h.ops;
  };
  const ops = await run();
  for (let crashAt = 1; crashAt <= ops; crashAt++) await run(crashAt);
});
