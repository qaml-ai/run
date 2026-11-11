import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { WORKFLOW_LIMITS } from "../src/workflow-runner.ts";
import { harness } from "./workflow-harness.ts";

const at = (h: ReturnType<typeof harness>) => h.runner.get();

test("one alarm multiplexes timers, gate expiry, the sweep and the step-rate window", { timeout: 60_000 }, async () => {
  const h = harness();
  h.init({
    code: `
      const [slept, chosen, review] = await parallel([
        () => sleep(30, { key: "nap" }),
        () => gate({ key: "ship", title: "Ship it?", recommended: "ship", expiresInSeconds: 120, onExpire: "recommended" }),
        () => agent("review", { key: "review" }),
      ]);
      const held = await gate({ key: "hold", title: "Hold?", expiresInSeconds: 60 });
      return { slept, chosen, review: review.answer, held, at: now() };`,
  });
  await h.wake();
  // The agent and the gate went to the executor; the timer is the runner's own.
  assert.deepEqual(h.world.queue.map(effect => effect.key), ["ship", "review"]);
  h.world.queue.splice(0); // the person never answers the gate; the agent's ending is lost until the sweep finds it
  assert.equal(at(h).status, "running");
  assert.equal(h.alarmAt, 5_000 + 30_000, "first the timer");
  await h.next();
  assert.equal(h.runner.items().items.find(item => item.key === "nap")!.status, "done");
  assert.equal(h.alarmAt, 5_000 + 120_000, "then the gate's expiry");
  await h.next();
  assert.equal(h.runner.items().items.find(item => item.key === "ship")!.result, "ship", "an expired gate takes its recommendation");
  assert.equal(h.alarmAt, 5_000 + 30_000 + WORKFLOW_LIMITS.sweepMs, "then the sweep (one interval after the last, at the timer), for the agent that has not landed");
  await h.next();
  assert.equal(h.runner.items().items.find(item => item.key === "review")!.status, "done", "the sweep found its ending");
  // The second gate pauses the workflow when it expires: nobody answered and there is no recommendation.
  assert.equal(at(h).status, "waiting", "only a gate is open");
  h.world.queue.splice(0);
  h.clock = h.alarmAt!;
  await h.runner.alarm();
  assert.deepEqual([at(h).status, at(h).pauseReason], ["paused", "waiting_on_gate"]);
  assert.ok(h.runner.events().some(event => event.type === "gate_expired" && event.data.took === "pause"));
  // The answer still lands, and resume goes on.
  await h.runner.land("hold", 1, { ok: true, value: "hold" });
  assert.equal(at(h).status, "paused");
  await h.runner.resume();
  assert.equal(at(h).status, "completed");
  assert.deepEqual(at(h).result, { slept: null, chosen: "ship", review: "re: review", held: "hold", at: h.clock });

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
  gone.init({ code: `const a = await parallel([() => agent("a", { key: "a" }), () => sleep(600, { key: "t" })]); return a;` });
  await gone.wake();
  await gone.runner.abort();
  assert.equal(at(gone).status, "aborted");
  assert.deepEqual(gone.world.cancelled, ["a:1"]);
  assert.equal(gone.alarmAt, null);
  assert.deepEqual(gone.runner.items().items.map(item => item.status), ["aborted", "aborted"], "the journal stays readable");
  await gone.runner.land("a", 1, { ok: true, value: "late" });
  assert.equal(gone.runner.items().items[0]!.status, "aborted", "a late landing is ignored");
  await assert.rejects(gone.runner.resume(), /aborted workflow cannot be resumed/);
});

test("an edit keeps the keys it still asks for, records its reason and key diff, and confirms large reruns", { timeout: 60_000 }, async () => {
  const script = (files: string[], summary: string) => `
    const reviews = await parallel(${JSON.stringify(files)}, file => agent("review " + file, { key: "review:" + file }));
    const summary = await agent(${JSON.stringify(summary)} + reviews.length);
    return { reviews: reviews.map(r => r.answer), summary: summary.answer };`;
  const h = harness();
  h.init({ code: script(["a", "b", "c"], "summarize ") });
  await h.wake();
  await h.run();
  assert.equal(at(h).status, "completed");
  const before = h.runner.items().items.map(item => item.key);

  const { revision } = await h.runner.edit({ code: script(["a", "b", "c", "d"], "summarize "), reason: "review d too", rerunConfirmPercent: 50 });
  assert.equal(revision, 2);
  assert.equal(at(h).status, "running");
  await h.run();
  assert.equal(at(h).status, "completed");
  assert.deepEqual((at(h).result as { reviews: string[] }).reviews, ["re: review a", "re: review b", "re: review c", "re: review d"]);
  const diff = h.runner.diff();
  assert.equal(diff.reason, "review d too");
  assert.deepEqual(diff.kept, ["review:a", "review:b", "review:c"]);
  assert.equal(diff.issued.length, 2, "review:d and the new summary (its prompt counts four reviews)");
  assert.ok(diff.issued.includes("review:d"));
  assert.deepEqual(diff.unseen, [before[3]], "the old summary is not asked for any more");
  assert.equal([...h.world.starts.keys()].filter(key => key.startsWith("review:a")).length, 1, "review:a ran once");
  assert.ok(h.runner.events().some(event => event.type === "edited" && event.data.reason === "review d too"));

  // An edit that changes every key past rerunConfirmPercent holds its new effects until a resume confirms them.
  await h.runner.edit({ code: script(["a", "b", "c", "d"], "summarize again ").replaceAll('"review:" + file', '"review2:" + file'), reason: "redo everything", rerunConfirmPercent: 25 });
  assert.deepEqual([at(h).status, at(h).pauseReason], ["paused", "confirm_rerun"]);
  assert.equal(h.world.queue.length, 0, "nothing started");
  assert.equal(h.runner.items({ status: "pending" }).items.length, 4);
  await h.runner.resume();
  await h.run();
  assert.equal(at(h).status, "completed");

  // resume({ rerun }) redoes exact keys under their next attempt.
  await h.runner.resume({ rerun: ["review2:b"] });
  await h.run();
  assert.deepEqual(h.runner.items({ attempts: true }).items.filter(item => item.key === "review2:b").map(item => [item.attempt, item.status, item.current]), [[1, "done", false], [2, "done", true]]);
  await assert.rejects(h.runner.resume({ rerun: ["nope"] }), /No effect has the key "nope"/);
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
  first.init({ code: `const a = await agent("a"); await sleep(10); return (await agent("b")).answer + a.answer;` });
  await first.wake();
  const started = first.world.queue.shift()!;
  // The object is evicted. Its successor gets the landing, then the alarm.
  const second = harness({ db });
  second.clock = first.clock;
  await second.runner.land(started.key, started.attempt, { ok: true, value: { answer: "A" } });
  assert.equal(second.alarmAt, second.clock + 10_000, "the successor armed the timer the step journaled");
  await second.next();
  await second.run();
  assert.equal(at(second).result, "re: bA");
});

test("every Wrangler config adds WorkflowObject with its own new_sqlite_classes migration, after the existing ones", () => {
  const configs = ["wrangler.jsonc", "wrangler.test.jsonc", "wrangler.pilot.jsonc", "wrangler.computers.test.jsonc"];
  for (const name of configs) {
    const config = new Function(`return (${readFileSync(new URL(`../${name}`, import.meta.url), "utf8")});`)() as {
      durable_objects: { bindings: { name: string; class_name: string; script_name?: string }[] };
      migrations: { tag: string; new_sqlite_classes?: string[] }[];
    };
    assert.deepEqual(config.durable_objects.bindings.filter(binding => binding.class_name === "WorkflowObject"), [{ name: "WORKFLOWS", class_name: "WorkflowObject" }], name);
    const tags = config.migrations.map(migration => migration.tag);
    assert.equal(new Set(tags).size, tags.length, `${name}: unique tags`);
    assert.deepEqual(config.migrations.at(-1), { tag: "workflow-object", new_sqlite_classes: ["WorkflowObject"] }, `${name}: the last migration`);
    assert.equal(config.migrations.filter(migration => migration.new_sqlite_classes?.includes("WorkflowObject")).length, 1, name);
    // Every class bound locally has a migration that creates it.
    for (const binding of config.durable_objects.bindings.filter(binding => !binding.script_name))
      assert.ok(config.migrations.some(migration => migration.new_sqlite_classes?.includes(binding.class_name)), `${name}: ${binding.class_name}`);
  }
  assert.match(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), /export \{ WorkflowObject \} from "\.\/workflow-object\.ts";/);
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
  assert.equal(h.runner.events().filter(event => event.type === "start_failed").length, 3);
  assert.equal(h.alarmAt, h.clock + WORKFLOW_LIMITS.sweepMs, "still armed: nothing else would ever try a");
  await h.next(); // the alarm, with no landing to prompt it
  assert.deepEqual(h.world.queue.map(effect => effect.key), ["a"]);
  await h.run();
  assert.deepEqual(at(h).result, ["re: a", "re: b"]);
});

test("effects issued in the step the script ends in are cancelled, never started", { timeout: 30_000 }, async () => {
  const h = harness();
  h.init({ code: `const first = await agent("first"); agent("forgotten", { key: "bg" }); sleep(60, { key: "nap" }); return first.answer;` });
  await h.wake();
  await h.run();
  assert.equal(at(h).status, "completed");
  assert.deepEqual(h.runner.items().items.map(item => [item.kind, item.status]), [["agent", "done"], ["agent", "cancelled"], ["sleep", "cancelled"]]);
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
