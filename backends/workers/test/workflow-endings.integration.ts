import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";

// A workflow's ending is a child's (workflow-endings.ts). Many workflows that end while their owner is busy wait for
// its turn as staged notices: they must not take the owner's request slots (MAX_OPEN_REQUESTS, 32), or a person's
// prompt would be refused while they wait (#824). Here an agent starts 40 workflows in one turn and stays busy; every
// one ends; a person's prompt is still taken; and once the turn ends the agent hears each workflow once.

const WORKFLOWS = 40;
const textOf = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).map((part: any) => part.text ?? "").join("\n");

test("40 workflows ending during one busy turn take no request slots, and each is heard once", { timeout: 600_000 }, async t => {
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const user = textOf(body.messages.filter((message: any) => message.role === "user").at(-1));
    const started = body.messages.filter((message: any) => message.role === "tool").length;
    let delta: any;
    if (user.includes("START_MANY") && started < WORKFLOWS)
      delta = { role: "assistant", tool_calls: [{ index: 0, id: `start-${started}`, type: "function", function: { name: "workflow_start", arguments: JSON.stringify({ script: `return ${started};`, budgetUsd: 0.5, name: `w${started}` }) } }] };
    else if (user.includes("START_MANY")) { await release.promise; delta = { role: "assistant", content: "all started" }; }
    else if (user.includes("<workflow_notification")) delta = { role: "assistant", content: `HEARD ${(user.match(/<workflow_notification /g) ?? []).length}` };
    else delta = { role: "assistant", content: "person answered" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "f", object: "chat.completion.chunk", created: 1, model: "m" };
    response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const fixture = await startFixture({ modelURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, vars: { AGENT_WORKFLOW_TENANTS: "*" } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() as any };
  };
  const until = async <T>(check: () => Promise<T | false | undefined>, description: string, timeout = 240_000): Promise<T> => {
    const deadline = Date.now() + timeout;
    for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await new Promise(resolve => setTimeout(resolve, 250)); }
  };

  const agent = (await call("/v1/agents", { codeMode: false, fileTools: false, builtins: ["delegate"], delegate: { instructions: true } })).value;
  assert.equal((await call(`/v1/agents/${agent.id}/prompt`, { text: "START_MANY" })).status < 300, true);
  const requests = async () => (await call(`/v1/agents/${agent.id}`)).value.requests as { id: string; state: string; outcome?: { result?: { reply?: string } } }[];
  // Every workflow ended, and its ending waits for the owner's busy turn (a staged notice each).
  await until(async () => (await requests()).filter(request => /^child_wf_.*_a000001$/.test(request.id)).length >= WORKFLOWS, "40 endings waiting for the busy owner");
  // A person's prompt is still taken: the waiting endings hold no request slots.
  const person = await call(`/v1/agents/${agent.id}/prompt`, { text: "PERSON" });
  assert.ok(person.status < 300, `the person's prompt: ${person.status} ${JSON.stringify(person.value)}`);
  release.resolve();
  // The owner hears every workflow once: the endings land together in a turn (or a few), never twice.
  const heard = await until(async () => {
    const all = await requests();
    const endings = all.filter(request => /^child_wf_/.test(request.id));
    return endings.length === WORKFLOWS && endings.every(request => request.state === "completed") && all.some(request => request.outcome?.result?.reply === "person answered") && all;
  }, "every ending landed and the person answered");
  const blocks = heard.map(request => /^HEARD (\d+)$/.exec(String(request.outcome?.result?.reply ?? ""))?.[1]).filter(Boolean).reduce((sum, n) => sum + Number(n), 0);
  assert.equal(blocks, WORKFLOWS, "each workflow's <workflow_notification> once");
});
