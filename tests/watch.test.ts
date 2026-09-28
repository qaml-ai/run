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

/** The quadratic parsePartialJson this repository had, as the reference for what every prefix parses to. */
function referencePartialJson(text: string): any {
  try { return JSON.parse(text); } catch { /* cut off */ }
  for (let end = text.length; end > 0; end--) {
    const closed = referenceClose(text.slice(0, end));
    if (closed === undefined) continue;
    try { return JSON.parse(closed); } catch { /* shorter */ }
  }
  return {};
}
function referenceClose(text: string): string | undefined {
  const stack: string[] = [];
  let string = false, escaped = false;
  for (const char of text) {
    if (string) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === "\"") string = false; }
    else if (char === "\"") string = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") stack.pop();
  }
  if (escaped) return undefined;
  let out = string ? `${text}"` : text;
  out = out.replace(/\s+$/, "");
  if (/[,:]$/.test(out)) out = out.endsWith(":") ? `${out}null` : out.slice(0, -1);
  if (stack.at(-1) === "}" && /[{,]\s*"(?:[^"\\]|\\.)*"$/.test(out)) out = out.replace(/,?\s*"(?:[^"\\]|\\.)*"$/, "");
  return out + stack.reverse().join("");
}

test("partial JSON: every prefix of real tool arguments parses as the previous implementation did", () => {
  const samples = [
    { code: "const rows = await tools.sales({ week: 38 });\nreturn rows.map(r => r.amount);", timeoutMs: 30000 },
    { questions: [{ question: "Which region?", header: "Region", options: [{ label: "EU", description: "Frankfurt \"eu-1\"" }, { label: "US" }], multiSelect: false }] },
    { a: [1, -2.5, 3e4, true, false, null, "x\\y\u00e9", { b: [] , c: {} }], d: "" },
  ];
  for (const sample of samples) {
    for (const spaced of [JSON.stringify(sample), JSON.stringify(sample, null, 2)]) {
      for (let end = 0; end <= spaced.length; end++) {
        const prefix = spaced.slice(0, end);
        assert.deepEqual(parsePartialJson(prefix), referencePartialJson(prefix), JSON.stringify(prefix));
      }
    }
  }
});

test("partial JSON is linear: long arguments, or a bad escape early in them, parse at once", () => {
  const long = `{"code": "${"x = 1;\\n".repeat(40_000)}`;
  let started = performance.now();
  assert.equal(parsePartialJson(long).code.length, 40_000 * 7);
  assert.ok(performance.now() - started < 200, `long: ${Math.round(performance.now() - started)} ms`);
  // An escape JSON does not allow, early in a long string: the old way tried every shorter prefix.
  const bad = `{"n": 1, "code": "\\x${"a".repeat(50_000)}`;
  started = performance.now();
  assert.deepEqual(parsePartialJson(bad), { n: 1 });
  assert.ok(performance.now() - started < 200, `bad escape: ${Math.round(performance.now() - started)} ms`);
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

test("a watcher joining a turn whose snapshot was too large to carry its messages still places what follows", { timeout: 60_000 }, async t => {
  const model = await scriptedModel(t, () => ({ deltas: words.map(word => ({ content: word })), hold: 2 }));
  // A context large enough for a 1.05 MB prompt: more than a snapshot carries, so it comes truncated.
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url, AGENT_MODEL: "openai/gpt-4.1-mini" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "p".repeat(1_050_000) } });
  await until(async () => (await (await fetch(`${r.base}/v1/agents/${agent}/events?poll=1&snapshot=1`, { headers: { Authorization: `Bearer ${OPERATOR}` } })).json() as any).events[0].data.turn?.partial, "the answer to start");
  const snapshot = (await (await fetch(`${r.base}/v1/agents/${agent}/events?poll=1&snapshot=1`, { headers: { Authorization: `Bearer ${OPERATOR}` } })).json() as any).events[0].data;
  assert.equal(snapshot.turn.truncated, true);
  assert.equal(snapshot.turn.count, 1, "it still says how many messages the run finished");
  const { token } = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: {} })).json;
  const watcher = watchAgent({ url: r.base, agentId: agent, token });
  t.after(() => watcher.close());
  await until(() => watcher.state.partial, "the watcher to join the turn");
  model.release();
  await until(() => !watcher.state.running && watcher.state.messages.length === 2, "the turn to end", 20_000);
  const history = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.deepEqual(watcher.state.indexes, [0, 1]);
  assert.deepEqual(watcher.state.messages.map((message: any) => message.role), history.map((message: any) => message.role), "the prompt is not overwritten");
  assert.equal((watcher.state.messages[1] as any).content[0].text, words.join(""));
});

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

test("a watcher whose token does not read history follows the stream without it", { timeout: 60_000 }, async t => {
  const r = await runtime(t, () => ({ content: "streamed" }));
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const { token } = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: { scopes: ["events"] } })).json;
  const errors: Error[] = [];
  const watcher = watchAgent({ url: r.base, agentId: agent, token, onError: error => errors.push(error) });
  t.after(() => watcher.close());
  await until(() => watcher.state.connected, "the watcher to connect");
  const done = await r.prompt(agent, "hi");
  await until(() => watcher.state.lastOutcome?.id === done.id, "the turn");
  assert.equal((watcher.state.messages.at(-1) as any).content[0].text, "streamed");
  assert.equal(await watcher.loadOlder(), false);
  assert.ok(errors.length <= 2, `no retrying: ${errors.map(error => error.message).join("; ")}`);
});

test("a watcher whose token hides the running turn still knows a turn runs", { timeout: 60_000 }, async t => {
  const model = await scriptedModel(t, () => ({ deltas: words.map(word => ({ content: word })), hold: 2 }));
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "go" } });
  await until(async () => (await (await fetch(`${r.base}/v1/agents/${agent}/events?poll=1&snapshot=1`, { headers: { Authorization: `Bearer ${OPERATOR}` } })).json() as any).events[0].data.turn?.partial, "the answer to start");
  const { token } = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: { scopes: ["events", "state"], events: ["agent_end"] } })).json;
  const watcher = watchAgent({ url: r.base, agentId: agent, token });
  t.after(() => watcher.close());
  await until(() => watcher.state.connected, "the watcher to connect");
  await sleep(300);
  assert.equal(watcher.state.running, true, "its snapshot has no turn, but its state has the run");
  model.release();
  await until(() => watcher.state.lastOutcome?.id === accepted.json.id, "the outcome");
  assert.equal(watcher.state.running, false);
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

test("a watcher whose token expires with no getToken stops, and says so", async () => {
  const errors: string[] = [];
  const fetch: typeof globalThis.fetch = async input => String(input).includes("/inputs") ? Response.json([]) : new Response(null, { status: 401 });
  const watcher = watchAgent({ url: "https://runtime.test", agentId: "client_x", token: "expired", fetch, onError: error => errors.push(error.message) });
  try {
    await until(() => watcher.state.expired, "the watcher to see its token expired");
    assert.equal(watcher.state.connected, false);
    assert.match(errors.join("\n"), /no getToken to renew it/);
  } finally { watcher.close(); }
});

test("a watcher that cannot reach the runtime says it may be CORS, not just \"Failed to fetch\"", async () => {
  const errors: string[] = [];
  const fetch: typeof globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const watcher = watchAgent({ url: "https://runtime.test", agentId: "client_x", token: "t", fetch, onError: error => errors.push(error.message) });
  try { await until(() => errors.length > 0, "an error"); assert.match(errors[0], /CORS/); }
  finally { watcher.close(); }
});
