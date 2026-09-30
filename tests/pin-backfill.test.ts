import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { backfillPins } from "../src/pin-backfill.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { testDatabase } from "./database.ts";

const hash = (name: string) => createHash("sha256").update(name).digest("hex");
const ref = (...names: string[]) => ({ type: "file", path: `/workspace/${names[0]}`, volume: "vol_1", version: 1, size: 10, contentType: "text/plain", chunks: names.map(hash) });

test("the backfill pins every FileRef a live agent holds, anywhere it is kept, once; a dry run only counts", async () => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const agent = async (id: string, tenant: string, header: object = {}, purged = false) =>
    db.query("insert into agents (id, tenant, header, revision, name, type, model, purged_at) values ($1, $2, $3, 1, $1, 'general', 'm', $4)", [id, tenant, JSON.stringify({ id, tenant, ...header }), purged ? Date.now() : null]);
  const append = async (key: string, records: unknown[]) => {
    const log = storage.log<unknown>(key);
    await log.read();
    for (const record of records) log.append(record);
    await log.flush(true);
    await log.close();
  };

  // A clone's initialMessages, a transcript (with a message a reset later dropped), a run's presented file, and a history page.
  await agent("client_a", "acme", { config: { initialMessages: [{ role: "user", content: [ref("cloned")] }] } });
  await append(AgentSupervisor.transcriptKey("client_a"), [
    { t: "message", message: { role: "user", content: [{ type: "text", text: "see" }, ref("attached", "attached-2")] } },
    { t: "reset", messages: [] },
    { t: "message", message: { role: "toolResult", content: [ref("saved")] } },
  ]);
  await append("client-sessions/client_a.journal", [{ t: "request", id: "r1", outcome: { outputs: { presented: [{ ...ref("presented"), caption: "here" }] } } }]);
  const page = Buffer.from(JSON.stringify([{ role: "user", content: [ref("paged")] }]));
  await storage.writeBlob("sessions/client_a/history/0-1-abc", page);
  await db.query("insert into agent_history_chunks (agent, start, count, bytes, turns, hash) values ('client_a', 0, 1, $1, '{}', 'abc')", [page.length]);
  // Another tenant's agent, one already pinned, and a purged agent that must be left alone.
  await agent("client_b", "other");
  await append(AgentSupervisor.transcriptKey("client_b"), [{ t: "message", message: { role: "user", content: [ref("attached")] } }]);
  await db.query("insert into chunk_pins (tenant, hash, agent) values ('other', $1, 'client_b')", [hash("attached")]);
  await agent("client_gone", "acme", {}, true);
  await append(AgentSupervisor.transcriptKey("client_gone"), [{ t: "message", message: { role: "user", content: [ref("gone")] } }]);

  const pins = async () => (await db.query("select tenant, agent, hash from chunk_pins order by tenant, agent, hash")).rows;
  const counts = await backfillPins({ db, storage, dryRun: true });
  assert.deepEqual(counts, [
    { tenant: "acme", agents: 1, refs: 5, chunks: 6, missing: 6, inserted: 0, unreadable: 0 },
    { tenant: "other", agents: 1, refs: 1, chunks: 1, missing: 0, inserted: 0, unreadable: 0 },
  ]);
  assert.equal((await pins()).length, 1, "a dry run inserts nothing");

  const done = await backfillPins({ db, storage });
  assert.equal(done[0].inserted, 6);
  const expected = ["cloned", "attached", "attached-2", "saved", "presented", "paged"].map(name => ({ tenant: "acme", agent: "client_a", hash: hash(name) }));
  assert.deepEqual((await pins()).filter(pin => pin.tenant === "acme"), expected.sort((a, b) => a.hash.localeCompare(b.hash)));
  assert.ok(!(await pins()).some(pin => pin.agent === "client_gone"), "a purged agent gets no pins");
  assert.deepEqual((await backfillPins({ db, storage })).map(row => [row.missing, row.inserted]), [[0, 0], [0, 0]], "idempotent");
});

test("what the backfill cannot read is counted and reported, and the rest is still pinned", async () => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ('client_a', 'acme', '{}', 1, 'a', 'general', 'm')");
  const log = storage.log<unknown>(AgentSupervisor.transcriptKey("client_a"));
  await log.read();
  log.append({ t: "message", message: { role: "user", content: [ref("kept")] } });
  await log.flush(true);
  await log.close();
  await db.query("insert into agent_history_chunks (agent, start, count, bytes, turns, hash) values ('client_a', 0, 1, 10, '{}', 'lost')");
  const errors: string[] = [];
  const [row] = await backfillPins({ db, storage, onError: (agent, what) => errors.push(`${agent} ${what}`) });
  assert.deepEqual([row.inserted, row.unreadable], [1, 1]);
  assert.deepEqual(errors, ["client_a history 0"]);
});
