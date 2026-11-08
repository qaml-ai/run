import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cluster, fakeModel, token, until } from "./cluster-helpers.ts";

const call = (base: string, path: string, body?: unknown) => fetch(base + path, {
  method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(response => response.json() as Promise<any>);
const userTexts = (body: any) => body.messages.filter((message: any) => message.role === "user").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));

test("prompts waiting to be batched when their node dies run once, as one turn, on the node that takes the agent", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  // The first turn's model call never answers on A: A dies with it, and the prompts sent meanwhile, in the queue.
  const model = await fakeModel(t, (body, index) => index === 0 ? undefined : { role: "assistant", content: `answer ${index}: ${userTexts(body).join(" + ")}` });
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const agent = (await call(a.url, "/v1/agents", { queue: { mode: "batch" } })).id as string;
  await call(a.url, `/v1/agents/${agent}/prompt`, { text: "first", requestId: "turn-1" });
  await until(() => model.bodies.length === 1, "A to call the model");
  for (const text of ["p1", "p2", "p3"]) await call(a.url, `/v1/agents/${agent}/prompt`, { text, requestId: text });
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const requests = async () => ((await call(b.url, `/v1/agents/${agent}/state`)).requests ?? []) as any[];
  const ended = async () => (await requests()).filter(request => ["turn-1", "p1", "p2", "p3"].includes(request.id) && request.state === "completed").length === 4;
  await until(ended, "every request to end on B", 60_000);
  const byId = Object.fromEntries((await requests()).map(request => [request.id, request]));
  assert.deepEqual(byId.p1.batch, ["p2", "p3"]);
  assert.equal(byId.p2.batchedInto, "p1");
  assert.equal(byId.p3.batchedInto, "p1");
  assert.match(byId.p1.outcome.result.reply, /p1 \+ p2 \+ p3$/);
  const history = (await call(b.url, `/v1/agents/${agent}/history`)).messages as any[];
  const users = history.filter(message => message.role === "user").map(message => message.requestId);
  assert.deepEqual(users, ["turn-1", "p1", "p2", "p3"], "each message once, in order");
  assert.equal(model.bodies.filter(body => userTexts(body).at(-1) === "p3").length, 1, "one model call read the batch");
});

test("a batch's turn whose node dies after its messages went in goes on on the next node: no prompt runs again, none is lost", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  // The first turn answers slowly, so the burst queues; the batch's model call never answers on A.
  const model = await fakeModel(t, async (body, index) => {
    if (index === 0) await new Promise(resolve => setTimeout(resolve, 1_500));
    return index === 1 ? undefined : { role: "assistant", content: `answer ${index}: ${userTexts(body).join(" + ")}` };
  });
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const agent = (await call(a.url, "/v1/agents", { queue: { mode: "batch" } })).id as string;
  await call(a.url, `/v1/agents/${agent}/prompt`, { text: "first", requestId: "turn-1" });
  await until(() => model.bodies.length === 1, "A to call the model");
  for (const text of ["p1", "p2", "p3"]) await call(a.url, `/v1/agents/${agent}/prompt`, { text, requestId: text });
  await until(() => model.bodies.length === 2, "A to call the model for the batch");
  assert.deepEqual(userTexts(model.bodies[1]).slice(-3), ["p1", "p2", "p3"]);
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const requests = async () => ((await call(b.url, `/v1/agents/${agent}/state`)).requests ?? []) as any[];
  const ended = async () => (await requests()).filter(request => ["turn-1", "p1", "p2", "p3"].includes(request.id) && request.state === "completed").length === 4;
  await until(ended, "every request to end on B", 60_000);
  const byId = Object.fromEntries((await requests()).map(request => [request.id, request]));
  assert.equal(byId.p1.outcome.result.error ?? null, null, JSON.stringify(byId.p1.outcome));
  assert.equal(byId.p2.batchedInto, "p1");
  assert.equal(byId.p3.batchedInto, "p1");
  const history = (await call(b.url, `/v1/agents/${agent}/history`)).messages as any[];
  assert.deepEqual(history.filter(message => message.role === "user").map(message => message.requestId), ["turn-1", "p1", "p2", "p3"], "each message once");
  assert.equal(model.bodies.length, 3, "B made the batch's call again, once; nothing ran on its own");
});
