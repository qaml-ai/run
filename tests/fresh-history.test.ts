import { once } from "node:events";
import { cluster, fakeModel as clusterModel, token } from "./cluster-helpers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agents } from "../clients/node.ts";
import { OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

/** The model request's user messages, as text. */
const userTexts = (body: any) => body.messages.filter((message: any) => message.role === "user")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join(""));
const systemText = (body: any) => body.messages.filter((message: any) => message.role === "system" || message.role === "developer")
  .map((message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("")).join("\n");

for (const flag of ["", "*"]) test(`Pi context ${flag || "off"}: a prompt with history: \"none\" shows the model the system prompt as it stands and this message alone; its run is still history`, async t => {
  const r = await runtime(t, (_body, index) => ({ role: "assistant", content: `answer ${index}` }), { AGENT_PI_CONTEXT_TENANTS: flag });
  const id = (await r.call("/v1/agents", { body: { systemPrompt: "Answer in one word." } })).json.id as string;
  await r.prompt(id, "first question");
  // The instructions change between runs: a fresh run sees them as they are now.
  const configured = await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { systemPrompt: "Answer yes or no." } });
  assert.equal(configured.status, 202, configured.text);
  const fresh = await r.prompt(id, "second question", undefined, { history: "none" });
  assert.equal(fresh.outcome.result.reply, "answer 1");
  assert.deepEqual(userTexts(r.model.bodies[1]).map((text: string) => text.includes("second question")), [true], "no earlier message");
  assert.equal(r.model.bodies[1].messages.filter((message: any) => message.role === "assistant").length, 0);
  assert.match(systemText(r.model.bodies[1]), /Answer yes or no\./);
  assert.doesNotMatch(systemText(r.model.bodies[1]), /Answer in one word\./);
  // Recorded for audit, marked; and a later run without it sees the whole history, the fresh run's included.
  const history = (await r.call(`/v1/agents/${id}/history`)).json.messages;
  assert.deepEqual(history.map((message: any) => message.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(history[2].history, "none");
  assert.equal(history[0].history, undefined);
  await r.prompt(id, "third question");
  assert.deepEqual(userTexts(r.model.bodies[2]).map((text: string) => text.match(/(first|second|third) question/)?.[1]), ["first", "second", "third"]);
  // Fresh runs one after another each see only their own message, with structured output too.
  const r2 = await runtime(t, (_body, index) => index < 2 ? toolCall("final_output", { yes: index % 2 === 0 }, `call_${index}`) : { role: "assistant", content: "done" }, { AGENT_PI_CONTEXT_TENANTS: flag });
  const agent = (await r2.call("/v1/agents", { body: {} })).json.id as string;
  for (const question of ["Is water wet?", "Is fire cold?"]) {
    const record = await r2.prompt(agent, question, undefined, { history: "none", output: { schema: { type: "object", properties: { yes: { type: "boolean" } }, required: ["yes"] } } });
    assert.equal(typeof record.outcome.result.output.yes, "boolean", JSON.stringify(record));
  }
  assert.deepEqual(userTexts(r2.model.bodies[1]).map((text: string) => text.includes("Is fire cold?")), [true]);
  assert.match(systemText(r2.model.bodies[1]), /<structured_output>/);
  if (flag) {
    await r2.prompt(agent, "Review the answers");
    assert.match(userTexts(r2.model.bodies[2])[0], /Final reply:.*"yes":false/);
  }
});

test("history is \"full\" or \"none\", for a prompt that starts its own turn", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const id = (await r.call("/v1/agents", { body: {} })).json.id as string;
  for (const body of [{ text: "x", history: "some" }, { text: "x", history: "none", whileRunning: "steer" }]) {
    const refused = await r.call(`/v1/agents/${id}/prompt`, { body });
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  const viaToken = await r.call("/v1/agents", { body: {} });
  const execute = await fetch(`${r.base}/clients/${viaToken.json.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${viaToken.json.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "x1", method: "execute", params: { code: "return 1", history: "none" } }) });
  assert.equal(execute.status, 400);
  assert.match((await execute.json()).error, /history is "full" or "none", for a prompt/);
  // full is the default, the same as leaving it out.
  assert.equal((await r.prompt(id, "hello", undefined, { history: "full" })).outcome.result.reply, "ok");
});

test("the SDK: codeMode, history: \"none\" and configHash", async t => {
  const r = await runtime(t, body => body.tool_choice ? toolCall("final_output", { yes: true }) : ({ role: "assistant", content: "ok" }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const agent = await agents.upsert("yes-no", { instructions: "Answer yes or no.", codeMode: false, fileTools: false });
  const again = await agents.upsert("yes-no", { instructions: "Answer yes or no.", codeMode: false, fileTools: false });
  assert.match(agent.configHash!, /^[0-9a-f]{64}$/);
  assert.equal(again.configHash, agent.configHash);
  assert.equal((await agents.get("yes-no")).configHash, agent.configHash);
  assert.equal((await agents.runtime.listAgents()).find(entry => entry.id === agent.id)?.configHash, agent.configHash);
  await agent.run("First question");
  const run = await agent.run("Second question", { history: "none", output: { type: "object", properties: { yes: { type: "boolean" } }, required: ["yes"] } });
  assert.deepEqual(run.output, { yes: true });
  const body = r.model.bodies.at(-1);
  assert.deepEqual(userTexts(body).map((text: string) => text.includes("Second question")), [true]);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "final_output" } });
  assert.doesNotMatch(JSON.stringify(body), /js_exec/);
});

test("a schedule with history: \"none\" wakes the agent with its text alone, and one without sees the history", async t => {
  const r = await runtime(t, (_body, index) => ({ role: "assistant", content: `answer ${index}` }));
  const id = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(id, "first question");
  const fresh = await r.call(`/v1/agents/${id}/schedules`, { body: { text: "nightly triage", history: "none", inSeconds: 0 } });
  assert.equal(fresh.status, 201, fresh.text);
  assert.equal(fresh.json.history, "none");
  await until(() => r.model.bodies.some((body: any) => userTexts(body).some((text: string) => text.includes("nightly triage"))), "the fresh wake-up");
  const woken = r.model.bodies.find((body: any) => userTexts(body).some((text: string) => text.includes("nightly triage")));
  assert.deepEqual(userTexts(woken).map((text: string) => text.includes("nightly triage")), [true], "no earlier message");
  const full = await r.call(`/v1/agents/${id}/schedules`, { body: { text: "with context", history: "full", inSeconds: 0 } });
  assert.equal(full.json.history, undefined, "full is the default, not stored");
  await until(() => r.model.bodies.some((body: any) => userTexts(body).some((text: string) => text.includes("with context"))), "the full wake-up");
  const later = r.model.bodies.find((body: any) => userTexts(body).some((text: string) => text.includes("with context")));
  assert.ok(userTexts(later).some((text: string) => text.includes("first question")) && userTexts(later).some((text: string) => text.includes("nightly triage")));
  // Only a text schedule takes it, and only full or none.
  for (const body of [{ code: "return 1", history: "none", inSeconds: 60 }, { text: "x", history: "some", inSeconds: 60 }]) {
    assert.equal((await r.call(`/v1/agents/${id}/schedules`, { body })).status, 400, JSON.stringify(body));
  }
});


test("tenant allowlist preserves short-run request payloads and restores a newest-first bounded streak", async t => {
  const payloads: any[] = [];
  for (const flag of ["", "bob", "alice"]) {
    const r = await runtime(t, () => ({ role: "assistant", content: "done" }), { AGENT_PI_CONTEXT_TENANTS: flag });
    const id = (await r.call("/v1/agents", { body: {} })).json.id;
    await r.prompt(id, "pre-streak", undefined, { from: { id: "alice-user", name: "Alice" } });
    await r.prompt(id, "isolated", undefined, { history: "none", from: { id: "bob-user" } });
    payloads.push(r.model.bodies[1].messages);
    if (flag !== "alice") continue;
    for (let i = 0; i < 8; i++) await r.prompt(id, `RUN-${i}: ` + "x".repeat(12_000), undefined, { history: "none" });
    await r.prompt(id, "restore");
    const body = r.model.bodies.at(-1);
    const texts = userTexts(body);
    assert.match(texts[0], /alice-user/);
    assert.match(texts[0], /pre-streak/);
    assert.match(texts[1], /RUN-7/);
    assert.match(texts[1], /Final reply: done/);
    assert.doesNotMatch(JSON.stringify(body), /RUN-0/);
    assert.ok(texts.slice(1, -1).join("").length < 70_000, "digest stays below 20k estimated tokens");
    await r.prompt(id, "next");
    assert.equal(userTexts(r.model.bodies.at(-1)).filter((text: string) => text.includes("RUN-7")).length, 1, "restore happens once");
  }
  assert.deepEqual(payloads[1], payloads[0], "an unlisted tenant keeps the old path");
  assert.deepEqual(payloads[2], payloads[0], "the short none-run's provider payload is identical");
});

test("forks before and after a history-none checkpoint keep their own context", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "done" }), { AGENT_PI_CONTEXT_TENANTS: "*" });
  const id = (await r.call("/v1/agents", { body: {} })).json.id;
  await r.prompt(id, "BEFORE-CHECKPOINT");
  await r.prompt(id, "AFTER-CHECKPOINT", undefined, { history: "none" });
  for (const atMessage of [1, 3]) {
    const fork = await r.call(`/v1/agents/${id}/fork`, { body: { atMessage } });
    assert.equal(fork.status, 201, fork.text);
    await r.prompt(fork.json.id, "fork task");
    const texts = userTexts(r.model.bodies.at(-1)).join("\n");
    assert.match(texts, atMessage === 1 ? /BEFORE-CHECKPOINT/ : /AFTER-CHECKPOINT/);
    assert.doesNotMatch(texts, atMessage === 1 ? /AFTER-CHECKPOINT/ : /BEFORE-CHECKPOINT/);
  }
});

for (const mode of ["continue", "resume"]) test(`a none-run ${mode}s on another node and later restores the streak`, { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const ask = { questions: [{ question: "Proceed?", header: "Confirm", options: [{ label: "Yes" }, { label: "No" }] }] };
  const model = await clusterModel(t, (_body, index) => index === 1
    ? mode === "continue" ? undefined : { role: "assistant", tool_calls: [{ index: 0, id: "ask", type: "function", function: { name: "ask_user", arguments: JSON.stringify(ask) } }] }
    : { role: "assistant", content: `answer ${index}` });
  const env = { ...model.env, AGENT_PI_CONTEXT_TENANTS: "*", AGENT_DRAIN_TIMEOUT_MS: "500" };
  const a = await c.start("a", env), b = await c.start("b", env);
  const api = async (base: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, await response.clone().text());
    return await response.json() as any;
  };
  const definition = await api(a.url, "/v1/definitions", { name: "Checkpoint", builtins: ["ask_user"] });
  const agent = (await api(a.url, "/v1/agents", { definition: definition.id })).id;
  const wait = (base: string, id: string) => until(async () => { const record = await api(base, `/v1/agents/${agent}/requests/${id}`); return record.state === "completed" && record; }, "the turn to finish", 60_000);
  await wait(a.url, (await api(a.url, `/v1/agents/${agent}/prompt`, { text: "PRIVATE-PRE-STREAK" })).id);
  const request = await api(a.url, `/v1/agents/${agent}/prompt`, { text: "CURRENT-TASK", history: "none" });
  await until(() => model.bodies.length === 2, "none-run request");
  const suspended = mode === "resume" ? await wait(a.url, request.id) : undefined;
  const closed = once(a.child, "close");
  a.child.kill("SIGTERM");
  await closed;
  let id = request.id;
  if (suspended) id = (await api(b.url, `/v1/agents/${agent}/inputs/${suspended.outcome.result.inputs[0].id}`, { action: "accept", content: { answers: { "Proceed?": "Yes" } } })).request.id;
  assert.equal((await wait(b.url, id)).outcome.result.reply, "answer 2");
  assert.equal(await c.owner(agent), b.url);
  assert.match(JSON.stringify(model.bodies[2]), /CURRENT-TASK/);
  assert.doesNotMatch(JSON.stringify(model.bodies[2]), /PRIVATE-PRE-STREAK/);
  await wait(b.url, (await api(b.url, `/v1/agents/${agent}/prompt`, { text: "normal again" })).id);
  assert.match(JSON.stringify(model.bodies[3]), /PRIVATE-PRE-STREAK/);
  assert.match(JSON.stringify(model.bodies[3]), /Final reply: answer 2/);
});
