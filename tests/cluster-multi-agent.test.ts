import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cluster, fakeModel, sleep, token, until } from "./cluster-helpers.ts";

/** The model request's system text, and its last message's role. */
const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");
const toolCalls = (...calls: [string, unknown, string][]) => ({ role: "assistant", tool_calls: calls.map(([name, args, id], index) => ({ index, id, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
const toolText = (body: any) => body.messages.filter((message: any) => message.role === "tool").map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");

/** The tenant's REST API on a node. */
const api = (url: string) => async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(url + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, json: text as any }; }
};
/** A request's record once it settles, read through any node. */
const settled = async (call: ReturnType<typeof api>, agent: string, request: string, ms = 60_000) => {
  let record: any;
  await until(async () => { record = (await call(`/v1/agents/${agent}/requests/${request}?wait=5`)).json; return record?.state === "completed"; }, `request ${request} settled`, ms);
  return record;
};

test("a parent whose node dies while it waits on a child resumes on another node and collects the child's answer, which ran once", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const childAsked = Promise.withResolvers<void>();
  let childRequests = 0;
  const model = await fakeModel(t, async body => {
    if (systemText(body).includes("CHILD")) {
      // The child's first model request hangs, as if its node died mid-request; when resumed, it answers.
      if (childRequests++ === 0) { childAsked.resolve(); return undefined; }
      return { role: "assistant", content: "the child's answer" };
    }
    return body.messages.at(-1).role === "tool" ? { role: "assistant", content: `Parent got: ${toolText(body)}` } : toolCalls(["delegate", { instructions: "You are CHILD.", task: "work" }, "call_child"]);
  });
  const env = { ...model.env, AGENT_ORPHAN_SWEEP_MS: "500" };
  const a = await c.start("a", env);
  const b = await c.start("b", env);
  const onA = api(a.url), onB = api(b.url);
  const parent = (await onA("/v1/agents", { builtins: ["delegate"], delegate: { instructions: true } })).json.id;
  const accepted = await onA(`/v1/agents/${parent}/prompt`, { text: "go", requestId: "parent-turn" });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  await childAsked.promise;
  a.child.kill("SIGKILL");
  await once(a.child, "close");

  const record = await settled(onB, parent, "parent-turn", 90_000);
  assert.equal(record.error, undefined, JSON.stringify(record));
  assert.match(record.outcome.result.reply, /the child's answer/);
  assert.equal(record.resumes, 1);
  // One child, whose one request was resumed rather than sent again.
  const children = (await onB("/v1/agents")).json.filter((agent: any) => agent.parentAgentId === parent);
  assert.equal(children.length, 1);
  const child = (await onB(`/v1/agents/${children[0].id}`)).json;
  const prompts = child.requests.filter((request: any) => request.method === "prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].resumes, 1);
  assert.equal(childRequests, 2, "the child's model was asked once more, by its resumed turn");
  assert.equal(record.outcome.result.toolCalls[0].agentId, children[0].id);
});

test("parallel children on a cluster: an abort of the parent sent to any node aborts every child it waits on", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  let started = 0;
  const model = await fakeModel(t, async body => {
    if (systemText(body).includes("SLOW")) { started++; await sleep(60_000); return { role: "assistant", content: "too late" }; }
    return body.messages.at(-1).role === "tool" ? { role: "assistant", content: "after" }
      : toolCalls(["delegate", { instructions: "You are SLOW.", task: "one" }, "c1"], ["delegate", { instructions: "You are SLOW.", task: "two" }, "c2"], ["delegate", { instructions: "You are SLOW.", task: "three" }, "c3"]);
  });
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const onA = api(a.url), onB = api(b.url);
  const parent = (await onA("/v1/agents", { builtins: ["delegate"], delegate: { instructions: true } })).json.id;
  await onA(`/v1/agents/${parent}/prompt`, { text: "go", requestId: "fan-out" });
  await until(() => started === 3, "three children running at once");
  const aborted = Date.now();
  assert.equal((await onB(`/v1/agents/${parent}/abort`, {})).status, 200);
  const record = await settled(onB, parent, "fan-out");
  const children = (await onB("/v1/agents")).json.filter((agent: any) => agent.parentAgentId === parent);
  assert.equal(children.length, 3);
  for (const child of children) {
    const run = (await onB(`/v1/agents/${child.id}`)).json.requests.find((request: any) => request.method === "prompt");
    assert.equal(run.state, "completed", "each child's run ended");
    assert.ok(run.endedAt - aborted < 15_000, "at the abort, not when the model would have answered");
  }
  assert.ok(record.outcome, JSON.stringify(record));
});
