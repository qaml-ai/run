import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EntryId, EntryRecord, Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { Db } from "../src/db.ts";
import { durableEntryMessages } from "../src/pi-durable/agent.ts";
import { HostJournal } from "../src/pi-durable/host-journal.ts";
import { JournalHistory, MARKER_KIND } from "../src/pi-durable/history.ts";
import { fillOrdinals, historyPositions } from "../src/pi-durable/ordinals.ts";
import { seedJournal, SESSION_CONVERSATION_ID as conversationId } from "../src/pi-durable/seed.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { ordinalWalk, OrdinalCursorError } from "../src/history-ordinals.ts";
import { testDatabase } from "./database.ts";

const user = (content: string, requestId?: string) => ({ role: "user", content, timestamp: 1, ...(requestId ? { requestId } : {}) }) as AgentMessage;
const system = { role: "system", content: "Rules.", timestamp: 0 } as AgentMessage;
const reply = (text: string) => fauxAssistantMessage(text) as AgentMessage;
const call = (id: string) => fauxAssistantMessage([fauxToolCall("lookup", {}, { id })], { stopReason: "toolUse" }) as AgentMessage;
const result = (id: string, text = "found") => ({ role: "toolResult", toolCallId: id, toolName: "lookup", content: [{ type: "text", text }], isError: false, timestamp: 2 }) as AgentMessage;

let db: Db;
let root: string;
test.before(async () => { ({ db } = await testDatabase()); root = await mkdtemp(join(tmpdir(), "ordinals-")); });

const open = (session: string) => openPiStorage({ sessionId: session, directory: join(root, session), db });

/**
 * The history as its ordinals give it: each placed row's messages, in ordinal order, and where turns start. Every
 * ordinal from the first placed one to `history_next` must be held by exactly one row.
 */
async function byOrdinal(session: string) {
  const rows = (await db.query<{ id: string; record: string; msg_from: number; msg_count: number; msg_skip: number; turn_start: boolean }>(
    "select id, record, msg_from, msg_count, msg_skip, turn_start from pi_durable_entries where session_id = $1 and msg_from is not null order by msg_from, id", [session])).rows;
  const next = (await db.query("select history_next from pi_durable_metadata where session_id = $1", [session])).rows[0].history_next as number | null;
  const messages: AgentMessage[] = [];
  let from: number | undefined;
  for (const row of rows.filter(row => row.msg_count > 0)) {
    const entry = JSON.parse(row.record) as EntryRecord;
    from ??= row.msg_from;
    assert.equal(row.msg_from, from + messages.length, `entry ${row.id} is placed where the history before it ends`);
    const own = entry.kind === MARKER_KIND ? (entry.data as unknown as { kept: AgentMessage[] }).kept : durableEntryMessages(entry).map(item => item.message);
    messages.push(...own.slice(row.msg_skip, row.msg_skip + row.msg_count));
  }
  if (from !== undefined) assert.equal(next, from + messages.length, "history_next is the history's length");
  return { from: from ?? next, next, messages, turns: rows.filter(row => row.turn_start).map(row => row.msg_from) };
}

/** The history as `JournalHistory` reads it from the journal, from where it holds messages on. */
async function byJournal(storage: Storage) {
  const history = (await JournalHistory.openAny(storage))!;
  return { from: history.heldFrom, next: history.total, messages: (await history.messagesFrom(history.heldFrom))!, turns: history.turnsFrom(history.heldFrom) };
}

async function assertSame(session: string, storage: Storage, label: string) {
  const journal = await byJournal(storage), ordinals = await byOrdinal(session);
  assert.equal(ordinals.next, journal.next, `${label}: length`);
  assert.deepEqual(ordinals.messages, journal.messages.slice(journal.messages.length - ordinals.messages.length), `${label}: messages`);
  assert.equal(ordinals.messages.length, journal.messages.length, `${label}: every message held is placed`);
  assert.deepEqual(ordinals.turns, journal.turns, `${label}: turn starts`);
}

/** Clears an agent's ordinals, as a session from before them has none. */
async function unplace(session: string) {
  await db.query("update pi_durable_entries set msg_from = null, msg_count = null, msg_skip = 0, turn_start = false where session_id = $1", [session]);
  await db.query("update pi_durable_metadata set history_next = null, history_last_id = null where session_id = $1", [session]);
}
const columns = async (session: string) => (await db.query("select id, msg_from, msg_count, msg_skip, turn_start from pi_durable_entries where session_id = $1 order by id", [session])).rows;
const metadata = async (session: string) => (await db.query("select history_next, history_last_id from pi_durable_metadata where session_id = $1", [session])).rows[0];

/** A session as a host keeps it: seeded, a few turns with tool calls, retractions, calls left waiting, and a reply from a person. */
async function busySession(session: string, turns = 3, before = 0) {
  const storage = await open(session);
  await seedJournal({ storage, sessionId: session, model: [system as never], messages: [user("imported")], ...(before ? { before: { total: before } } : {}) });
  const journal = (await HostJournal.open(storage))!;
  for (let turn = 0; turn < turns; turn++) {
    await journal.setActive(true);
    await journal.append([user(`ask ${turn}`, `r${turn}`), call(`c${turn}`)]);
    await journal.append([reply("a failure")]);
    await journal.retract();
    await journal.await([`c${turn}`]);
    await journal.push(result(`c${turn}`));
    await journal.append([reply(`answer ${turn}`), reply("replaced")]);
    await journal.retract();
    await journal.setActive(false);
  }
  return { storage, journal };
}

test("an entry's history positions are durableEntryMessages', a placeholder waiting on a person left out", () => {
  const entries: EntryRecord[] = [
    { id: 1 as EntryId, conversationId, kind: "pi.assistant", model: [call("x")] as never },
    { id: 2 as EntryId, conversationId, kind: "pi.tool-result", model: [result("x"), { ...result("y"), details: { inputRequired: true } }, result("z")] as never },
    { id: 3 as EntryId, conversationId, kind: "camel.user", model: [{ role: "user", content: "a" }] as never, data: { message: user("a") } as never },
    { id: 4 as EntryId, conversationId, kind: "camel.system", model: [system] as never },
    { id: 5 as EntryId, conversationId, kind: MARKER_KIND, data: { t: "turn", active: true } as never },
    { id: 6 as EntryId, conversationId, kind: "pi.user", model: [] as never },
  ];
  for (const entry of entries) assert.deepEqual(historyPositions(entry), durableEntryMessages(entry).map(item => item.cursor.index), `entry ${entry.id}`);
});

test("commits place each history entry as JournalHistory counts it: a new session from its seed on, retractions, turns and waiting calls", async () => {
  const { storage } = await busySession("live");
  await assertSame("live", storage, "live");
  assert.deepEqual((await byOrdinal("live")).turns, [0, 1, 5, 9], "the seed's, then each turn after the last");
  // A fork's history starts past the messages it copied (the history index's until they move into Pi).
  const fork = await busySession("forked", 1, 40);
  const ordinals = await byOrdinal("forked");
  assert.equal(ordinals.from, 40);
  await assertSame("forked", fork.storage, "fork");
  await storage.close(context); await fork.storage.close(context);
});

test("an entry committed after one with a later ID takes its place in ID order, and those after it move up", async () => {
  const { storage, journal } = await busySession("late", 1);
  const [early, later] = [await storage.mintId<EntryId>(), await storage.mintId<EntryId>()];
  const entry = (id: EntryId, message: AgentMessage, kind = "pi.assistant"): StorageWrite => ({ type: "entry", value: { id, conversationId, kind, model: [message] as never } });
  await storage.commit([entry(later, reply("second"))], () => {}, context);
  await storage.commit([entry(early, user("first"), "pi.user")], () => {}, context);
  await journal.refresh();
  await assertSame("late", storage, "late");
  assert.deepEqual((await byOrdinal("late")).messages.slice(-2).map(message => (message as { role: string }).role), ["user", "assistant"]);
  await storage.close(context);
});

test("a skip of a discarded run's messages leaves the session unplaced, and the fill places it as JournalHistory reads it", async () => {
  const { storage, journal } = await busySession("skipped", 1);
  await journal.setActive(true);
  await journal.append([user("go"), call("lost")]);
  const after = journal.history.latest!;
  await storage.commit([{ type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: "pi.tool-result", model: [result("lost", "discarded")] as never } }], () => {}, context);
  await journal.refresh();
  await journal.skip(journal.history.latest!, after);
  await journal.setActive(false);
  assert.equal((await metadata("skipped")).history_next, null, "unplaced");
  assert.equal((await fillOrdinals(db, "skipped", { dryRun: false })).code, "placed");
  await assertSame("skipped", storage, "skipped");
  assert.ok(!(await byOrdinal("skipped")).messages.some(message => JSON.stringify(message).includes("discarded")));
  await storage.close(context);
});

test("the fill places a session from before ordinals as its commits would have, once; a dry run writes nothing", async () => {
  const { storage, journal } = await busySession("old", 4);
  // Later bases (a rebase) must stand where the history does.
  const placed = await columns("old"), state = await metadata("old");
  await unplace("old");
  const dry = await fillOrdinals(db, "old", { dryRun: true });
  assert.equal(dry.code, "would_place");
  assert.equal(dry.total, journal.total);
  assert.equal((await metadata("old")).history_next, null, "a dry run writes nothing");
  const filled = await fillOrdinals(db, "old", { dryRun: false });
  assert.equal(filled.code, "placed");
  assert.deepEqual(await columns("old"), placed, "the same places as its commits gave");
  assert.deepEqual(await metadata("old"), state);
  assert.equal((await fillOrdinals(db, "old", { dryRun: false })).code, "current", "placed once");
  // Entries written since by a release that did not place them: stale, and placed again.
  await db.query("update pi_durable_metadata set history_next = null where session_id = $1", ["old"]);
  await journal.append([user("unplaced write")]);
  await db.query("update pi_durable_metadata set history_next = $2, history_last_id = $3 where session_id = $1", ["old", state.history_next, state.history_last_id]);
  assert.equal((await fillOrdinals(db, "old", { dryRun: false })).code, "placed");
  await assertSame("old", storage, "after a stale fill");
  // Commits go on placing from there.
  await journal.append([reply("placed write")]);
  await assertSame("old", storage, "after more commits");
  assert.equal((await fillOrdinals(db, "old", { dryRun: false, maxEntries: 3 })).code, "current");
  await unplace("old");
  assert.equal((await fillOrdinals(db, "old", { dryRun: false, maxEntries: 3 })).code, "too_large");
  await storage.close(context);
});

test("the fill places a retired host transcript's session from its base's cursor, with the running turn's kept messages in its marker", async () => {
  const storage = await open("retired");
  const ids = await Promise.all(Array.from({ length: 6 }, () => storage.mintId<EntryId>()));
  const kept = [user("running"), call("k")], later = reply("after the cursor");
  const writes: StorageWrite[] = [
    { type: "conversation", value: { id: conversationId } } as StorageWrite,
    { type: "entry", value: { id: ids[0], conversationId, kind: "camel.host.bootstrap" } },
    { type: "entry", value: { id: ids[1], conversationId, kind: "pi.user", model: [user("before the cursor")] as never } },
    { type: "entry", value: { id: ids[2], conversationId, kind: "pi.assistant", model: [later] as never } },
    { type: "entry", value: { id: ids[3], conversationId, kind: MARKER_KIND, data: { t: "base", total: 12, through: { entryId: ids[1], index: 0 }, active: true, turnStart: 10, awaiting: [], kept } as never } },
    { type: "entry", value: { id: ids[4], conversationId, kind: "pi.tool-result", model: [result("k")] as never } },
    { type: "entry", value: { id: ids[5], conversationId, kind: MARKER_KIND, data: { t: "retract", index: 13 } as never } },
  ];
  await storage.commit(writes, () => {}, context);
  await db.query("update pi_durable_metadata set history_next = null, history_last_id = null where session_id = 'retired'");
  assert.equal((await fillOrdinals(db, "retired", { dryRun: false })).code, "placed");
  const ordinals = await byOrdinal("retired");
  assert.equal(ordinals.from, 10, "from the running turn's kept messages");
  assert.deepEqual(ordinals.messages, [...kept, later], "the base's kept, then what followed its cursor; the result taken back");
  assert.equal(ordinals.next, 13);
  await storage.close(context);
});

test("coverage counts agents by whether their history is placed; the fill walks them all, a dry run first, resumable by cursor", async () => {
  const agent = (id: string) => db.query("insert into agents (id, tenant, header, revision, name, type, model) values ($1, 'ops', '{}', 1, 'test', 'test', 'test') on conflict do nothing", [id]);
  for (const id of ["live", "forked", "late", "skipped", "old", "retired"]) await agent(id);
  await agent("nopi");
  for (const id of ["w1", "w2", "w3"]) { const { storage } = await busySession(id, 2); await storage.close(context); await agent(id); await unplace(id); }
  const coverage = await ordinalWalk(db, { batch: 4 });
  assert.equal(coverage.complete, true);
  assert.equal(coverage.counts.no_journal, 1);
  assert.equal(coverage.counts.unplaced, 4, "w1-w3 and retired");
  assert.deepEqual(coverage.gate, { ready: false, blocking: ["unplaced"] });
  // A walk stopped by its budget goes on from its cursor; a dry run's cursor is a dry run's.
  let ticks = 0;
  const first = await ordinalWalk(db, { fill: {}, batch: 2, budgetMs: 1, now: () => ticks++ });
  assert.equal(first.complete, false);
  await assert.rejects(ordinalWalk(db, { cursor: first.next!, fill: { dryRun: false } }), OrdinalCursorError);
  await assert.rejects(ordinalWalk(db, { cursor: first.next! }), OrdinalCursorError, "a fill's cursor is not coverage's");
  let walk = first;
  while (walk.next) walk = await ordinalWalk(db, { cursor: walk.next, fill: {} });
  assert.equal(walk.fills!.would_place, 4);
  assert.equal((await metadata("w1")).history_next, null);
  walk = await ordinalWalk(db, { fill: { dryRun: false } });
  assert.equal(walk.fills!.placed, 4);
  const after = await ordinalWalk(db, {});
  assert.deepEqual(after.gate, { ready: true, blocking: [] });
  assert.equal(after.counts.placed, 9);
});

test("a big session (pages of the fill), with compactions and context checkpoints that are not history, fills as its commits placed it", async () => {
  const { storage, journal } = await busySession("big", 1);
  for (let turn = 0; turn < 120; turn++) {
    await journal.setActive(true);
    await journal.append([user(`ask ${turn}`), call(`b${turn}`)]);
    await journal.push(result(`b${turn}`, "x".repeat(2_000)));
    if (turn % 10 === 0) await storage.commit([
      { type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: "pi.compaction", data: { summary: `summary ${turn}` } as never } },
      { type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: "camel.context.message", model: [user("checkpoint")] as never } },
    ], () => {}, context);
    await journal.append([reply(`answer ${turn}`)]);
    await journal.setActive(false);
  }
  await assertSame("big", storage, "big");
  const placed = await columns("big");
  await unplace("big");
  assert.equal((await fillOrdinals(db, "big", { dryRun: false })).code, "placed");
  assert.deepEqual(await columns("big"), placed);
  await storage.close(context);
});
