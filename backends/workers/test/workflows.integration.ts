import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";
const token = "local-integration-only-token-with-at-least-32-characters";

// The WorkflowObject class in workerd, with its migration, its real alarm and steps through the real sandbox Worker
// (exchange protocol 3). There is no public route yet: TEST_MODE's operator-only hook reaches the object.
test("a WorkflowObject runs a workflow through the sandbox Worker, its alarm and the TEST_MODE executor", { timeout: 240_000 }, async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${fixture.worker.url}/__test/workflows/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const value = await response.json() as Record<string, any>;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const until = async (path: string, done: (value: Record<string, any>) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const value = await call(path);
      if (done(value)) return value;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${path} never got there: ${JSON.stringify(await call(path))}`);
  };
  const script = (files: string[]) => `
    phase("review");
    const reviews = await parallel(${JSON.stringify(files)}, file => agent("review " + file, { key: "review:" + file }));
    await sleep(1);
    const go = await gate({ key: "ship", title: "Ship?", recommended: "ship" });
    log("decided", go);
    return { reviews: reviews.map(r => r.answer), go };`;

  const created = await call("wf1", { code: script(["a", "b"]), budgetUsd: 5 });
  assert.equal(created.revision, 1);
  // The one-second timer lands on the object's own alarm.
  const done = await until("wf1", value => value.status === "completed");
  assert.deepEqual(done.result, { reviews: ["re: review a", "re: review b"], go: "ship" });
  assert.equal(done.spent.usd, 0.03);
  const items = (await call("wf1/items")).items as { key: string; kind: string; status: string }[];
  assert.deepEqual(items.map(item => [item.key, item.kind, item.status]).sort(), [["review:a", "agent", "done"], ["review:b", "agent", "done"], ["ship", "gate", "done"], [items.find(item => item.kind === "sleep")!.key, "sleep", "done"]].sort());
  const events = (await call("wf1/events")) as unknown as { type: string }[];
  assert.deepEqual(events.map(event => event.type), ["created", "completed"]);

  const edited = await call("wf1/edit", { code: script(["a", "b", "c"]), reason: "review c too", rerunConfirmPercent: 100 });
  assert.equal(edited.revision, 2);
  await until("wf1", value => value.status === "completed");
  const diff = await call("wf1/diff");
  assert.equal(diff.reason, "review c too");
  assert.ok(diff.kept.includes("review:a") && diff.issued.includes("review:c"), JSON.stringify(diff));

  // Abort: a long timer is cancelled and the alarm goes with it.
  await call("wf2", { code: `await sleep(3600); return 1;` });
  assert.equal((await call("wf2")).status, "waiting");
  const aborted = await call("wf2/abort", {});
  assert.equal(aborted.status, "aborted");
  const refused = await fetch(`${fixture.worker.url}/__test/workflows/wf2/resume`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /aborted workflow cannot be resumed/);
});
