import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import {until} from "../support.ts";

const byId = async (r: Awaited<ReturnType<typeof runtime>>, agent: string, id: string) => (await r.call(`/v1/agents/${agent}/requests/${id}`)).json;
const ended = (r: Awaited<ReturnType<typeof runtime>>, agent: string, id: string) => until(async () => { const record = await byId(r, agent, id); return record.state === "completed" && record; }, `${id} to end`);
const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("");
const userTexts = (body: any) => body.messages.filter((message: any) => message.role === "user").map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));
/** A model that answers with every user message of the request, the first call slowly so that prompts queue behind it. */
const echo = (slowMs = 1_500) => (body: any, index: number) => ({ role: "assistant", content: `answer ${index}: ${userTexts(body).join(" + ")}`, ...(index === 0 ? { delayMs: slowMs } : {}) });

contractTest("messages", "tests/queue-batch.test.ts:12", "an agent whose queue batches runs the prompts that waited behind a turn as one turn, each its own message in order", async t => {
  const r = await runtime(t, echo());
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch" } } })).json.id as string;
  assert.deepEqual((await r.call(`/v1/agents/${agent}`)).json.queue, { mode: "batch" });
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "first", requestId: "turn-1" } });
  await until(() => r.model.bodies.length === 1, "the first turn's model call");
  for (const [index, text] of ["a", "b", "c"].entries()) {
    const queued = await r.call(`/v1/agents/${agent}/prompt`, { body: { text, requestId: `burst-${index}`, metadata: { n: String(index) } } });
    assert.equal(queued.status, 202, queued.text);
  }
  const lead = await ended(r, agent, "burst-0");
  assert.deepEqual(lead.batch, ["burst-1", "burst-2"]);
  assert.equal(lead.outcome.result.reply, "answer 1: first + a + b + c", "one model call read the three");
  assert.equal(lead.outcome.result.usage.responses, 1);
  for (const id of ["burst-1", "burst-2"]) {
    const member = await ended(r, agent, id);
    // It ends with the turn, with the turn's answer, naming its first prompt; the turn's usage is that prompt's alone.
    assert.equal(member.batchedInto, "burst-0");
    assert.equal(member.outcome.result.batchedInto, "burst-0");
    assert.equal(member.outcome.result.reply, lead.outcome.result.reply);
    assert.equal(member.outcome.result.usage, undefined);
    assert.equal(member.status, "completed");
  }
  await ended(r, agent, "turn-1");
  assert.equal(r.model.bodies.length, 2, "two turns for four prompts");
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.deepEqual(history.map((message: any) => [message.role, message.requestId, message.metadata?.n]), [
    ["user", "turn-1", undefined], ["assistant", undefined, undefined],
    ["user", "burst-0", "0"], ["user", "burst-1", "1"], ["user", "burst-2", "2"], ["assistant", undefined, undefined],
  ]);

  // A retry of a merged request is the same request: answered with its record, never run again.
  const again = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "b", requestId: "burst-1", metadata: { n: "1" } } });
  assert.ok([200, 202].includes(again.status), again.text);
  assert.equal(again.json.batchedInto, "burst-0");
  assert.equal(again.json.endedAt, (await byId(r, agent, "burst-1")).endedAt);
  assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "else", requestId: "burst-1" } })).status, 409);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(r.model.bodies.length, 2, "the retry started nothing");
  // Charged once: the usage counts two model responses for the four prompts.
  await until(async () => Number((await r.call("/v1/usage")).json.totals?.responses) === 2, "the usage of two responses");
  // The first Workers fixture includes a cold Wrangler build, which can exceed the baseline-derived 30s floor.
}, { timeout: 90_000 });

contractTest("messages", "tests/queue-batch.test.ts:55", "a batch ends at the first prompt that cannot join it: one with limits of its own, or for another actor", async t => {
  const r = await runtime(t, echo());
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch" } } })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "first", requestId: "turn-1" } });
  await until(() => r.model.bodies.length === 1, "the first turn's model call");
  const send = (requestId: string, extra: Record<string, unknown> = {}) => r.call(`/v1/agents/${agent}/prompt`, { body: { text: requestId, requestId, ...extra } });
  await send("p1");
  await send("p2");
  await send("limited", { runLimits: { maxResponses: 5 } });
  await send("p3", { actor: "alice" });
  await send("p4", { actor: "alice" });
  await send("p5", { actor: "bob" });
  for (const id of ["p1", "limited", "p3", "p5"]) assert.equal((await ended(r, agent, id)).batchedInto, undefined, `${id} leads a turn`);
  assert.equal((await ended(r, agent, "p2")).batchedInto, "p1");
  assert.equal((await ended(r, agent, "p4")).batchedInto, "p3");
  assert.deepEqual(r.model.bodies.slice(1).map(body => userTexts(body).slice(1).join(",")), ["p1,p2", "p1,p2,limited", "p1,p2,limited,p3,p4", "p1,p2,limited,p3,p4,p5"]);
});

contractTest("messages", "tests/queue-batch.test.ts:73", "with a window, a burst that reaches an idle agent merges too; without batching, each prompt is its own turn", async t => {
  const r = await runtime(t, (body, index) => ({ role: "assistant", content: `answer ${index}: ${userTexts(body).join(" + ")}` }));
  const windowed = (await r.call("/v1/agents", { body: { queue: { mode: "batch", windowMs: 1_000 } } })).json.id as string;
  for (const text of ["x", "y", "z"]) await r.call(`/v1/agents/${windowed}/prompt`, { body: { text, requestId: `w-${text}` } });
  for (const text of ["x", "y"]) await ended(r, windowed, `w-${text}`);
  // At most two turns for the three, the last of them merged (on Workers the window's first prompt runs alone).
  assert.notEqual((await ended(r, windowed, "w-z")).batchedInto, undefined);
  const turns = r.model.bodies.length;
  assert.ok(turns <= 2, `${turns} turns`);
  const said = (await r.call(`/v1/agents/${windowed}/history`)).json.messages.filter((message: any) => message.role === "user").map((message: any) => message.requestId);
  assert.deepEqual(said, ["w-x", "w-y", "w-z"]);

  // The default: one turn per prompt, as before.
  const plain = (await r.call("/v1/agents", { body: {} })).json.id as string;
  assert.equal((await r.call(`/v1/agents/${plain}`)).json.queue, null);
  for (const text of ["x", "y", "z"]) await r.call(`/v1/agents/${plain}/prompt`, { body: { text, requestId: `p-${text}` } });
  for (const text of ["x", "y", "z"]) assert.equal((await ended(r, plain, `p-${text}`)).batchedInto, undefined);
  assert.equal(r.model.bodies.length, turns + 3);

  // Turned off again, and refused when malformed.
  assert.equal((await r.call(`/v1/agents/${windowed}/configuration`, { method: "PATCH", body: { queue: null } })).status, 202);
  await until(async () => (await r.call(`/v1/agents/${windowed}`)).json.queue === null, "the queue setting to go");
  for (const bad of [{ mode: "all" }, { mode: "batch", windowMs: 5_000 }, { mode: "each", windowMs: 10 }, "batch"]) {
    assert.equal((await r.call("/v1/agents", { body: { queue: bad } })).status, 400, JSON.stringify(bad));
  }
});

contractTest("messages", "tests/queue-batch.test.ts:100", "a stop cancels the prompts waiting to be batched; with queued: keep they run after it, as one turn", async t => {
  const r = await runtime(t, (body, index) => ({ role: "assistant", content: `answer ${index}: ${userTexts(body).at(-1)}`, ...(userTexts(body).at(-1)?.startsWith("slow") ? { delayMs: 3_000 } : {}) }));
  const agent = (await r.call("/v1/agents", { body: { queue: { mode: "batch" } } })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "slow one", requestId: "s-1" } });
  await until(() => r.model.bodies.length === 1, "the first turn's model call");
  for (const id of ["q-1", "q-2"]) await r.call(`/v1/agents/${agent}/prompt`, { body: { text: id, requestId: id } });
  const stopped = await r.call(`/v1/agents/${agent}/abort`, { body: {} });
  assert.equal(stopped.status, 200, stopped.text);
  assert.deepEqual([...stopped.json.cancelled].sort(), ["q-1", "q-2"]);
  for (const id of ["q-1", "q-2"]) assert.equal((await ended(r, agent, id)).outcome.result.code, "cancelled");

  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "slow two", requestId: "s-2" } });
  await until(() => r.model.bodies.length === 2, "the second turn's model call");
  for (const id of ["k-1", "k-2"]) await r.call(`/v1/agents/${agent}/prompt`, { body: { text: id, requestId: id } });
  assert.equal((await r.call(`/v1/agents/${agent}/abort`, { body: { queued: "keep" } })).status, 200);
  assert.equal((await ended(r, agent, "k-2")).batchedInto, "k-1");
  const lead = await ended(r, agent, "k-1");
  assert.deepEqual(lead.batch, ["k-2"]);
  assert.equal(lead.outcome.result.reply, "answer 2: k-2");
  assert.equal(r.model.bodies.length, 3);
});
