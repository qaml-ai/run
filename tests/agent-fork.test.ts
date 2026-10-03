import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { forkCut, Transcript, type TranscriptRecord } from "../src/transcript.ts";
import { Agents } from "../clients/node.ts";
import { lastUser, OPERATOR, OTHER_OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Room for every agent a test makes running at once. */
const roomy = { AGENT_MAX_AGENTS: "40", AGENT_MAX_AGENTS_PER_TENANT: "40" };
const said = (history: any[]) => history.map(message => `${message.role}:${typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? part.type).join("")}`);
/** Answers "answer to <prompt>", or after `slow` waits `delayMs` first. */
const answering = (delayMs = 0) => (body: any) => {
  const asked = lastUser(body);
  return { role: "assistant", content: `answer to ${asked}`, ...(asked.includes("slow") ? { delayMs } : {}) };
};

test("a fork has the source's configuration, history and workspace, and from then on each goes its own way", async t => {
  const r = await runtime(t, answering(), roomy);
  const put = (volume: string, path: string, text: string) => fetch(`${r.base}/v1/volumes/${volume}/files/${path}`, { method: "PUT", headers: { Authorization: `Bearer ${OPERATOR}` }, body: text });
  const source = (await r.call("/v1/agents", { body: { name: "Support", systemPromptAppend: "APPEND-MARKER", spendLimit: { usd: 5 }, runLimits: { maxResponses: 7 } }, headers: { "Idempotency-Key": "source" } })).json.id as string;
  await r.prompt(source, "first question");
  const before = await r.call(`/v1/agents/${source}`);
  const workspace = before.json.mounts[0].volumeId as string;
  assert.equal((await put(workspace, "notes.txt", "source notes")).status, 201);

  const forked = await r.call(`/v1/agents/${source}/fork`, { body: { key: "fork-1" } });
  assert.equal(forked.status, 201, forked.text);
  const fork = forked.json.id as string;
  assert.deepEqual(forked.json.forkedFrom, { agentId: source, atMessage: 1 });
  assert.equal(typeof forked.json.token, "string");
  assert.equal(forked.json.expiresAt, null, "a fork made with a key lives until deleted");

  const detail = (await r.call(`/v1/agents/${fork}`)).json;
  assert.deepEqual(detail.forkedFrom, { agentId: source, atMessage: 1 });
  assert.equal(detail.name, "Support (fork)");
  assert.equal(detail.systemPromptAppend, "APPEND-MARKER");
  assert.equal(detail.model, before.json.model);
  assert.deepEqual(detail.spendLimit, { usd: 5, spent: 0 });
  assert.deepEqual(detail.runLimits, before.json.runLimits);
  assert.equal(detail.mounts.length, 1);
  const forkWorkspace = detail.mounts[0].volumeId as string;
  assert.notEqual(forkWorkspace, workspace, "the fork has a workspace of its own");
  assert.equal((await r.call(`/v1/agents/${source}`)).json.forkedFrom, undefined);

  const sourceHistory = (await r.call(`/v1/agents/${source}/history`)).json.messages;
  assert.deepEqual((await r.call(`/v1/agents/${fork}/history`)).json.messages, sourceHistory);
  const page = (await r.call(`/v1/agents/${fork}/history?limit=50`)).json;
  assert.deepEqual(page.entries.map((entry: any) => entry.index), [0, 1]);
  assert.equal(page.total, 2);
  assert.equal((await r.call(`/v1/volumes/${forkWorkspace}/files/notes.txt`)).text, "source notes");

  // Files: a write to either is the other's no longer.
  await put(workspace, "notes.txt", "changed in source");
  await put(forkWorkspace, "fork-only.txt", "fork's own");
  assert.equal((await r.call(`/v1/volumes/${forkWorkspace}/files/notes.txt`)).text, "source notes");
  assert.equal((await r.call(`/v1/volumes/${workspace}/files/fork-only.txt`)).status, 404);

  // History: each agent's turns are its own; the fork's model sees the copied conversation.
  const answered = await r.prompt(fork, "fork question");
  assert.equal(answered.outcome.result.reply, "answer to fork question");
  const sent = JSON.stringify(r.model.bodies.at(-1).messages);
  assert.ok(sent.includes("first question") && sent.includes("answer to first question") && sent.includes("APPEND-MARKER"));
  await r.prompt(source, "source question");
  assert.deepEqual(said((await r.call(`/v1/agents/${source}/history`)).json.messages),
    ["user:first question", "assistant:answer to first question", "user:source question", "assistant:answer to source question"]);
  assert.deepEqual(said((await r.call(`/v1/agents/${fork}/history`)).json.messages),
    ["user:first question", "assistant:answer to first question", "user:fork question", "assistant:answer to fork question"]);

  // Deleting the source leaves the fork whole.
  assert.equal((await r.call(`/v1/agents/${source}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(`/v1/agents/${fork}/history`)).json.messages.length, 4);
  assert.equal((await r.call(`/v1/volumes/${forkWorkspace}/files/notes.txt`)).text, "source notes");
});

test("a fork may act for someone else and carry its own prompt addition: what a create fixes, the fork's create sets", async t => {
  const r = await runtime(t, answering(), roomy);
  const source = (await r.call("/v1/agents", { body: { subject: "user-1", context: { thread: "a" }, systemPromptAppend: "Thread a" } })).json.id as string;
  await r.prompt(source, "hello");
  const made = await r.call(`/v1/agents/${source}/fork`, { body: { context: { thread: "b" }, systemPromptAppend: "Thread b" } });
  assert.equal(made.status, 201, made.text);
  const identity = async (id: string) => (await r.db.query("select header from agents where id = $1", [id])).rows[0].header.identity;
  assert.deepEqual(await identity(made.json.id), { subject: "user-1", context: { thread: "b" } }, "the subject comes along; the context is the fork's");
  assert.deepEqual(await identity(source), { subject: "user-1", context: { thread: "a" } });
  assert.equal((await r.call(`/v1/agents/${made.json.id}`)).json.systemPromptAppend, "Thread b");
  await r.prompt(made.json.id, "again");
  const sent = JSON.stringify(r.model.bodies.at(-1).messages);
  assert.ok(sent.includes("Thread b"), "the fork's model gets its own addition");
  assert.equal((await r.call(`/v1/agents/${source}/fork`, { body: { context: "thread b" } })).status, 400);
});

test("a fork ends at a message: that message and the tool results answering it, or a request's whole turn", async t => {
  const r = await runtime(t, body => lastUser(body) === "use a tool" && !body.messages.some((message: any) => message.role === "tool")
    ? toolCall("js_exec", { code: "return 6 * 7" }) : answering()(body), roomy);
  const source = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(source, "one");
  const second = await r.prompt(source, "use a tool");
  await r.prompt(source, "three");
  const history = (await r.call(`/v1/agents/${source}/history`)).json.messages;
  assert.deepEqual(history.map((message: any) => message.role), ["user", "assistant", "user", "assistant", "toolResult", "assistant", "user", "assistant"]);

  const fork = async (atMessage: unknown) => {
    const made = await r.call(`/v1/agents/${source}/fork`, { body: { atMessage } });
    assert.equal(made.status, 201, made.text);
    return { forkedFrom: made.json.forkedFrom, history: (await r.call(`/v1/agents/${made.json.id}/history`)).json.messages };
  };
  const atUser = await fork(0);
  assert.deepEqual(atUser.history, history.slice(0, 1));
  assert.deepEqual(atUser.forkedFrom, { agentId: source, atMessage: 0 });
  const atCall = await fork(3);
  assert.deepEqual(atCall.history, history.slice(0, 5), "the call's result comes along");
  assert.deepEqual(atCall.forkedFrom.atMessage, 4);
  const atTurn = await fork(second.id);
  assert.deepEqual(atTurn.history, history.slice(0, 6), "a request id keeps its whole turn");
  assert.equal(atTurn.forkedFrom.atMessage, 5);

  // A fork that ends mid-conversation takes the next prompt as any agent does.
  const made = (await r.call(`/v1/agents/${source}/fork`, { body: { atMessage: 1 } })).json.id as string;
  assert.equal((await r.prompt(made, "after the fork")).outcome.result.reply, "answer to after the fork");
  assert.deepEqual(said((await r.call(`/v1/agents/${made}/history`)).json.messages), ["user:one", "assistant:answer to one", "user:after the fork", "assistant:answer to after the fork"]);

  for (const atMessage of [8, -1, 1.5, "no-such-request"]) {
    const refused = await r.call(`/v1/agents/${source}/fork`, { body: { atMessage } });
    assert.equal(refused.status, 400, `${atMessage}: ${refused.text}`);
    if (atMessage !== 1.5) assert.equal(refused.json.code, "FORK_POINT_INVALID");
  }
});

test("a fork of an agent mid-turn ends before the running turn: no partial turn, and the fork loads idle", async t => {
  const r = await runtime(t, answering(3_000), roomy);
  const source = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(source, "settled");
  const running = await r.call(`/v1/agents/${source}/prompt`, { body: { text: "slow one" } });
  assert.equal(running.status, 202);
  await until(async () => (await r.call(`/v1/agents/${source}/history`)).json.messages.length === 3, "the running turn's prompt in the history");

  const made = await r.call(`/v1/agents/${source}/fork`, { body: {} });
  assert.equal(made.status, 201, made.text);
  assert.deepEqual(made.json.forkedFrom, { agentId: source, atMessage: 1 });
  const forked = (await r.call(`/v1/agents/${made.json.id}/history`)).json.messages;
  assert.deepEqual(said(forked), ["user:settled", "assistant:answer to settled"]);
  // A fork from a turn still running would be repaired as interrupted on load; this one is idle.
  const state = (await r.call(`/v1/agents/${made.json.id}/state`)).json;
  assert.deepEqual(state.requests, []);

  for (const atMessage of [2, running.json.id]) {
    const refused = await r.call(`/v1/agents/${source}/fork`, { body: { atMessage } });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.code, "FORK_POINT_RUNNING");
  }
  await until(async () => (await r.call(`/v1/agents/${source}/requests/${running.json.id}`)).json.state === "completed", "the slow turn");
  const whole = await r.call(`/v1/agents/${source}/fork`, { body: { atMessage: running.json.id } });
  assert.equal(whole.status, 201, whole.text);
  assert.deepEqual(said((await r.call(`/v1/agents/${whole.json.id}/history`)).json.messages).slice(2), ["user:slow one", "assistant:answer to slow one"]);
});

test("a fork of a compacted agent keeps its summary: the model sees the summary and what follows, history keeps every message", async t => {
  const r = await runtime(t, answering(), roomy);
  const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "openrouter", model: "openai/gpt-4o-mini", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  const source = (await r.call("/v1/agents", { body: { initialMessages: [
    user("OLD-QUESTION"), assistant("OLD-ANSWER"), { role: "compactionSummary", summary: "SUMMARY-OF-EARLIER", tokensBefore: 100_000, timestamp: 3 }, user("KEPT-QUESTION"), assistant("KEPT-ANSWER"),
  ] } })).json.id as string;
  const fork = (await r.call(`/v1/agents/${source}/fork`, { body: {} })).json.id as string;
  assert.deepEqual(said((await r.call(`/v1/agents/${fork}/history`)).json.messages), ["user:OLD-QUESTION", "assistant:OLD-ANSWER", "user:KEPT-QUESTION", "assistant:KEPT-ANSWER"]);
  await r.prompt(fork, "NEW-QUESTION");
  const sent = JSON.stringify(r.model.bodies.at(-1).messages);
  for (const seen of ["SUMMARY-OF-EARLIER", "KEPT-QUESTION", "NEW-QUESTION"]) assert.ok(sent.includes(seen), seen);
  for (const gone of ["OLD-QUESTION", "OLD-ANSWER"]) assert.ok(!sent.includes(gone), `${gone} is summarized`);

  // Forked before the summary's cut, the import is cut too, and the summary (which covers more) is left out; forked at
  // its cut, it is the summary of everything the fork keeps.
  const sentFor = async (atMessage: number) => {
    const early = (await r.call(`/v1/agents/${source}/fork`, { body: { atMessage } })).json.id as string;
    await r.prompt(early, `EARLY-${atMessage}`);
    return JSON.stringify(r.model.bodies.at(-1).messages);
  };
  const before = await sentFor(0);
  assert.ok(before.includes("OLD-QUESTION") && !before.includes("SUMMARY-OF-EARLIER") && !before.includes("KEPT-QUESTION"), before);
  const at = await sentFor(1);
  assert.ok(at.includes("SUMMARY-OF-EARLIER") && !at.includes("OLD-ANSWER") && !at.includes("KEPT-QUESTION"), at);
});

test("forking a transcript with compactions keeps them, and its working set loads as the source's would", async () => {
  // Recorded by the runtime on pi 0.80.6: tool calls with thinking, and two compactions.
  const text = await readFile(new URL("./fixtures/pi-0.80.6-transcript.jsonl", import.meta.url), "utf8");
  const records = text.split("\n").filter(Boolean).map(line => JSON.parse(line)) as TranscriptRecord[];
  const load = (kept: TranscriptRecord[]) => { const transcript = new Transcript(undefined as never); for (const record of kept) transcript.apply(record); return transcript; };
  const source = load(records);
  assert.ok(source.compaction, "the fixture is compacted");
  const whole = forkCut(records);
  const fork = load(whole.records);
  assert.equal(whole.through, source.total - 1);
  assert.deepEqual(fork.compaction, source.compaction);
  assert.deepEqual(fork.view(), source.view());
  assert.equal(fork.active, false);

  // At a message after the first compaction's cut and before the second was written: the first holds, the second does not.
  const compactions = records.flatMap((record, position) => record.t === "compaction" ? [{ position, cut: record.cut }] : []);
  assert.ok(compactions.length >= 2);
  const totals = records.map((_, position) => load(records.slice(0, position + 1)).total);
  const at = totals[compactions[1].position] - 1;
  const partial = forkCut(records, at);
  const loaded = load(partial.records);
  assert.equal(loaded.total, partial.through! + 1);
  assert.ok(loaded.compaction && loaded.compaction.cut === compactions[0].cut, "the first compaction is the fork's summary");
  assert.equal(loaded.active, false);
});

test("a fork's key makes it idempotent: a retry returns the same fork, another source's fork with it is refused", async t => {
  const r = await runtime(t, answering(), roomy);
  const source = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const other = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(source, "hello");
  const first = await r.call(`/v1/agents/${source}/fork`, { body: { key: "same" } });
  await r.prompt(source, "more");
  const again = await r.call(`/v1/agents/${source}/fork`, { body: { key: "same", atMessage: 3 } });
  assert.equal(again.status, 201);
  assert.deepEqual(again.json, first.json, "the same fork, as it was made");
  assert.equal((await r.call(`/v1/agents/${first.json.id}/history`)).json.messages.length, 2);
  const header = await r.call(`/v1/agents/${source}/fork`, { body: {}, headers: { "Idempotency-Key": "by-header" } });
  assert.equal((await r.call(`/v1/agents/${source}/fork`, { body: {}, headers: { "Idempotency-Key": "by-header" } })).json.id, header.json.id);
  assert.equal((await r.call("/v1/agents/by-header/credentials")).json.id, header.json.id, "agents.get finds a fork by its key");
  assert.notEqual((await r.call(`/v1/agents/${source}/fork`, { body: {} })).json.id, (await r.call(`/v1/agents/${source}/fork`, { body: {} })).json.id, "without a key, each fork is new");

  const conflict = await r.call(`/v1/agents/${other}/fork`, { body: { key: "same" } });
  assert.equal(conflict.status, 409, conflict.text);
  const created = (await r.call("/v1/agents", { body: {}, headers: { "Idempotency-Key": "plain" } })).json.id;
  assert.ok(created);
  assert.equal((await r.call(`/v1/agents/${source}/fork`, { body: { key: "plain" } })).status, 409, "a key an agent was made with names that agent");
  // A deleted fork's key makes a new one.
  assert.equal((await r.call(`/v1/agents/${first.json.id}`, { method: "DELETE" })).status, 200);
  const renewed = await r.call(`/v1/agents/${source}/fork`, { body: { key: "same" } });
  assert.equal(renewed.status, 201, renewed.text);
  assert.notEqual(renewed.json.id, first.json.id);
  assert.equal(renewed.json.forkedFrom.atMessage, 3);
});

test("only the source's tenant forks it, and never with a browser token", async t => {
  const r = await runtime(t, answering(), roomy);
  const source = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const browser = (await r.call(`/v1/agents/${source}/browser-tokens`, { body: {} })).json.token as string;
  const refused = await r.call(`/v1/agents/${source}/fork`, { body: {}, token: browser });
  assert.equal(refused.status, 403, refused.text);
  assert.equal((await r.call(`/v1/agents/${source}/fork`, { body: {}, token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call("/v1/agents")).json.length, 1, "no fork was made");
});

test("a fork pins the files its history refers to: they stay stored after the source, its workspace and the fork's copy are gone", async t => {
  const r = await runtime(t, answering(), { AGENT_GC_ENABLED: "true", AGENT_PURGE_INTERVAL_MS: "1000", AGENT_GC_GRACE_MS: "0", AGENT_GC_INTERVAL_MS: "0", AGENT_GC_POLL_MS: "200" });
  const source = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const accepted = await r.call(`/v1/agents/${source}/prompt`, { body: { text: "keep this", files: [{ name: "kept.txt", data: Buffer.from("forked words").toString("base64") }] } });
  await until(async () => (await r.call(`/v1/agents/${source}/requests/${accepted.json.id}`)).json.state === "completed", "the turn");
  const forked = (await r.call(`/v1/agents/${source}/fork`, { body: {} })).json.id as string;
  assert.deepEqual((await r.db.query("select hash from chunk_pins where agent = $1", [forked])).rows.map(row => row.hash), [hash("forked words")]);

  // The fork's workspace copy of the upload goes, and so does the source with its workspace: only the fork's pin holds the chunk.
  const workspace = (await r.call(`/v1/agents/${forked}`)).json.mounts[0].volumeId;
  const files = (await r.call(`/v1/volumes/${workspace}/files`)).json;
  for (const file of files.files ?? files) assert.equal((await r.call(`/v1/volumes/${workspace}/files/${file.path.replace(/^\//, "")}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(`/v1/agents/${source}`, { method: "DELETE" })).status, 200);
  await until(async () => (await r.db.query("select count(*)::int as count from chunk_pins where agent = $1", [source])).rows[0].count === 0, "the source's purge", 20_000);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await r.db.query("select count(*)::int as count from chunk_touches where hash = $1", [hash("forked words")])).rows[0].count, 1, "still stored: the fork holds it");
  // And the fork's model still gets the file.
  await r.prompt(forked, "what did I attach?");
  assert.ok(JSON.stringify(r.model.bodies.at(-1).messages).includes("forked words"));
});

test("the SDK's fork() makes a new agent from this one: its history, configuration and files; a key returns the same fork", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `said: ${lastUser(body)}` }), roomy);
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const source = await agents.upsert("fork-source", { instructions: "Be terse." });
  await source.run("hello");
  await source.files.upload("/workspace/notes.txt", "kept");
  const fork = await source.fork({ key: "fork-of-source" });
  assert.notEqual(fork.id, source.id);
  assert.deepEqual(fork.forkedFrom, { agentId: source.id, atMessage: 1 });
  assert.deepEqual((await fork.history()).map(message => message.role), ["user", "assistant"]);
  assert.equal(new TextDecoder().decode((await fork.files.download("/workspace/notes.txt")).data), "kept");
  assert.equal((await r.call(`/v1/agents/${fork.id}`)).json.systemPrompt, "Be terse.");
  assert.equal((await source.fork({ key: "fork-of-source" })).id, fork.id, "the same key is the same fork");
  assert.equal((await agents.get("fork-of-source")).id, fork.id);
  const early = await agents.fork(source.id, { atMessage: 0, instructionsAppend: "EARLY-APPEND" });
  assert.equal((await r.call(`/v1/agents/${early.id}`)).json.systemPromptAppend, "EARLY-APPEND");
  assert.equal((await early.history()).length, 1);
  assert.ok(early.session.expiresAt! - Date.now() > 86_000_000, "a fork without a key of the caller's lives a day");
  assert.equal((await fork.run("again")).text, "said: again");
  assert.equal((await source.history()).length, 2, "the source's history is its own");
});
