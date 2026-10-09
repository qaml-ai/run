import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { agentNotice, AgentRuntime, nodeListener, schema, spawnAgent, tool } from "../clients/node.ts";
import { serveTools } from "../clients/server.ts";
import { OTHER_OPERATOR, OPERATOR, runtime, toolResults, until } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_PUBLIC_URL: "" };
const systemText = (body: any) => JSON.stringify(body.messages.filter((message: any) => message.role === "system" || message.role === "developer"));
const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("");
const lastUser = (body: any) => text(body.messages.findLast((message: any) => message.role === "user"));
const calls = (...made: [string, object][]) => ({ role: "assistant", tool_calls: made.map(([name, args], index) => ({ index, id: `c${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });

test("a trusted tool prepares a persistent worker and starts it as a background sub-agent; a busy worker queues the next task", async t => {
  let base = "";
  const r = await runtime(t, body => {
    const said = lastUser(body);
    if (systemText(body).includes("BOTWORKER")) return { role: "assistant", content: `worked on ${said.split(" ").at(-1)}`, delayMs: 800 };
    if (body.messages.at(-1).role === "tool") return { role: "assistant", content: toolResults(body).join(" | ") };
    if (said.startsWith("<agent_notification")) return { role: "assistant", content: "noted" };
    if (said.includes("stranger")) return calls(["app__work_on_bot", { bot: "stranger", task: "t0" }]);
    return calls(["app__work_on_bot", { bot: "a", task: "t1" }], ["app__work_on_bot", { bot: "a", task: "t2" }]);
  }, LOCAL);
  base = r.base;
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  // The app's tool: checks who is asking, upserts the bot's worker with its own key, and answers with a directive.
  const workers = new Map<string, string>();
  const stranger = (await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR })).json.id as string;
  const server = createServer(nodeListener(serveTools({
    work_on_bot: tool({
      description: "Hand a task to the bot's worker", input: schema.Object({ bot: schema.String(), task: schema.String() }),
      execute: async ({ bot, task }, { identity }) => {
        assert.equal(identity!.tenant, "alice");
        if (bot === "stranger") return spawnAgent({ agent: stranger, task });
        if (!workers.has(bot)) workers.set(bot, (await r.call("/v1/agents", { headers: { "Idempotency-Key": `bot-worker-${bot}` }, body: { name: `bot-worker-${bot}`, systemPrompt: "You are BOTWORKER.", ttlSeconds: null } })).json.id);
        return spawnAgent({ agent: workers.get(bot)!, task: `do ${task}`, name: `bot-${bot}-${task}` });
      },
    }),
  }, { runtime: base, tenant: "alice" })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  const parent = await sdk.createAgent({ systemPrompt: "You are LEAD.", mcpServers: [{ name: "app", url, auth: { type: "runtime" } }] });
  const record = await r.prompt(parent.session.id, "work on bot a");
  assert.equal(record.error, undefined, JSON.stringify(record));
  const [first, second] = record.outcome.result.reply.split(" | ").map((part: string) => { try { return JSON.parse(part); } catch { assert.fail(part); } });
  assert.equal(first.agentId, workers.get("a"));
  assert.equal(first.name, "bot-a-t1");
  assert.equal(second.agentId, workers.get("a"));
  assert.equal(record.outcome.result.toolCalls[0].agentId, workers.get("a"));
  // Both tasks run, one after the other on the one worker, and each notifies the parent.
  const notices = await until(async () => {
    const done = (await r.call(`/v1/agents/${parent.session.id}`)).json.requests.filter((request: any) => request.id.startsWith("child_") && request.state === "completed");
    return done.length === 2 && done;
  }, "two notifications");
  assert.equal(notices.length, 2);
  const history = (await r.call(`/v1/agents/${parent.session.id}/history`)).json.messages;
  const told = history.map(agentNotice).filter(Boolean);
  assert.deepEqual(told.map((notice: any) => [notice.kind, notice.status, notice.agentId]).sort(), [["notification", "completed", workers.get("a")], ["notification", "completed", workers.get("a")]]);
  assert.deepEqual(history.filter((message: any) => message.source).map((message: any) => text(message)).sort(), ["worked on t1", "worked on t2"]);
  const worker = (await r.call(`/v1/agents/${workers.get("a")}`)).json.requests.filter((request: any) => request.method === "prompt");
  assert.equal(worker.length, 2);
  assert.ok(worker[1].began >= worker[0].endedAt, "the second task waited its turn");
  assert.equal(worker[0].metadata.parentAgentId, parent.session.id);

  // Another tenant's agent is refused.
  const refused = await r.prompt(parent.session.id, "stranger");
  assert.match(refused.outcome.result.reply, /an agent this account does not have/);
  await parent.destroy();
});

test("a spawn directive from a tool without runtime auth (an attached application's) is refused", async t => {
  const r = await runtime(t, body => body.messages.at(-1).role === "tool" ? { role: "assistant", content: toolResults(body).at(-1) } : calls(["sneak", {}]));
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const target = (await r.call("/v1/agents", { body: {} })).json.id;
  const agent = await sdk.createAgent({ tools: { sneak: tool({ description: "Sneak", input: schema.Object({}), execute: () => spawnAgent({ agent: target, task: "go" }) }) } });
  const record = await agent.prompt("go");
  assert.match(JSON.stringify(record), /only a tool server with auth \\"runtime\\" may/);
  assert.equal((await r.call(`/v1/agents/${target}`)).json.requests.length, 0, "nothing was started");
  await agent.destroy();
});
