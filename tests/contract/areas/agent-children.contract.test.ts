import assert from "node:assert/strict";
import { contractTest, OPERATOR, toolCall, until } from "../support.ts";
import type { ContractFixture } from "../fixture.ts";
import { Agents } from "../../../clients/node.ts";

// GET /v1/agents/{id}/children: an agent's sub-agents as a client sees them, on both backends.
const SOURCE = "docs/guides/multi-agent.md#listing-an-agents-children";
const text = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part: any) => part.text ?? "").join("");
const roleText = (body: any) => body.messages.filter((m: any) => m.role !== "assistant" && m.role !== "tool").slice(0, 3).map(text).join("\n");
const lastUser = (body: any) => text(body.messages.findLast((m: any) => m.role === "user") ?? { content: "" });
const last = (body: any) => body.messages.at(-1);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const children = async (r: ContractFixture, agent: string, token?: string) => {
  const reply = await r.call(`/v1/agents/${agent}/children`, token ? { token } : {});
  assert.equal(reply.status, 200, reply.text);
  return reply.json.children as any[];
};

contractTest("delegation", SOURCE, "an agent's children: running with progress, ended but not yet delivered while the parent is busy, then delivered; a delegate child too, newest first", async (t, r) => {
  const parentHold = deferred(), workerHold = deferred();
  r.setModel(body => {
    const role = roleText(body), said = lastUser(body);
    if (role.includes("WORKER")) {
      if (last(body).role === "tool") return { role: "assistant", content: "worker done", wait: workerHold.promise };
      return toolCall("report_progress", { text: "halfway there" }, "progress");
    }
    if (role.includes("HELPER")) return { role: "assistant", content: "helped" };
    if (said.startsWith("<agent_notification")) return { role: "assistant", content: "heard" };
    if (said === "delegate") return last(body).role === "tool" ? { role: "assistant", content: "delegated" } : toolCall("delegate", { instructions: "You are a HELPER.", task: "help" }, "call_delegate");
    // The first turn starts the worker, then stays busy until the test lets it end.
    if (last(body).role === "tool") return { role: "assistant", content: "started", wait: parentHold.promise };
    return toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "work", name: "w" }, "call_spawn");
  });
  // Made with a key, so the SDK below can get it (and its token) by that key.
  const created = await r.call("/v1/agents", { headers: { "Idempotency-Key": "children-lead" }, body: { systemPrompt: "You are LEAD.", builtins: ["agents", "delegate"], delegate: { instructions: true } } });
  assert.equal(created.status, 201, created.text);
  const parent = created.json.id as string;
  assert.deepEqual(await children(r, parent), [], "none before any call");

  const sent = await r.call(`/v1/agents/${parent}/prompt`, { body: { text: "go" } });
  assert.equal(sent.status, 202, sent.text);
  const running = await until(async () => (await children(r, parent)).find(child => child.progress === "halfway there"), "the running worker's progress");
  assert.equal(running.name, "w");
  assert.equal(running.background, true);
  assert.equal(running.status, "running");
  assert.match(running.agentId, /^client_/);
  assert.equal(typeof running.requestId, "string");
  assert.equal(typeof running.toolCallId, "string");
  assert.equal(typeof running.startedAt, "number");
  assert.equal(typeof running.progressAt, "number");
  assert.equal(running.endedAt, undefined);
  assert.equal(running.delivered, undefined, "a running child has nothing to deliver yet");

  // The worker ends while its parent's turn still runs: its notification waits for that turn, so it is not delivered.
  workerHold.resolve();
  const ended = await until(async () => { const [child] = await children(r, parent); return child.status === "completed" && child; }, "the worker's ending");
  assert.equal(ended.delivered, false);
  assert.equal(typeof ended.endedAt, "number");
  assert.equal(ended.progress, undefined, "an ending supersedes its progress");

  parentHold.resolve();
  const delivered = await until(async () => { const [child] = await children(r, parent); return child.delivered && child; }, "the notification to land");
  assert.equal(delivered.status, "completed");
  assert.equal(delivered.agentId, running.agentId);

  // A delegate call's child is listed too (its answer is the call's result), newest first.
  assert.equal((await r.prompt(parent, "delegate")).outcome.result.reply, "delegated");
  const [helper, worker] = await children(r, parent);
  assert.deepEqual({ background: helper.background, status: helper.status, delivered: helper.delivered }, { background: false, status: "completed", delivered: true });
  assert.notEqual(helper.agentId, worker.agentId);
  assert.equal(worker.name, "w");
  assert.deepEqual(await children(r, helper.agentId), [], "the helper started no children of its own");

  // The SDKs read it with the agent's own token.
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  const handle = await agents.get("children-lead");
  assert.equal(handle.id, parent);
  const listed = await handle.children();
  assert.deepEqual(listed.map(child => child.agentId), [helper.agentId, worker.agentId]);
  await agents.close();
}, { timeout: 180_000 });

contractTest("delegation", SOURCE, "a browser token lists its agent's children only with the children scope, and never another agent's", async (t, r) => {
  r.setModel(body => roleText(body).includes("WORKER") ? { role: "assistant", content: "worked" }
    : last(body).role === "tool" || lastUser(body).startsWith("<agent_notification") ? { role: "assistant", content: "ok" }
    : toolCall("spawn_agent", { instructions: "You are a WORKER.", task: "work", name: "w" }, "call_spawn"));
  const lead = async () => (await r.call("/v1/agents", { body: { systemPrompt: "You are LEAD.", builtins: ["agents"], delegate: { instructions: true } } })).json.id as string;
  const parent = await lead(), stranger = await lead();
  await r.prompt(parent, "go");
  await until(async () => (await children(r, parent)).some(child => child.delivered), "the worker's notification");
  const token = async (agent: string, scopes: string[]) => (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: { scopes } })).json.token as string;
  const withChildren = await token(parent, ["events", "history", "children"]);
  const [child] = await children(r, parent, withChildren);
  assert.equal(child.name, "w");
  assert.equal((await r.call(`/v1/agents/${parent}/children`, { token: await token(parent, ["events", "history"]) })).status, 403);
  assert.equal((await r.call(`/v1/agents/${stranger}/children`, { token: withChildren })).status, 403);
});
