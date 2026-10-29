import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cluster, fakeModel, token, until } from "./cluster-helpers.ts";

const systemText = (body: any) => body.messages.filter((message: any) => ["system", "developer"].includes(message.role))
  .map((message: any) => JSON.stringify(message.content)).join("\n");
const api = (url: string) => async (path: string, body?: unknown, key?: string) => {
  const response = await fetch(url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json() as any;
  if (!response.ok) throw Object.assign(new Error(JSON.stringify(value)), { status: response.status });
  return value;
};

for (const ending of ["drain", "crash", "abort"] as const) {
  test(`workflow children ${ending === "abort" ? "stop on an explicit abort" : `survive a parent node ${ending} and are collected once`}`, { timeout: 90_000 }, async t => {
    const c = await cluster(t);
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    t.after(() => answer.resolve());
    let childRequests = 0;
    const model = await fakeModel(t, async body => {
      if (systemText(body).includes("CHILD")) {
        childRequests++;
        asked.resolve();
        await answer.promise;
        return { role: "assistant", content: "child answer" };
      }
      if (body.messages.at(-1).role === "tool") return { role: "assistant", content: body.messages.at(-1).content };
      return { role: "assistant", tool_calls: [{ index: 0, id: "call_workflow", type: "function", function: {
        name: "run_workflow", arguments: JSON.stringify({ script: `return await agent("work", { agent: "child" })` }),
      } }] };
    });
    const a = await c.start("a", { ...model.env, AGENT_DRAIN_TIMEOUT_MS: "500" });
    const b = await c.start("b", model.env);
    const onA = api(a.url), onB = api(b.url);
    const child = await onB("/v1/agents", { systemPrompt: "You are CHILD." }, "child");
    const parent = await onA("/v1/agents", { builtins: ["workflow"], workflow: { agents: [{ agent: "child" }] } });
    await onA(`/v1/agents/${parent.id}/prompt`, { text: "go", requestId: "turn" });
    await asked.promise;
    assert.notEqual(await c.owner(parent.id), await c.owner(child.id), "the child runs on the surviving node");

    if (ending === "abort") {
      await onA(`/v1/agents/${parent.id}/abort`, {});
      const rows = (await c.db.query("select ended_at, status from agent_children where parent = $1", [parent.id])).rows;
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].ended_at, null);
      const detail = await onB(`/v1/agents/${child.id}`);
      const request = detail.requests.find((request: any) => request.method === "prompt");
      assert.equal(request.state, "completed");
      assert.match(JSON.stringify(request.outcome), /abort/);
      answer.resolve();
      return;
    }

    const closed = once(a.child, "close");
    a.child.kill(ending === "drain" ? "SIGTERM" : "SIGKILL");
    await closed;
    await until(async () => {
      try { await onB(`/v1/agents/${parent.id}/requests/turn`); }
      catch (error) { if ([502, 503].includes((error as { status: number }).status)) return false; throw error; }
      return await c.owner(parent.id) === b.url;
    }, "the parent's run moved to the surviving node", 60_000);
    const rows = (await c.db.query("select ended_at from agent_children where parent = $1", [parent.id])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ended_at, null, "the unfinished child stays running for replay");
    answer.resolve();
    let record: any;
    await until(async () => {
      record = await onB(`/v1/agents/${parent.id}/requests/turn`);
      return record.state === "completed";
    }, "the parent's workflow finished", 30_000);
    assert.equal(record.error, undefined, JSON.stringify(record));
    assert.match(record.outcome.result.reply, /child answer/);
    assert.equal(JSON.parse(record.outcome.result.reply).status, "completed");
    assert.equal(childRequests, 1, "the child was neither restarted nor prompted again");
    assert.equal(Number((await c.db.query("select count(*) from agent_children where parent = $1", [parent.id])).rows[0].count), 1);
  });
}
