import { test } from "node:test";
import assert from "node:assert/strict";
import { readUIMessageStream, type ChatTransport, type UIMessage, type UIMessageChunk } from "ai";
import { AgentRuntimeChatTransport } from "../clients/ai-sdk.ts";
import { createAgentHandler } from "../clients/handler.ts";
import { listen, OPERATOR, runtime, sleep } from "./runtime-server.ts";

// The transport is the AI SDK's ChatTransport, by its own types.
const _typed: (options: ConstructorParameters<typeof AgentRuntimeChatTransport>[0]) => ChatTransport<UIMessage> = options => new AgentRuntimeChatTransport(options);
void _typed;
const _chunk = (chunk: import("../clients/ai-sdk.ts").AgentUIMessageChunk): UIMessageChunk => chunk;
void _chunk;

async function streamingModel(t: { after(fn: () => Promise<void> | void): void }, script: (index: number, body: any) => object[], pace = 10) {
  let calls = 0;
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const deltas = script(calls++, JSON.parse(text));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    for (const delta of deltas) { chunk(delta); await sleep(pace); }
    chunk({}, deltas.some(delta => "tool_calls" in delta) ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  });
  return `${url}/v1`;
}
const words = (text: string) => text.split(/(?<= )/).map(word => ({ content: word }));
const callDeltas = (id: string, name: string, args: object) => [
  { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] },
  { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
];

async function setup(t: Parameters<typeof runtime>[0], script: (index: number, body: any) => object[], agent: (r: Awaited<ReturnType<typeof runtime>>) => Promise<object> = async () => ({ instructions: "You help." }),
  options: { pace?: number; stateDelayMs?: number } = {}) {
  // Tool servers on this machine are allowed (the shop below).
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: await streamingModel(t, script, options.pace), AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" });
  const handler = createAgentHandler({ apiKey: OPERATOR, url: r.base, browserToken: { url: r.base }, authorize: () => ({ userId: "alice" }), agent: await agent(r) });
  t.after(() => handler.close());
  const transport = new AgentRuntimeChatTransport({
    endpoint: "/api/agent",
    fetch: async (input, init) => {
      if (String(input) === "/api/agent") return handler(new Request("https://app.test/api/agent", init));
      // A slow read of the agent's state, while the run it asks about goes on streaming.
      if (options.stateDelayMs && String(input).endsWith("/state")) await sleep(options.stateDelayMs);
      return fetch(input, init);
    },
  });
  return { r, transport };
}
/** The assistant message a stream builds, as useChat would. */
async function reply(stream: ReadableStream<any>, message?: UIMessage) {
  let last: UIMessage | undefined;
  for await (const next of readUIMessageStream({ stream, ...(message ? { message } : {}) })) last = next;
  return last!;
}
const userMessage = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

test("useChat's transport sends the new message and streams the agent's reply, tool calls included", async t => {
  const { transport } = await setup(t, index => index === 0 ? callDeltas("call_1", "js_exec", { code: "return 6 * 7" }) : words("The answer is 42."));
  const stream = await transport.sendMessages({ trigger: "submit-message", chatId: "chat-1", messageId: undefined, messages: [userMessage("msg_00000001", "What is 6 * 7?")], abortSignal: undefined });
  const message = await reply(stream);
  assert.equal(message.role, "assistant");
  const types = message.parts.map(part => part.type).filter(type => type !== "step-start");
  assert.deepEqual(types, ["dynamic-tool", "text"]);
  const tool = message.parts.find(part => part.type === "dynamic-tool") as any;
  assert.deepEqual([tool.toolName, tool.state, tool.input, tool.output], ["js_exec", "output-available", { code: "return 6 * 7" }, 42]);
  assert.equal((message.parts.find(part => part.type === "text") as any).text, "The answer is 42.");
  // The agent has the conversation: the history reads back as UI messages, the sent message by its id.
  const history = await transport.loadMessages({ chatId: "chat-1" });
  assert.deepEqual(history.map(item => [item.id, item.role]), [["msg_00000001", "user"], [history[1].id, "assistant"]]);
  assert.deepEqual(history[1].parts.map(part => part.type), ["dynamic-tool", "text"]);
  // Another chat id is another thread: another agent, with nothing in it.
  assert.deepEqual(await transport.loadMessages({ chatId: "chat-2" }), []);
});

test("an approval the agent waits on is a tool approval request; answering it in the chat resumes the run", async t => {
  const shop = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const message = JSON.parse(text);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: object) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "shop", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: [{ name: "delete_item", description: "Delete an item", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] });
    if (message.method === "tools/call") return reply({ content: [{ type: "text", text: "deleted" }] });
    res.writeHead(202).end();
  });
  const { transport } = await setup(t, index => index === 0 ? callDeltas("call_del", "shop__delete_item", { id: "a" }) : words("Done, it is gone."),
    async r => ({ definition: (await r.call("/v1/definitions", { body: { name: "Shop", mcpServers: [{ name: "shop", url: `${shop}/mcp`, approval: { default: "always" } }] } })).json.id }));
  const first = await reply(await transport.sendMessages({ trigger: "submit-message", chatId: "c", messageId: undefined, messages: [userMessage("msg_00000002", "Delete item a")], abortSignal: undefined }));
  const tool = first.parts.find(part => part.type === "dynamic-tool") as any;
  assert.equal(tool.state, "approval-requested", JSON.stringify(first.parts));
  // useChat's addToolApprovalResponse marks the part, and sendAutomaticallyWhen sends the messages again.
  const responded = { ...first, parts: first.parts.map(part => part === tool ? { ...tool, state: "approval-responded", approval: { ...tool.approval, approved: true } } : part) } as UIMessage;
  const second = await reply(await transport.sendMessages({ trigger: "submit-message", chatId: "c", messageId: undefined, messages: [userMessage("msg_00000002", "Delete item a"), responded], abortSignal: undefined }), responded);
  const texts = second.parts.filter(part => part.type === "text").map(part => (part as any).text);
  assert.deepEqual(texts, ["Done, it is gone."]);
  const output = second.parts.find(part => part.type === "dynamic-tool") as any;
  assert.equal(output?.state, "output-available");
});

test("a question the agent asks arrives as a data part; answering it for the chat, then resuming, streams the rest", async t => {
  const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };
  const { transport } = await setup(t, (index, body) => {
    if (index === 0) return callDeltas("call_ask", "ask_user", ASK);
    const answer = JSON.parse(body.messages.filter((message: any) => message.role === "tool").at(-1).content).answers["Which region?"];
    return words(`Deploying to ${answer}.`);
  }, async r => ({ definition: (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json.id }));
  const first = await reply(await transport.sendMessages({ trigger: "submit-message", chatId: "deploys", messageId: undefined, messages: [userMessage("msg_00000003", "Deploy it")], abortSignal: undefined }));
  const asked = first.parts.find(part => part.type === "data-agent-input") as any;
  assert.equal(asked?.data.kind, "question", JSON.stringify(first.parts));
  // useChat({ id: "deploys" }): the answer goes to that chat's agent, not the default one.
  await transport.answer(asked.data, "EU", { chatId: "deploys" });
  // resumeStream() right away follows the run the answer resumed, even before it starts.
  const rest = await transport.reconnectToStream({ chatId: "deploys" });
  assert.ok(rest, "a stream to follow");
  const resumed = await reply(rest!, first);
  assert.deepEqual(resumed.parts.filter(part => part.type === "text").map(part => (part as any).text), ["Deploying to EU."]);
  const history = await transport.loadMessages({ chatId: "deploys" });
  assert.equal((history[1].parts.at(-1) as any).text, "Deploying to EU.");
  // Without a chat id it answers for the chat it last streamed; a fresh transport must be told.
  const fresh = new AgentRuntimeChatTransport({ endpoint: "/api/agent" });
  await assert.rejects(fresh.answer(asked.data, "EU"), /which chat/);
});

test("resumeStream() after the resumed run already finished still ends, with what the run said", async t => {
  const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };
  const { transport } = await setup(t, (index, body) => {
    if (index === 0) return callDeltas("call_ask", "ask_user", ASK);
    const answer = JSON.parse(body.messages.filter((message: any) => message.role === "tool").at(-1).content).answers["Which region?"];
    return words(`Deploying to ${answer}.`);
  }, async r => ({ definition: (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json.id }));
  const first = await reply(await transport.sendMessages({ trigger: "submit-message", chatId: "late", messageId: undefined, messages: [userMessage("msg_00000004", "Deploy it")], abortSignal: undefined }));
  const asked = first.parts.find(part => part.type === "data-agent-input") as any;
  await transport.answer(asked.data, "US", { chatId: "late" });
  // The run resumes, answers and ends before the page gets round to resuming its stream.
  await sleep(3000);
  const rest = await transport.reconnectToStream({ chatId: "late" });
  assert.ok(rest, "a stream to finish the message with");
  const resumed = await Promise.race([reply(rest!, first), sleep(10_000).then(() => { throw new Error("the stream never ended"); })]);
  assert.deepEqual(resumed.parts.filter(part => part.type === "text").map(part => (part as any).text), ["Deploying to US."]);
  const call = resumed.parts.find(part => part.type === "dynamic-tool") as any;
  assert.equal(call?.state, "output-available", JSON.stringify(resumed.parts));
});

test("resumeStream() joining a run mid-answer shows each word once, whatever arrived while it looked", async t => {
  const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };
  const { transport } = await setup(t, (index, body) => {
    if (index === 0) return callDeltas("call_ask", "ask_user", ASK);
    const answer = JSON.parse(body.messages.filter((message: any) => message.role === "tool").at(-1).content).answers["Which region?"];
    return words(`Deploying the release to ${answer} now.`);
  }, async r => ({ definition: (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json.id }), { pace: 120, stateDelayMs: 400 });
  const first = await reply(await transport.sendMessages({ trigger: "submit-message", chatId: "join", messageId: undefined, messages: [userMessage("msg_00000005", "Deploy it")], abortSignal: undefined }));
  const asked = first.parts.find(part => part.type === "data-agent-input") as any;
  await transport.answer(asked.data, "EU", { chatId: "join" });
  // The run is answering when the stream joins it, and goes on while the join looks up the run.
  await sleep(300);
  const rest = await transport.reconnectToStream({ chatId: "join" });
  assert.ok(rest);
  const resumed = await reply(rest!, first);
  assert.deepEqual(resumed.parts.filter(part => part.type === "text").map(part => (part as any).text), ["Deploying the release to EU now."]);
  assert.equal((resumed.parts.find(part => part.type === "dynamic-tool") as any)?.state, "output-available");
});
