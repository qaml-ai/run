import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Db } from "../src/db.ts";
import { archiveAgent, archiveWalk, ArchiveCursorError } from "../src/history-archive.ts";
import { HistoryIndex } from "../src/history-pages.ts";
import { HostJournal } from "../src/pi-durable/host-journal.ts";
import { seedJournal } from "../src/pi-durable/seed.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { fileStorage, type Storage } from "../shared/storage.ts";
import { testDatabase } from "./database.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 }) as unknown as AgentMessage;

async function chunk(db: Db, storage: Storage, agent: string, start: number, messages: AgentMessage[], turns: number[]) {
  const body = Buffer.from(JSON.stringify(messages));
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  await storage.writeBlob(`sessions/${agent}/history/${start}-${messages.length}-${hash}`, body);
  await db.query("insert into agent_history_chunks (agent, start, count, bytes, turns, hash) values ($1, $2, $3, $4, $5, $6)", [agent, start, messages.length, body.length, turns, hash]);
  await db.query("insert into agent_history_index (agent, indexed) values ($1, $2) on conflict (agent) do update set indexed = excluded.indexed", [agent, start + messages.length]);
}

/** An agent retired from its host transcript: `old` in the index's chunks (two messages each), its journal from there. */
async function retired(db: Db, blobs: Storage, root: string, agent: string, old: AgentMessage[], after: AgentMessage[]) {
  await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, 't', '{}', 'a', 'general', 'm', null, false, 1)", [agent]);
  const storage = await openPiStorage({ sessionId: agent, directory: join(root, agent), db });
  await seedJournal({ storage, sessionId: agent, model: [{ role: "system", content: "Rules.", timestamp: 0 } as never], before: { total: old.length } });
  const journal = (await HostJournal.open(storage))!;
  await journal.setActive(true);
  await journal.append(after);
  await journal.setActive(false);
  await storage.close(BACKGROUND_CONTEXT);
  // The last chunk runs past the base, as an index that indexed what the journal holds too.
  for (let start = 0; start < old.length; start += 2) {
    const messages = start + 2 >= old.length ? [...old.slice(start), ...after.slice(0, 1)] : old.slice(start, start + 2);
    await chunk(db, blobs, agent, start, messages, [start]);
  }
}

test("history before the journal moves into Pi storage as archive entries, a chunk per commit: resumable, idempotent, and read the same after", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blobs = fileStorage(root);
  const index = new HistoryIndex(db, blobs);
  const old = [user("o1"), assistant("O1"), user("o2"), assistant("O2"), user("o3"), assistant("O3")];
  const after = [user("new"), assistant("N")];
  await retired(db, blobs, root, "client_a", old, after);
  await retired(db, blobs, root, "client_b", [user("b1"), assistant("B1")], [user("b2"), assistant("B2")]);
  // A gap the index does not hold, and an agent with no Pi storage.
  await retired(db, blobs, root, "client_c", [user("c1"), assistant("C1"), user("c2"), assistant("C2")], [user("c3")]);
  await db.query("delete from agent_history_chunks where agent = 'client_c' and start = 0");
  await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ('client_d', 't', '{}', 'a', 'general', 'm', null, false, 1)");
  const before = { a: await index.messages("client_a"), b: await index.messages("client_b"), pageA: await index.page("client_a", { limit: 1 }) };
  assert.deepEqual(before.a, [...old, ...after]);

  const coverage = await archiveWalk(db, blobs, {});
  assert.deepEqual(coverage.counts, { archived: 0, pending: 2, short: 1, unplaced: 0, no_journal: 1, agents_total: 4 });
  assert.deepEqual(coverage.gate, { ready: false, blocking: ["pending", "short"] });
  const dry = await archiveWalk(db, blobs, { move: {} });
  assert.equal(dry.moves!.would_move, 2);
  assert.deepEqual(dry.results!.find(result => result.agent === "client_a"), { agent: "client_a", code: "would_move", chunks: 3, messages: 6, bytes: dry.results!.find(result => result.agent === "client_a")!.bytes });
  assert.equal((await db.query("select count(*)::int as n from pi_durable_entries where session_id = 'client_a' and record like '%camel.history.archive%'")).rows[0].n, 0, "a dry run writes nothing");
  let clock = 0;
  const stoppedDry = await archiveWalk(db, blobs, { move: {}, batch: 1, budgetMs: 1, now: () => clock++ });
  assert.ok(stoppedDry.next);
  await assert.rejects(archiveWalk(db, blobs, { move: { dryRun: false }, cursor: stoppedDry.next }), ArchiveCursorError);

  // A move the budget stops after one chunk goes on from there.
  let ticks = 0;
  const partial = await archiveAgent(db, blobs, "client_a", { dryRun: false, deadline: 1, now: () => ticks++ });
  assert.equal(partial.code, "failed");
  assert.match(partial.error!, /stopped by the call's budget at message 2/);
  // A busy agent is left for a later call.
  await db.query("update agents set pending_runs = true where id = 'client_b'");
  assert.equal((await archiveAgent(db, blobs, "client_b", { dryRun: false })).code, "skipped_busy");
  await db.query("update agents set pending_runs = false where id = 'client_b'");

  const moved = await archiveWalk(db, blobs, { move: { dryRun: false } });
  assert.deepEqual([moved.moves!.moved, moved.moves!.failed], [2, 0]);
  // Read the same, now from Pi storage alone: the index's chunks are not needed any more.
  await db.query("delete from agent_history_chunks where agent in ('client_a', 'client_b')");
  assert.deepEqual(await index.messages("client_a"), before.a);
  assert.deepEqual(await index.messages("client_b"), before.b);
  assert.deepEqual(await index.page("client_a", { limit: 1 }), before.pageA);
  assert.deepEqual(await index.allTurns("client_a"), [0, 2, 4, 6]);
  assert.equal((await archiveAgent(db, blobs, "client_a", { dryRun: false })).code, "current", "moved once");
  const done = await archiveWalk(db, blobs, {});
  assert.deepEqual(done.counts, { archived: 2, pending: 0, short: 1, unplaced: 0, no_journal: 1, agents_total: 4 });
  assert.deepEqual(done.examples, { short: ["client_c"] });
});
