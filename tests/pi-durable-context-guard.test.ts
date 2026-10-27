import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import { contextRangeSize, openPiStorage, remotePiStorage, storageRequest } from "../src/pi-durable/storage.ts";
import { nodeConfig } from "../src/node-config.ts";
import { CONTEXT_RANGE_MAX_BYTES } from "../src/protocol.ts";
import { testDatabase } from "./database.ts";
import { runtime, toolCall, until } from "./runtime-server.ts";
import { cluster, fakeModel, token } from "./cluster-helpers.ts";

const root = 1 as ConversationId;

test("context range byte configuration defaults and rejects unsafe values", () => {
  assert.equal(nodeConfig({}).contextRangeMaxBytes, CONTEXT_RANGE_MAX_BYTES);
  assert.equal(nodeConfig({ AGENT_CONTEXT_RANGE_MAX_BYTES: "1024" }).contextRangeMaxBytes, 1024);
  for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
    assert.throws(() => nodeConfig({ AGENT_CONTEXT_RANGE_MAX_BYTES: value }), /AGENT_CONTEXT_RANGE_MAX_BYTES/);
  }
});

for (const backend of ["sqlite", "postgres"] as const) test(`${backend} measures the marker's head, UTF-8 bytes, forks and empty ranges without scanning records`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "context-size-"));
  const db = backend === "postgres" ? (await testDatabase()).db : undefined;
  const storage = await openPiStorage({ sessionId: "size-test", directory, db });
  t.after(async () => { await storage.close(context); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(await contextRangeSize(storage, root), { entries: 0, bytes: 0 });
  await storage.commit([{ type: "conversation", value: { id: root } }], context);
  const entries = [
    { id: 2 as EntryId, conversationId: root, kind: "test", data: "old".repeat(1000) },
    { id: 3 as EntryId, conversationId: root, kind: "test", data: "café 🐪" },
    { id: 4 as EntryId, conversationId: root, kind: "test", head: 3 as EntryId },
    { id: 5 as EntryId, conversationId: root, kind: "test", data: "tail" },
  ];
  await storage.commit(entries.slice(0, 2).map(value => ({ type: "entry" as const, value })), context);
  assert.deepEqual(await contextRangeSize(storage, root), { entries: 2, bytes: entries.slice(0, 2).reduce((n, entry) => n + Buffer.byteLength(JSON.stringify(entry)), 0) });
  await storage.commit(entries.slice(2).map(value => ({ type: "entry" as const, value })), context);
  // The newest marker points backwards, so starting at the marker's own ID would undercount.
  const expected = { entries: 3, bytes: entries.slice(1).reduce((n, entry) => n + Buffer.byteLength(JSON.stringify(entry)), 0) };
  storage.scanEntries = async () => { throw new Error("range records must not be loaded"); };
  storage.findLatestHeadMarker = async () => { throw new Error("marker records must not be loaded"); };
  assert.deepEqual(await contextRangeSize(storage, root), expected);
  const remote = remotePiStorage(request => storageRequest(storage, request));
  assert.deepEqual(await contextRangeSize(remote, root), expected);
  const fork = 6 as ConversationId;
  await storage.commit([{ type: "conversation", value: { id: fork, parent: { conversationId: root, at: 4 as EntryId } } }], context);
  assert.deepEqual(await contextRangeSize(remote, fork), { entries: 2, bytes: expected.bytes - Buffer.byteLength(JSON.stringify(entries[3])) });
  const own = { id: 7 as EntryId, conversationId: fork, kind: "test", head: 7 as EntryId, data: "new head" };
  await storage.commit([{ type: "entry", value: own }], context);
  assert.deepEqual(await contextRangeSize(remote, fork), { entries: 1, bytes: Buffer.byteLength(JSON.stringify(own)) });
});

test("host rejects an oversized context before opening the journal or scanning any entry", async t => {
  const directory = await mkdtemp(join(tmpdir(), "context-init-"));
  const { db } = await testDatabase();
  const storage = await openPiStorage({ sessionId: "oversized", directory, db });
  const faux = registerFauxProvider();
  t.after(async () => { faux.unregister(); await storage.close(context); await rm(directory, { recursive: true, force: true }); });
  await storage.commit([
    { type: "conversation", value: { id: root } },
    { type: "entry", value: { id: 2 as EntryId, conversationId: root, kind: "test", head: 2 as EntryId, data: "oversized" } },
  ], context);
  storage.entry = async () => { throw new Error("entry must not be read"); };
  storage.scanEntries = async () => { throw new Error("entries must not be scanned"); };
  storage.findLatestHeadMarker = async () => { throw new Error("marker must not be read"); };
  const host = createAgentHost({ piStorage: async () => storage } as HostIO);
  for (const resume of [false, true]) {
    await assert.rejects(host.handle("init", { id: "oversized", directory, model: faux.getModel(), tools: [], contextRangeMaxBytes: 1, resume }), /^Error: context_too_large: This agent's context/);
  }
});

test("a newly seeded oversized range fails startup with a coded outcome", async t => {
  const r = await runtime(t, () => { throw new Error("model must not be called"); }, { AGENT_CONTEXT_RANGE_MAX_BYTES: "1" });
  const agent = (await r.call("/v1/agents", { body: {} })).json;
  for (const text of ["first", "again"]) {
    const run = await r.prompt(agent.id, text);
    assert.equal(run.outcome.result.code, "context_too_large", JSON.stringify(run));
    assert.match(run.outcome.result.error, /past the 1 bytes a run can load/);
  }
  assert.equal(r.model.bodies.length, 0);
});

test("a live range stops with context_too_large and does not retry the model", { timeout: 60_000 }, async t => {
  const r = await runtime(t, (_body, index) => toolCall("js_exec", { code: 'return "x".repeat(8192)' }, `call_${index}`), {
    AGENT_CONTEXT_RANGE_MAX_BYTES: "65536", AGENT_IDLE_MS: "1000",
  });
  const agent = (await r.call("/v1/agents", { body: {} })).json;
  const run = await r.prompt(agent.id, "go");
  assert.equal(run.outcome.result.code, "context_too_large", JSON.stringify(run));
  assert.equal(run.outcome.result.stopped, "turn_limit");
  // Every request checks: the first past 64 KiB (~8 KiB of tool result a step) is stopped before it reaches the provider.
  assert.equal(r.model.bodies.length, 4, "the request past the bound is stopped before contacting the provider");
  await until(async () => !(await r.db.query("select pending_runs from agents where id = $1", [agent.id])).rows[0].pending_runs, "the idle agent to clear pending work");
});

test("an oversized resumed range fails once, clears pending work, and remains readable and abortable", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, () => undefined);
  const a = await c.start("large-context-a", { ...model.env, AGENT_HOSTING: "inline" });
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const created = await fetch(`${a.url}/v1/agents`, { method: "POST", headers, body: "{}" });
  const agent = await created.json() as { id: string; token: string };
  assert.equal(created.status, 201);
  const accepted = await fetch(`${a.url}/v1/agents/${agent.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "go" }) });
  const run = await accepted.json() as { id: string };
  assert.equal(accepted.status, 202);
  await until(() => model.bodies.length === 1, "the original model request");
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const b = await c.start("large-context-b", { ...model.env, AGENT_HOSTING: "inline", AGENT_CONTEXT_RANGE_MAX_BYTES: "1", AGENT_IDLE_MS: "1000" });
  const getRun = async () => await (await fetch(`${b.url}/v1/agents/${agent.id}/requests/${run.id}`, { headers })).json() as any;
  const ended = await until(async () => { const value = await getRun(); return value.state === "completed" && value; }, "the oversized resumed run to fail");
  assert.equal(ended.outcome?.result?.code, "context_too_large", JSON.stringify(ended));
  await until(async () => !(await c.db.query("select pending_runs from agents where id = $1", [agent.id])).rows[0].pending_runs, "pending work to clear");
  const state = (await c.db.query("select resume_failures, resume_after from agents where id = $1", [agent.id])).rows[0];
  assert.deepEqual(state, { resume_failures: 0, resume_after: null });
  assert.equal(model.bodies.length, 1, "no model call on the replacement node");
  const history = await fetch(`${b.url}/v1/agents/${agent.id}/history`, { headers });
  assert.equal(history.status, 200, await history.text());
  const abort = await fetch(`${b.url}/clients/${agent.id}/requests`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${agent.token}` }, body: JSON.stringify({ id: "abort-large", method: "abort", params: {} }) });
  assert.equal(abort.status, 202, await abort.text());
  const next = await fetch(`${b.url}/v1/agents/${agent.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "again" }) });
  const nextId = (await next.json() as any).id;
  assert.equal(next.status, 202);
  const failed = await until(async () => { const value = await (await fetch(`${b.url}/v1/agents/${agent.id}/requests/${nextId}`, { headers })).json() as any; return value.state === "completed" && value; }, "a new oversized run to fail");
  assert.equal(failed.outcome.result.code, "context_too_large");
});
