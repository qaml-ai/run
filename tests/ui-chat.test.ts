import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { answerValue, createAgentChat, projectMessages, type AssistantChatMessage, type ChatInput, type ChatSnapshot, type ProjectInput, type ProjectMemo, type ToolPart } from "../clients/chat.ts";
import { createAgentHandler } from "../clients/handler.ts";
import { listen, OPERATOR, runtime, sleep, until } from "./runtime-server.ts";

// ---------------------------------------------------------------------------------------------
// The projection

const user = (text: string, timestamp: number, extra: object = {}) => ({ role: "user", content: text, timestamp, ...extra }) as ProjectInput["messages"][number];
const assistant = (content: object[], timestamp: number, extra: object = {}) => ({ role: "assistant", content, provider: "p", model: "m", stopReason: "stop", timestamp, ...extra }) as any;
const toolResult = (toolCallId: string, text: string, timestamp: number, extra: object = {}) => ({ role: "toolResult", toolCallId, toolName: "t", content: [{ type: "text", text }], isError: false, timestamp, ...extra }) as any;
const project = (messages: any[], extra: Partial<ProjectInput> = {}, memo?: ProjectMemo) =>
  projectMessages({ messages, indexes: messages.map((_, index) => index), partial: null, running: false, ...extra }, memo);

test("a turn is one assistant message; tool results fold into their calls; a user message keeps the id it was sent with", () => {
  const messages = [
    user("hi", 1, { requestId: "cm_1", from: { id: "alice", name: "Alice" }, metadata: { page: "/x" } }),
    assistant([{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "c1", name: "js_exec", arguments: { code: "return 1" } }], 2, { stopReason: "toolUse" }),
    toolResult("c1", '{"n":1}', 3),
    assistant([{ type: "text", text: "Done." }], 4),
  ];
  const [first, turn] = project(messages);
  assert.equal(first.id, "cm_1");
  assert.equal(first.role, "user");
  assert.deepEqual(first.role === "user" && [first.text, first.from?.name, first.metadata?.page, first.status], ["hi", "Alice", "/x", "sent"]);
  assert.equal(turn.id, "t:1");
  const parts = (turn as AssistantChatMessage).parts;
  assert.deepEqual(parts.map(part => part.type), ["reasoning", "tool", "text"]);
  const call = parts[1] as ToolPart;
  assert.deepEqual([call.id, call.name, call.state, call.result?.data, call.args.code], ["c1", "js_exec", "done", { n: 1 }, "return 1"]);
  assert.equal((turn as AssistantChatMessage).stopReason, "stop");
  // Without a requestId, a user message is known by its index.
  assert.equal(project([user("x", 1)])[0].id, "m:0");
});

test("a call waiting on a person carries its input; errors, stops and presented files show as such", () => {
  const input = { id: "inp_1", toolCallId: "c1", kind: "question", message: "Which?", detail: { questions: [{ question: "Which?", options: [], multiSelect: false, allowOther: true }] }, answering: false } as unknown as ChatInput;
  const waiting = project([
    user("go", 1),
    assistant([{ type: "toolCall", id: "c1", name: "ask_user", arguments: {} }], 2, { stopReason: "toolUse" }),
    toolResult("c1", "Waiting for the user's input.", 3, { details: { inputRequired: true } }),
  ], { inputs: [input] });
  const call = (waiting[1] as AssistantChatMessage).parts[0] as ToolPart;
  assert.equal(call.state, "input_required");
  assert.equal(call.input, input);
  assert.equal(call.result, undefined);

  const [, failed] = project([user("go", 1), assistant([{ type: "text", text: "Part" }], 2, { stopReason: "error", errorMessage: "overloaded" })]);
  assert.deepEqual([(failed as AssistantChatMessage).stopReason, (failed as AssistantChatMessage).error], ["error", "overloaded"]);
  const [, stopped] = project([user("go", 1), assistant([{ type: "text", text: "Part" }], 2, { stopReason: "aborted" })]);
  assert.equal((stopped as AssistantChatMessage).stopReason, "aborted");

  const presented = project([
    user("chart", 1),
    assistant([{ type: "toolCall", id: "c2", name: "present_file", arguments: { path: "/workspace/chart.png", caption: "Sales" } }], 2, { stopReason: "toolUse" }),
    toolResult("c2", JSON.stringify({ path: "/workspace/chart.png", version: 1, size: 10, contentType: "image/png", presented: true }), 3),
  ], { files: new Map([["/workspace/chart.png", "https://runtime/v1/links/x/chart.png"]]) });
  assert.deepEqual((presented[1] as AssistantChatMessage).parts[0], {
    type: "file", id: "c2:file", toolCallId: "c2", path: "/workspace/chart.png", name: "chart.png", contentType: "image/png", size: 10, caption: "Sales", url: "https://runtime/v1/links/x/chart.png",
  });
});

test("while a message is on its way, the running turn does not take the last answer, and it follows the message", () => {
  const history = [user("q1", 1, { requestId: "cm_a" }), assistant([{ type: "text", text: "a1" }], 2)];
  const local = [{ id: "cm_b", text: "q2", createdAt: 5, status: "sent" as const }];
  // A run started before its message arrived: no streaming turn yet, and the sent bubble last.
  const early = project(history, { running: true, local });
  assert.deepEqual(early.map(message => message.id), ["cm_a", "t:1", "cm_b"]);
  assert.equal((early[1] as AssistantChatMessage).streaming, false);
  // The message arrives: it keeps its id, and the turn streams after it, at the index its first message takes.
  const arrived = [...history, user("q2", 5, { requestId: "cm_b" })];
  const partial = assistant([{ type: "text", text: "a" }], 6);
  const streaming = project(arrived, { running: true, partial, local });
  assert.deepEqual(streaming.map(message => message.id), ["cm_a", "t:1", "cm_b", "t:3"]);
  assert.equal((streaming[3] as AssistantChatMessage).streaming, true);
  const settled = project([...arrived, assistant([{ type: "text", text: "a2" }], 7)]);
  assert.equal(settled[3].id, "t:3");
  // A turn that called tools goes on as the same message.
  const midTurn = [user("q", 1), assistant([{ type: "toolCall", id: "c1", name: "t", arguments: {} }], 2, { stopReason: "toolUse" }), toolResult("c1", "ok", 3)];
  const going = project(midTurn, { running: true, partial: assistant([{ type: "text", text: "more" }], 4) });
  assert.deepEqual(going.map(message => message.id), ["m:0", "t:1"]);
  assert.deepEqual((going[1] as AssistantChatMessage).parts.map(part => part.type), ["tool", "text"]);
});

test("messages and parts that did not change are the same objects; a streamed delta rebuilds only what it changed", () => {
  const memo: ProjectMemo = new Map();
  const call = { type: "toolCall", id: "c1", name: "js_exec", arguments: { code: "1" } };
  const settled = [user("q", 1, { requestId: "cm_1" }), assistant([{ type: "text", text: "a" }], 2), user("q2", 3, { requestId: "cm_2" }), assistant([call], 4, { stopReason: "toolUse" })];
  const a = project(settled, {}, memo);
  const b = project(settled, {}, memo);
  assert.ok(a.every((message, at) => message === b[at]), "the same objects again");
  // A result arriving rebuilds only its turn; its call part changes, the rest stays.
  const withResult = [...settled, toolResult("c1", "1", 5)];
  const c = project(withResult, {}, memo);
  assert.equal(c[0], a[0]);
  assert.equal(c[1], a[1]);
  assert.notEqual(c[3], a[3]);
  // Streaming text into that turn: earlier parts keep their objects, and so do other messages.
  const text1 = assistant([{ type: "text", text: "He" }], 6);
  const d = project(withResult, { running: true, partial: text1 }, memo);
  const text2 = { ...text1, content: [{ type: "text", text: "Hello" }] };
  const e = project(withResult, { running: true, partial: text2 }, memo);
  assert.equal(e[0], a[0]);
  assert.equal((e[3] as AssistantChatMessage).parts[0], (d[3] as AssistantChatMessage).parts[0], "the finished call part stays");
  assert.notEqual((e[3] as AssistantChatMessage).parts[1], (d[3] as AssistantChatMessage).parts[1]);
  assert.deepEqual((e[3] as AssistantChatMessage).parts[1], { type: "text", id: "t:3:1", text: "Hello", streaming: true });
  // Once the streamed message settles, its parts keep their ids.
  const f = project([...withResult, assistant([{ type: "text", text: "Hello" }], 6)], {}, memo);
  assert.equal((f[3] as AssistantChatMessage).parts[1].id, "t:3:1");
  assert.equal((f[3] as AssistantChatMessage).parts[0], (d[3] as AssistantChatMessage).parts[0]);
});

test("answerValue turns plain values into answers", () => {
  assert.deepEqual(answerValue({ kind: "approval", detail: {} }, true), { action: "accept" });
  assert.deepEqual(answerValue({ kind: "approval", detail: {} }, false), { action: "decline" });
  assert.deepEqual(answerValue({ kind: "question", detail: { questions: [{ question: "Which?", options: [], multiSelect: false, allowOther: true }] } }, "EU"), { action: "accept", content: { answers: { "Which?": "EU" } } });
  assert.deepEqual(answerValue({ kind: "form", detail: {} }, { a: 1 }), { action: "accept", content: { a: 1 } });
  assert.throws(() => answerValue({ kind: "approval", detail: {} }, "yes"));
  assert.throws(() => answerValue({ kind: "question", detail: { questions: [{ question: "A", options: [], multiSelect: false, allowOther: true }, { question: "B", options: [], multiSelect: false, allowOther: true }] } }, "x"));
});

test("the chat store is browser code: it bundles for a browser with nothing from Node, and small", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../clients/chat.ts", import.meta.url))], bundle: true, minify: true, platform: "browser", format: "esm", write: false, logLevel: "silent" });
  assert.equal(result.errors.length, 0);
  const { gzipSync } = await import("node:zlib");
  const gzipped = gzipSync(result.outputFiles[0].contents).length;
  assert.ok(gzipped < 9 * 1024, `the store and watcher are ${gzipped} bytes gzipped`);
});

// ---------------------------------------------------------------------------------------------
// The store, through the handler, against a runtime

/** A model that streams each answer in small pieces. */
async function streamingModel(t: { after(fn: () => Promise<void> | void): void }, script: (index: number, body: any) => object[]) {
  let calls = 0;
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const deltas = script(calls++, JSON.parse(text));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    for (const delta of deltas) { chunk(delta); await sleep(10); }
    chunk({}, deltas.some(delta => "tool_calls" in delta) ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  });
  return `${url}/v1`;
}
const words = (text: string) => text.split(/(?<= )/).map(word => ({ content: word }));
const toolCallDeltas = (id: string, name: string, args: object) => {
  const json = JSON.stringify(args);
  return [{ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] },
    ...[json.slice(0, 5), json.slice(5, 12), json.slice(12)].map(piece => ({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))];
};

type Runtime = Awaited<ReturnType<typeof runtime>>;
async function setup(t: Parameters<typeof runtime>[0], script: (index: number, body: any) => object[], agent: (r: Runtime) => Promise<object> = async () => ({ instructions: "You help." })) {
  const model = await streamingModel(t, script);
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model });
  const handler = createAgentHandler({
    apiKey: OPERATOR, url: r.base, browserToken: { url: r.base },
    authorize: () => ({ userId: "alice", name: "Alice" }),
    agent: await agent(r),
  });
  t.after(() => handler.close());
  const doFetch: typeof fetch = async (input, init) => String(input) === "/api/agent" ? handler(new Request("https://app.test/api/agent", init)) : fetch(input, init);
  const snapshots: ChatSnapshot[] = [];
  const chat = createAgentChat({ endpoint: "/api/agent", fetch: doFetch });
  t.after(() => chat.destroy());
  chat.subscribe(() => snapshots.push(chat.getSnapshot()));
  await until(() => chat.getSnapshot().connected, "the chat to connect");
  return { r, chat, snapshots };
}

test("a sent message shows at once, keeps its id when it arrives, and the reply streams into one message", async t => {
  const { chat, snapshots } = await setup(t, index => index === 0 ? toolCallDeltas("call_1", "js_exec", { code: "return 6 * 7" }) : words("The answer is 42."));
  assert.equal(chat.getSnapshot().status, "ready");
  const sending = chat.send("What is 6 * 7?");
  const shown = chat.getSnapshot();
  assert.equal(shown.messages.length, 1);
  assert.equal(shown.messages[0].role, "user");
  assert.equal((shown.messages[0] as { status: string }).status, "sending");
  assert.equal(shown.status, "submitted");
  const { id } = await sending;
  assert.equal(shown.messages[0].id, id);
  await until(() => chat.getSnapshot().status === "ready" && chat.getSnapshot().messages.length === 2, "the reply", 20_000);

  const final = chat.getSnapshot();
  assert.deepEqual(final.messages.map(message => message.id), [id, final.messages[1].id]);
  const turn = final.messages[1] as AssistantChatMessage;
  assert.deepEqual(turn.parts.map(part => part.type), ["tool", "text"]);
  assert.equal((turn.parts[0] as ToolPart).state, "done");
  assert.equal((turn.parts[0] as ToolPart).result?.data, 42);
  assert.equal(turn.parts[1].type === "text" && turn.parts[1].text, "The answer is 42.");
  assert.equal(turn.streaming, false);

  // On screen: the user's row never changed its id, the reply was one row from its first token, it streamed,
  // and the tool call's arguments were shown as they were written.
  const rows = snapshots.map(snapshot => snapshot.messages.map(message => message.id).join(","));
  for (const row of rows) assert.ok(row === id || row === `${id},${turn.id}` || row === "", `rows: ${row}`);
  assert.ok(snapshots.some(snapshot => (snapshot.messages[1] as AssistantChatMessage | undefined)?.streaming), "it streamed");
  assert.ok(snapshots.some(snapshot => ((snapshot.messages[1] as AssistantChatMessage | undefined)?.parts[0] as ToolPart | undefined)?.state === "input_streaming"), "arguments streamed");
  assert.ok(snapshots.some(snapshot => snapshot.status === "streaming"));
  // The status goes submitted, streaming, ready: never back to waiting between the tool call and the answer.
  const statuses = snapshots.map(snapshot => snapshot.status).filter((status, at, all) => status !== all[at - 1]);
  assert.deepEqual(statuses.slice(statuses.indexOf("submitted")), ["submitted", "streaming", "ready"]);
  // Once settled, a new snapshot for the same state is the same object.
  assert.equal(chat.getSnapshot(), final);
});

test("an agent's question shows on its call, is answered through the store, and the turn goes on", async t => {
  const ASK = { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU" }, { label: "US" }] }] };
  const model = (index: number, body: any) => {
    if (index === 0) return toolCallDeltas("call_ask", "ask_user", ASK);
    const answer = JSON.parse(body.messages.filter((message: any) => message.role === "tool").at(-1).content).answers["Which region?"];
    return words(`Deploying to ${answer}.`);
  };
  const { chat } = await setup(t, model, async r => ({ definition: (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json.id }));
  await chat.send("Deploy it");
  await until(() => chat.getSnapshot().status === "input_required", "the question", 20_000);
  const snapshot = chat.getSnapshot();
  assert.equal(snapshot.inputs.length, 1);
  const call = (snapshot.messages[1] as AssistantChatMessage).parts.find(part => part.type === "tool") as ToolPart;
  assert.equal(call.state, "input_required");
  assert.equal(call.input?.id, snapshot.inputs[0].id);
  await chat.answer(snapshot.inputs[0], "EU");
  await until(() => chat.getSnapshot().status === "ready" && chat.getSnapshot().inputs.length === 0 && (chat.getSnapshot().messages[1] as AssistantChatMessage).parts.some(part => part.type === "text"), "the resumed turn", 20_000);
  const turn = chat.getSnapshot().messages[1] as AssistantChatMessage;
  assert.equal((turn.parts[0] as ToolPart).state, "done");
  assert.equal(turn.parts.at(-1)!.type === "text" && (turn.parts.at(-1) as { text: string }).text, "Deploying to EU.");
});

test("a failed send stays with its error and can be retried; a refused token stops the chat with an error", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  let refuse = true;
  const handler = createAgentHandler({ apiKey: OPERATOR, url: r.base, browserToken: { url: r.base }, authorize: () => ({ userId: "alice" }), onSend: () => { if (refuse) throw new Response(JSON.stringify({ error: { code: "quota", message: "Out of messages" } }), { status: 429 }); } });
  t.after(() => handler.close());
  const doFetch: typeof fetch = async (input, init) => String(input) === "/api/agent" ? handler(new Request("https://app.test/api/agent", init)) : fetch(input, init);
  const chat = createAgentChat({ endpoint: "/api/agent", fetch: doFetch });
  t.after(() => chat.destroy());
  await until(() => chat.getSnapshot().connected, "the chat to connect");
  const { id } = await chat.send("hi");
  const failed = chat.getSnapshot();
  assert.equal((failed.messages[0] as { status: string }).status, "failed");
  assert.equal(failed.error?.code, "quota");
  assert.equal(failed.status, "ready");
  refuse = false;
  await chat.retry(id);
  await until(() => chat.getSnapshot().messages.length === 2 && chat.getSnapshot().status === "ready", "the reply");
  assert.equal(chat.getSnapshot().messages[0].id, id);
  assert.equal(chat.getSnapshot().error, null);

  const nobody = createAgentHandler({ apiKey: OPERATOR, url: r.base, authorize: () => null });
  const refused = createAgentChat({ endpoint: "/api/agent", fetch: async (_input, init) => nobody(new Request("https://app.test/api/agent", init)) });
  t.after(() => refused.destroy());
  await until(() => refused.getSnapshot().status === "error", "the refusal");
  assert.equal(refused.getSnapshot().error?.code, "unauthorized");
});

// ---------------------------------------------------------------------------------------------
// Connecting and disconnecting (React StrictMode mounts, effects, unmounts, and mounts again)

/** A handler stand-in whose token answers wait until released, and which counts event streams opened. */
function slowTokens() {
  const pending: (() => void)[] = [];
  const streams: AbortSignal[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/events")) {
      streams.push(init?.signal as AbortSignal);
      // A stream that stays open until it is aborted.
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("event: ready\ndata: {\"watch\":true}\n\n"));
        (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.includes("/history") || url.includes("/inputs") || url.includes("/state")) return Response.json(url.includes("/history") ? { entries: [], next: null, total: 0 } : []);
    const body = JSON.parse(String(init?.body));
    if (body.action !== "token") return Response.json({});
    await new Promise<void>(resolve => pending.push(resolve));
    return Response.json({ proxy: true, agentId: "client_x", token: "", expiresAt: Date.now() + 3_600_000 });
  };
  const open = () => streams.filter(signal => !signal?.aborted).length;
  return { fetch, pending, streams, open };
}

test("connect, disconnect, connect (StrictMode) opens one stream, whichever token arrives first", async () => {
  for (const order of ["first-last", "first-first"] as const) {
    const server = slowTokens();
    const chat = createAgentChat({ endpoint: "/api/agent", autoConnect: false, fetch: server.fetch });
    chat.connect(); chat.disconnect(); chat.connect();
    chat.connect(); // a second effect while the token is on its way starts nothing more
    await until(() => server.pending.length === 2, "both token requests");
    const [first, second] = server.pending;
    if (order === "first-last") { second(); await sleep(20); first(); } else { first(); await sleep(20); second(); }
    await until(() => chat.getSnapshot().connected, `the chat to connect (${order})`);
    await sleep(50);
    assert.equal(server.open(), 1, `one stream (${order})`);
    assert.equal(chat.getSnapshot().status, "ready");
    chat.destroy();
    await until(() => server.open() === 0, "the stream to close");
  }
});

test("a chat destroyed (or disconnected) before its token arrives never opens a stream", async () => {
  const server = slowTokens();
  const destroyed = createAgentChat({ endpoint: "/api/agent", fetch: server.fetch });
  const disconnected = createAgentChat({ endpoint: "/api/agent", fetch: server.fetch });
  await until(() => server.pending.length === 2, "the token requests");
  destroyed.destroy();
  disconnected.disconnect();
  for (const release of server.pending) release();
  await sleep(100);
  assert.equal(server.streams.length, 0);
  // Connected again, the disconnected one opens its stream.
  disconnected.connect();
  await until(() => server.pending.length === 3, "a new token request");
  server.pending[2]();
  await until(() => disconnected.getSnapshot().connected, "the chat to connect");
  assert.equal(server.open(), 1);
  disconnected.destroy();
});
