import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { VolumeService } from "../src/volumes.ts";
import { StorageGc } from "../src/storage-gc.ts";
import { testDatabase } from "./database.ts";
import { runtime, until } from "./runtime-server.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (text: string, tenant = "acme") => `chunks/${tenant}/${hash(text).slice(0, 2)}/${hash(text)}`;

async function setup(t: Context) {
  const { db } = await testDatabase();
  const metered = new Map<string, number>();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }), (name, bytes) => metered.set(name, (metered.get(name) ?? 0) + bytes));
  const volumes = new VolumeService({ db, storage });
  t.after(() => volumes.close());
  // No grace: a chunk unreferenced in two runs in a row goes.
  const gc = new StorageGc({ db, storage, volumes, graceMs: 0 });
  const write = async (id: string, path: string, content: string) => volumes.call(id, "acme", "commit", { path, ...await volumes.store("acme", Buffer.from(content)) });
  const collect = async () => { await gc.run("acme"); return gc.run("acme"); };
  return { db, storage, volumes, gc, write, collect, metered };
}

test("a deleted file's chunks stop being stored and metered; chunks a file still holds stay", async t => {
  const { storage, volumes, write, collect, metered } = await setup(t);
  const { id } = await volumes.create("acme", { name: "v" });
  await write(id, "/a.txt", "alpha");
  await write(id, "/b.txt", "beta");
  await volumes.call(id, "acme", "remove", { path: "/a.txt" });
  const result = await collect();
  assert.equal(result.removed, 1);
  assert.equal(storage.blobs.has(key("alpha")), false);
  assert.equal(storage.blobs.has(key("beta")), true);
  assert.equal(metered.get(key("alpha")), 0, "no longer counted as stored");
  const entry = await volumes.call(id, "acme", "stat", { path: "/b.txt" });
  assert.equal((await volumes.readRange("acme", entry, 0, entry.size)).toString(), "beta");
});

test("a chunk a FileRef pins stays after its file is deleted, until the agent holding the pin is purged", async t => {
  const { db, storage, volumes, write, collect } = await setup(t);
  const { id } = await volumes.create("acme", { name: "v" });
  const entry = await write(id, "/upload.pdf", "gamma");
  await volumes.pin("acme", "client_holder", entry.chunks);
  await volumes.call(id, "acme", "remove", { path: "/upload.pdf" });
  await collect();
  assert.equal(storage.blobs.has(key("gamma")), true, "the transcript still refers to it");
  await db.query("delete from chunk_pins where agent = 'client_holder'");
  await collect();
  assert.equal(storage.blobs.has(key("gamma")), false);
});

test("a deleted volume's chunks go once no fork or snapshot holds them, and its own objects go too", async t => {
  const { storage, volumes, write, collect } = await setup(t);
  const source = await volumes.create("acme", { name: "source" });
  await write(source.id, "/shared.txt", "delta");
  const fork = await volumes.call(source.id, "acme", "fork", {});
  const snapshotted = await volumes.create("acme", { name: "snapshotted" });
  await write(snapshotted.id, "/s.txt", "epsilon");
  const snapshot = await volumes.call(snapshotted.id, "acme", "snapshot", {});
  await volumes.call(snapshotted.id, "acme", "remove", { path: "/s.txt" });

  await volumes.call(source.id, "acme", "delete");
  await collect();
  assert.equal(storage.blobs.has(key("delta")), true, "the fork shares it");
  assert.equal(storage.blobs.has(key("epsilon")), true, "the snapshot holds it");
  assert.equal([...storage.logs.keys()].some(name => name.startsWith(`volumes/${source.id}/`)), false, "the deleted volume's tree is gone");

  await volumes.call(fork.id, "acme", "delete");
  await volumes.call(snapshotted.id, "acme", "deleteSnapshot", { snapshot: snapshot.id });
  assert.equal([...storage.blobs.keys()].some(name => name.includes(snapshot.id)), false, "a deleted snapshot's file map goes at once");
  await collect();
  assert.equal(storage.blobs.has(key("delta")), false);
  assert.equal(storage.blobs.has(key("epsilon")), false);
});

test("a chunk written again between two collections stays; one written as it is deleted is put back; one stored before collection existed is never touched", async t => {
  const { gc, storage, volumes, write, collect } = await setup(t);
  const { id } = await volumes.create("acme", { name: "v" });
  await write(id, "/z.txt", "zeta");
  await volumes.call(id, "acme", "remove", { path: "/z.txt" });
  await gc.run("acme");
  await write(id, "/again.txt", "zeta");
  await gc.run("acme");
  assert.equal(storage.blobs.has(key("zeta")), true, "written again: it is a file's once more");

  // A writer that stores the same bytes as the collector deletes them: its write finds the chunk there, so it is put back.
  await write(id, "/eta.txt", "eta");
  await volumes.call(id, "acme", "remove", { path: "/eta.txt" });
  await gc.run("acme");
  const remove = storage.removeBlob.bind(storage);
  storage.removeBlob = async name => { await remove(name); if (name === key("eta")) await volumes.store("acme", Buffer.from("eta")).then(() => {}, () => {}); };
  const racing = await gc.run("acme");
  storage.removeBlob = remove;
  assert.equal(racing.restored, 1);
  assert.equal(storage.blobs.has(key("eta")), true);

  await storage.writeBlob(key("legacy"), Buffer.from("legacy"));
  await collect();
  assert.equal(storage.blobs.has(key("legacy")), true, "only chunks written since collection began are collected");
});

test("on a runtime, an attachment's chunks are pinned to its agent, and collected once the agent and its workspace are deleted", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_GC_ENABLED: "true", AGENT_PURGE_INTERVAL_MS: "1000", AGENT_GC_GRACE_MS: "0", AGENT_GC_INTERVAL_MS: "0", AGENT_GC_POLL_MS: "200" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "read this", files: [{ name: "note.txt", data: Buffer.from("attached words").toString("base64") }] } });
  assert.equal(accepted.status, 202, accepted.text);
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json.state === "completed", "the turn");
  const pinned = await r.db.query("select hash from chunk_pins where agent = $1", [agent]);
  assert.deepEqual(pinned.rows.map(row => row.hash), [hash("attached words")], "the message's FileRef pins its chunk");

  assert.equal((await r.call(`/v1/agents/${agent}`, { method: "DELETE" })).status, 200);
  await until(async () => (await r.db.query("select count(*)::int as count from chunk_touches where hash = $1", [hash("attached words")])).rows[0].count === 0, "the chunk to be collected", 30_000);
  assert.equal((await r.db.query("select count(*)::int as count from chunk_pins where agent = $1", [agent])).rows[0].count, 0);
});

test("only chunks a write created are ever collected: bytes stored before collection began stay, even when written or pinned again", async t => {
  const { db, storage, volumes, write, collect } = await setup(t);
  // Stored before collection began, with no record: a FileRef from then may hold it with no pin.
  await storage.writeBlob(key("old bytes"), Buffer.from("old bytes"));
  const { id } = await volumes.create("acme", { name: "v" });
  const entry = await write(id, "/again.txt", "old bytes");
  await volumes.pin("acme", "client_new", entry.chunks);
  await volumes.call(id, "acme", "remove", { path: "/again.txt" });
  await db.query("delete from chunk_pins where agent = 'client_new'");
  await collect();
  assert.equal(storage.blobs.has(key("old bytes")), true, "written again (a no-op) or pinned, it is still not collectable");
});

test("a reference made while a collection is under way (a move between volumes, a fork) keeps its chunk, even when the mark missed it", async t => {
  const { storage, volumes, gc, write } = await setup(t);
  const from = await volumes.create("acme", { name: "from" });
  const to = await volumes.create("acme", { name: "to" });
  const entry = await write(from.id, "/moving.txt", "theta");
  await volumes.call(from.id, "acme", "remove", { path: "/moving.txt" });
  await gc.run("acme");
  // Moved into another volume by its chunks (as a cross-volume mv commits them), after the chunk was found unreferenced...
  await volumes.call(to.id, "acme", "commit", { path: "/moved.txt", chunks: entry.chunks, size: entry.size });
  // ...and a torn mark that read the other volume before the move.
  const read = volumes.referencedChunks.bind(volumes);
  volumes.referencedChunks = async id => id === to.id ? new Set() : read(id);
  await gc.run("acme");
  volumes.referencedChunks = read;
  assert.equal(storage.blobs.has(key("theta")), true, "the move touched it");

  const forked = await volumes.create("acme", { name: "forked" });
  await write(forked.id, "/f.txt", "iota");
  const clone = await volumes.call(forked.id, "acme", "fork", {});
  await volumes.call(forked.id, "acme", "delete");
  await gc.run("acme");
  volumes.referencedChunks = async id => id === clone.id ? new Set() : read(id);
  await gc.run("acme");
  volumes.referencedChunks = read;
  assert.equal(storage.blobs.has(key("iota")), true, "the fork touched it");
});

test("two collections of one tenant at once delete a chunk once, and take it off the meter once", async t => {
  const { db, storage, volumes, write, metered } = await setup(t);
  const other = new StorageGc({ db, storage, volumes, graceMs: 0 });
  const first = new StorageGc({ db, storage, volumes, graceMs: 0 });
  const { id } = await volumes.create("acme", { name: "v" });
  await write(id, "/k.txt", "kappa");
  await volumes.call(id, "acme", "remove", { path: "/k.txt" });
  await first.run("acme");
  const [a, b] = await Promise.all([first.run("acme"), other.run("acme")]);
  assert.equal(a.removed + b.removed, 1);
  assert.equal(metered.get(key("kappa")), 0);
});

test("a dry run reports what it would delete, and deletes nothing", async t => {
  const { db, storage, volumes, write } = await setup(t);
  const dry = new StorageGc({ db, storage, volumes, graceMs: 0, dryRun: true });
  const { id } = await volumes.create("acme", { name: "v" });
  await write(id, "/l.txt", "lambda");
  await volumes.call(id, "acme", "remove", { path: "/l.txt" });
  await volumes.call(id, "acme", "delete");
  await dry.run("acme");
  const result = await dry.run("acme");
  assert.deepEqual([result.removed, result.wouldRemove, result.purgedVolumes], [0, 1, 0]);
  assert.equal(storage.blobs.has(key("lambda")), true);
  assert.equal([...storage.logs.keys()].some(name => name.startsWith(`volumes/${id}/`)), true, "nor a deleted volume's objects");
});

test("a new agent's initial messages pin the FileRefs they carry: a clone keeps its files after its source is gone", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_GC_ENABLED: "true", AGENT_PURGE_INTERVAL_MS: "1000", AGENT_GC_GRACE_MS: "0", AGENT_GC_INTERVAL_MS: "0", AGENT_GC_POLL_MS: "200" });
  const source = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const accepted = await r.call(`/v1/agents/${source}/prompt`, { body: { text: "keep this", files: [{ name: "kept.txt", data: Buffer.from("cloned words").toString("base64") }] } });
  await until(async () => (await r.call(`/v1/agents/${source}/requests/${accepted.json.id}`)).json.state === "completed", "the turn");
  const history = (await r.call(`/v1/agents/${source}/history`)).json.messages;
  const clone = (await r.call("/v1/agents", { body: { initialMessages: history } })).json.id as string;
  assert.deepEqual((await r.db.query("select hash from chunk_pins where agent = $1", [clone])).rows.map(row => row.hash), [hash("cloned words")]);
  assert.equal((await r.call(`/v1/agents/${source}`, { method: "DELETE" })).status, 200);
  await until(async () => (await r.db.query("select count(*)::int as count from chunk_pins where agent = $1", [source])).rows[0].count === 0, "the source's purge", 20_000);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal((await r.db.query("select count(*)::int as count from chunk_touches where hash = $1", [hash("cloned words")])).rows[0].count, 1, "still stored: the clone holds it");
});

test("an agent whose initial messages' FileRefs could not be pinned is not made", async t => {
  const { db, storage, volumes } = await setup(t);
  const root = await mkdtemp(join(tmpdir(), "gc-pins-"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage });
  const sessions = new ClientSessions(supervisor, { db, storage, prefix: "client-sessions/", secret: "gc-pin-test-secret-with-32-characters", apiKeyFor: () => "fixture-only", volumes });
  t.after(async () => { await sessions.close(); await supervisor.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const ref = { type: "file", path: "/workspace/a.txt", volume: "vol_000000000000000000000000", version: 1, size: 5, contentType: "text/plain", chunks: [hash("alpha")] };
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 } as Model<Api>;
  volumes.pin = async () => { throw new Error("the database went away"); };
  await assert.rejects(sessions.create([], { model, initialMessages: [{ role: "user", content: [{ type: "text", text: "see" }, ref], timestamp: 0 }] } as any, "cloned", {}, "acme"), /database went away/);
  assert.equal((await db.query("select count(*)::int as count from agents where tenant = 'acme'")).rows[0].count, 0, "no agent without its pins");
});
