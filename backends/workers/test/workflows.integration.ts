import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";
const token = "local-integration-only-token-with-at-least-32-characters";

// The WorkflowObject class in workerd, with its migration, its real alarm and steps through the real sandbox Worker
// (exchange protocol 3). There is no public route yet: TEST_MODE's operator-only hook reaches the object.
test("a WorkflowObject runs a workflow through the sandbox Worker, its alarm and the TEST_MODE executor", { timeout: 240_000 }, async (t) => {
  const fixture = await startFixture({ vars: { TEST_WORKFLOW_EXECUTOR: "stub" } });
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

  await call("wf1", { code: script(["a", "b"]), budgetUsd: 5 });
  // The one-second timer lands on the object's own alarm.
  const done = await until("wf1", value => value.status === "completed");
  assert.deepEqual(done.result, { reviews: ["re: review a", "re: review b"], go: "ship" });
  assert.equal(done.spent.usd, 0.03);
  const items = (await call("wf1/items")).items as { key: string; kind: string; status: string }[];
  assert.deepEqual(items.map(item => [item.key, item.kind, item.status]).sort(), [["review:a", "agent", "done"], ["review:b", "agent", "done"], ["ship", "gate", "done"], [items.find(item => item.kind === "sleep")!.key, "sleep", "done"]].sort());
  const events = (await call("wf1/events")) as unknown as { type: string }[];
  assert.deepEqual(events.map(event => event.type), ["created", "completed"]);

  // No edit: to change it, start a new one. The reviews wf1 finished come from the owner's result cache, at no cost.
  await call("wf3", { code: script(["a", "b", "c"]), budgetUsd: 5 });
  const redone = await until("wf3", value => value.status === "completed");
  assert.deepEqual(redone.result.reviews, ["re: review a", "re: review b", "re: review c"]);
  assert.equal(redone.counts.cached, 2, JSON.stringify(redone.counts));
  assert.ok(redone.spent.usd < done.spent.usd, `only review:c was paid for: ${redone.spent.usd}`);
  const reused = ((await call("wf3/items")).items as { key: string; origin: string; cachedFrom?: string; costUsd?: number }[]).filter(item => item.origin === "cache");
  assert.deepEqual(reused.map(item => item.key).sort(), ["review:a", "review:b"]);
  assert.ok(reused.every(item => /review:[ab]:1$/.test(item.cachedFrom ?? "") && !item.costUsd), JSON.stringify(reused));

  // Abort: a long timer is cancelled and the alarm goes with it.
  await call("wf2", { code: `await sleep(3600); return 1;` });
  assert.equal((await call("wf2")).status, "waiting");
  const aborted = await call("wf2/abort", {});
  assert.equal(aborted.status, "aborted");
  const refused = await fetch(`${fixture.worker.url}/__test/workflows/wf2/resume`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /aborted workflow cannot be resumed/);
});

test("a script with a syntax error is refused at start; a workflow with no origin to configure its agents fails once", { timeout: 240_000 }, async (t) => {
  // No AGENT_PUBLIC_URL, and the TEST_MODE hook stores no start origin: a workflow as one started before #818 was.
  const fixture = await startFixture({ noPublicUrl: true });
  t.after(() => fixture.stop());
  const call = (path: string, body?: unknown) => fetch(`${fixture.worker.url}/__test/workflows/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const refused = await call("wf_syntax", { code: `log("a");\nlog("b" "c");` });
  assert.equal(refused.ok, false);
  assert.match(((await refused.json()) as { error: string }).error, /^script_error: SyntaxError at line 2, column 9/);
  assert.equal(((await (await call("wf_syntax")).json()) as { refused?: unknown; error?: string }).error !== undefined, true, "nothing was created");

  const created = await call("wf_no_origin", { code: `return (await agent("review the plan")).answer;` });
  assert.equal(created.status, 201, await created.clone().text());
  let summary: { status: string; error?: string } = await created.json();
  for (let i = 0; i < 50 && summary.status !== "failed"; i++) {
    await new Promise(resolve => setTimeout(resolve, 200));
    summary = await (await call("wf_no_origin/wake", {})).json();
  }
  assert.equal(summary.status, "failed");
  assert.match(summary.error ?? "", /AGENT_PUBLIC_URL is not set/);
  const events = (await (await call("wf_no_origin/events")).json()) as { type: string; data?: { code?: string } }[];
  assert.equal(events.filter(event => event.type === "failed" && event.data?.code === "missing_origin").length, 1);
  // Woken again, it stays failed, once.
  await call("wf_no_origin/alarm", {});
  const again = (await (await call("wf_no_origin/events")).json()) as { type: string }[];
  assert.equal(again.filter(event => event.type === "failed").length, 1);
});
