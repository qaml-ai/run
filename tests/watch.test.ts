import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { parsePartialJson, watchAgent, type AgentView } from "../clients/watch.ts";
import { listen, OPERATOR, runtime, sleep, until } from "./runtime-server.ts";

test("partial JSON parses as far as it goes", () => {
  assert.deepEqual(parsePartialJson(""), {});
  assert.deepEqual(parsePartialJson('{"code": "return a'), { code: "return a" });
  assert.deepEqual(parsePartialJson('{"code": "x\\'), { code: "x" });
  assert.deepEqual(parsePartialJson('{"a": 1, "b"'), { a: 1 });
  assert.deepEqual(parsePartialJson('{"a": 1, "b":'), { a: 1, b: null });
  assert.deepEqual(parsePartialJson('{"a": [1, 2, {"c": "d'), { a: [1, 2, { c: "d" }] });
  assert.deepEqual(parsePartialJson('{"a": tr'), { a: null });
  assert.deepEqual(parsePartialJson('{"a": 1}'), { a: 1 });
});

test("the watcher is browser code: it bundles for a browser with nothing from Node", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../clients/watch.ts", import.meta.url))], bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent" });
  assert.equal(result.errors.length, 0);
  assert.ok(result.outputFiles[0].text.length < 30_000, "and small");
});

/** A model that streams each answer in pieces, holding the rest of one back until `release`. */
async function scriptedModel(t: { after(fn: () => Promise<void> | void): void }, script: (index: number) => { deltas: object[]; hold?: number }) {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  let calls = 0;
  const url = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* the request body */ }
    const { deltas, hold } = script(calls++);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    for (const [index, delta] of deltas.entries()) {
      if (index === hold) await gate.promise;
      chunk(delta);
      await sleep(5);
    }
    chunk({}, deltas.some(delta => "tool_calls" in delta) ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  });
  return { url: `${url}/v1`, release: () => gate.resolve() };
}
const code = "return 6 * 7";
const argumentPieces = ['{"co', 'de": "ret', 'urn 6 ', '* 7"}'];
const toolDeltas = [{ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "js_exec", arguments: "" } }] },
  ...argumentPieces.map(piece => ({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))];
const words = ["The ", "answer ", "is ", "42."];

async function setup(t: Parameters<typeof runtime>[0], transport: "sse" | "poll") {
  // The first answer calls js_exec, its arguments held half way; the second streams its text.
  const model = await scriptedModel(t, index => index === 0 ? { deltas: toolDeltas, hold: 3 } : index === 1 ? { deltas: words.map(word => ({ content: word })) } : { deltas: [{ content: "ok" }] });
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  let minted = 0;
  const mint = async (ttlSeconds = 900) => { minted++; return (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: { ttlSeconds } })).json; };
  const first = await mint(5);
  const errors: Error[] = [];
  let changes = 0;
  const watcher = watchAgent({ url: r.base, agentId: agent, token: first.token, expiresAt: first.expiresAt, getToken: () => mint(5), transport, onChange: () => { changes++; }, onError: error => errors.push(error) });
  t.after(() => watcher.close());
  return { r, agent, model, watcher, errors, get minted() { return minted; }, get changes() { return changes; } };
}

for (const transport of ["sse", "poll"] as const) {
  test(`a watcher (${transport}) folds the stream into Pi messages as they grow, tool arguments included, and renews its token`, { timeout: 60_000 }, async t => {
    const s = await setup(t, transport);
    const state: AgentView = s.watcher.state;
    await until(() => state.connected, "the watcher to connect");
    const accepted = await s.r.call(`/v1/agents/${s.agent}/prompt`, { body: { text: "compute" } });
    // Half way through the tool call's arguments: the call is named, and its code parsed as far as it goes.
    const call = await until(() => (state.partial?.content ?? []).find((part: any) => part.type === "toolCall" && part.arguments.code) as any, "the tool call to stream");
    assert.equal(call.name, "js_exec");
    assert.equal(call.id, "call_1");
    assert.ok(code.startsWith(call.arguments.code) && call.arguments.code.length < code.length, `partial code: ${call.arguments.code}`);
    assert.ok(state.running);
    s.model.release();
    await until(() => state.lastOutcome?.id === accepted.json.id, "the turn to end", 20_000);
    assert.equal(state.running, false);
    assert.equal(state.partial, null);
    const history = (await s.r.call(`/v1/agents/${s.agent}/history`)).json.messages;
    assert.deepEqual(state.messages, history, "the stream's messages are the history's");
    assert.deepEqual(state.indexes, history.map((_: unknown, index: number) => index));
    assert.equal((state.messages.at(-1) as any).content[0].text, words.join(""));

    // Its 5 s token expires: it mints a new one and goes on.
    await sleep(6_000);
    const again = await s.r.prompt(s.agent, "again");
    await until(() => state.lastOutcome?.id === again.id, "the next turn, after the token was renewed", 20_000);
    assert.ok(s.minted >= 2, "a new token was minted");
    assert.equal((state.messages.at(-1) as any).content[0].text, "ok");
    assert.deepEqual(s.errors.filter(error => !/aborted|terminated/i.test(error.message)), []);
  });
}

test("a watcher whose streams deliver nothing (a proxy that buffers them) falls back to long polls", { timeout: 60_000 }, async t => {
  const r = await runtime(t, () => ({ content: "polled" }));
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const { token } = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: {} })).json;
  const buffering = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/events") && !String(input).includes("poll=1")) {
      const response = await fetch(input, init);
      return new Response(new ReadableStream({ cancel: () => response.body?.cancel() }), { status: 200, headers: response.headers });
    }
    return fetch(input, init);
  }) as typeof fetch;
  const watcher = watchAgent({ url: r.base, agentId: agent, token, fetch: buffering, stallMs: 300 });
  t.after(() => watcher.close());
  await until(() => watcher.state.transport === "poll", "the fallback to polls", 10_000);
  const done = await r.prompt(agent, "hi");
  await until(() => watcher.state.lastOutcome?.id === done.id, "the turn, by polls");
  assert.equal((watcher.state.messages.at(-1) as any).content[0].text, "polled");
});

test("a watcher starts from the newest page and loads older pages on request", { timeout: 60_000 }, async t => {
  const r = await runtime(t, body => ({ content: `reply ${body.messages.length}` }));
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  for (const text of ["one", "two", "three"]) await r.prompt(agent, text);
  const { token } = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: {} })).json;
  const watcher = watchAgent({ url: r.base, agentId: agent, token, pageSize: 2 });
  t.after(() => watcher.close());
  await until(() => watcher.state.messages.length >= 2, "the newest page");
  assert.deepEqual(watcher.state.indexes, [4, 5]);
  assert.ok(watcher.state.hasOlder);
  while (await watcher.loadOlder());
  assert.deepEqual(watcher.state.indexes, [0, 1, 2, 3, 4, 5]);
  assert.equal(watcher.state.hasOlder, false);
  assert.deepEqual(watcher.state.messages, (await r.call(`/v1/agents/${agent}/history`)).json.messages);
  assert.equal(OPERATOR.length > 0, true);
});
