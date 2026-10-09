import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInitialMessages } from "../src/history.ts";
import { runtime } from "./runtime-server.ts";

const user = (text: string, timestamp = 1) => ({ role: "user", content: text, timestamp });
const assistant = (content: object[]) => ({ role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });

test("imported history is checked message by message, and each refusal names the message and what it lacks", () => {
  const refused = (messages: unknown, pattern: RegExp) => assert.throws(() => validateInitialMessages(messages as never), (error: Error) => pattern.test(error.message));
  refused({}, /^INVALID_HISTORY: initialMessages must be an array/);
  refused([user("hi"), null], /^INVALID_HISTORY: initialMessages\[1\] must be a message object/);
  refused([user("hi"), { role: "system", content: "x" }], /^INVALID_HISTORY: initialMessages\[1\] has role "system"; a message is user, assistant, toolResult or compactionSummary/);
  refused([{ role: "user" }], /^INVALID_HISTORY: initialMessages\[0\]: a user message's content is a string or an array of text, image and file blocks/);
  refused([{ role: "user", content: [{ type: "video" }] }], /initialMessages\[0\]: a user message's content/);
  refused([user("hi"), { role: "assistant", content: "hello" }], /^INVALID_HISTORY: initialMessages\[1\]: an assistant message's content is an array of text, thinking and toolCall blocks/);
  refused([user("hi"), assistant([{ type: "toolCall", id: "call_1", name: "search" }])], /initialMessages\[1\]: content\[0\]: a toolCall needs id, name and arguments \(an object\)/);
  refused([user("hi"), { role: "toolResult", toolName: "search", content: [] }], /initialMessages\[1\]: a toolResult needs toolCallId, toolName and content/);
  refused([{ role: "compactionSummary", summary: "" }], /initialMessages\[0\]: a compactionSummary needs its summary/);

  const big = "x".repeat(8 * 1024 * 1024);
  assert.throws(() => validateInitialMessages([user(big), user(big)] as never), (error: Error & { status?: number }) =>
    error.status === 413 && /^HISTORY_TOO_LARGE: initialMessages is 16\.0 MB of JSON; at most 16 MB/.test(error.message));

  validateInitialMessages([
    user("Find the report"),
    assistant([{ type: "thinking", thinking: "Search first.", thinkingSignature: "sig" }, { type: "text", text: "Searching." }, { type: "toolCall", id: "call_1", name: "search", arguments: { q: "report" } }]),
    { role: "toolResult", toolCallId: "call_1", toolName: "search", content: [{ type: "text", text: "report.pdf" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: "Thanks" }, { type: "image", data: "aGk=", mimeType: "image/png" }], timestamp: 4 },
  ] as never);
});

test("a refused import answers 400 INVALID_HISTORY, or 413 HISTORY_TOO_LARGE, and makes no agent", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const invalid = await r.call("/v1/agents", { body: { initialMessages: [user("hi"), { role: "toolResult", content: [] }] } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.code, "INVALID_HISTORY");
  assert.match(invalid.json.error, /initialMessages\[1\]: a toolResult needs toolCallId/);
  const big = "x".repeat(8 * 1024 * 1024 + 1024);
  const large = await r.call("/v1/agents", { body: { initialMessages: [user(big), user(big)] } });
  assert.equal(large.status, 413);
  assert.equal(large.json.code, "HISTORY_TOO_LARGE");
  assert.deepEqual((await r.call("/v1/agents")).json, []);
});

test("a compactionSummary in imported history stands for everything before it: history keeps every message, the model sees the summary and what follows", async t => {
  const bodies: any[] = [];
  const r = await runtime(t, body => { bodies.push(body); return { role: "assistant", content: "Carrying on." }; });
  const initialMessages = [
    user("OLD-QUESTION"), assistant([{ type: "text", text: "OLD-ANSWER" }]),
    { role: "compactionSummary", summary: "SUMMARY-OF-EARLIER", tokensBefore: 120_000, timestamp: 3 },
    user("KEPT-QUESTION", 4), assistant([{ type: "text", text: "KEPT-ANSWER" }]),
  ];
  const agent = (await r.call("/v1/agents", { body: { initialMessages } })).json.id;
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.deepEqual(history.map((message: any) => message.role), ["user", "assistant", "user", "assistant"], "the summary is not a message of the history");
  assert.equal(history[2].content, "KEPT-QUESTION");

  assert.equal((await r.prompt(agent, "NEW-QUESTION")).outcome.result.reply, "Carrying on.");
  const sent = JSON.stringify(bodies[0].messages);
  for (const seen of ["SUMMARY-OF-EARLIER", "KEPT-QUESTION", "KEPT-ANSWER", "NEW-QUESTION"]) assert.ok(sent.includes(seen), seen);
  for (const gone of ["OLD-QUESTION", "OLD-ANSWER"]) assert.ok(!sent.includes(gone), `${gone} is summarized`);
  assert.ok(sent.indexOf("SUMMARY-OF-EARLIER") < sent.indexOf("KEPT-QUESTION"));
});

test("imported messages need only their role and content: usage, stopReason, timestamps and isError are filled in", async t => {
  const bodies: any[] = [];
  const r = await runtime(t, body => { bodies.push(body); return { role: "assistant", content: "Carrying on." }; });
  const initialMessages = [
    { role: "user", content: "Find the report" },
    { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "search", arguments: { q: "report" } }] },
    { role: "toolResult", toolCallId: "call_1", toolName: "search", content: [{ type: "text", text: "report.pdf" }] },
    { role: "assistant", content: [{ type: "text", text: "It is report.pdf." }] },
  ];
  const agent = (await r.call("/v1/agents", { body: { initialMessages } })).json.id;
  assert.equal((await r.prompt(agent, "Thanks")).outcome.result.reply, "Carrying on.", "the next run reads the imported history");
  assert.match(JSON.stringify(bodies[0].messages), /It is report\.pdf/);
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.deepEqual(history.slice(0, 4).map((message: any) => [message.role, message.stopReason, message.usage?.totalTokens, message.isError, typeof message.timestamp]), [
    ["user", undefined, undefined, undefined, "number"],
    ["assistant", "toolUse", 0, undefined, "number"],
    ["toolResult", undefined, undefined, false, "number"],
    ["assistant", "stop", 0, undefined, "number"],
  ]);
});
