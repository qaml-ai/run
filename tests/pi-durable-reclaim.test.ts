import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { EntryId, StorageWrite } from "@earendil-works/pi-durable";
import type { Db } from "../src/db.ts";
import { HOST_TRANSCRIPT, reclaimCheckpoints, reclaimHostTranscripts, reclaimSession, type ReclaimSession } from "../src/pi-durable/reclaim.ts";
import { PostgresPiStorage } from "../src/pi-durable/storage.ts";
import { contextAt } from "../src/pi-durable/fork.ts";
import { testDatabase } from "./database.ts";
import { lastUser, runtime, until } from "./runtime-server.ts";

const database = testDatabase();
const never = ["pi.user", "pi.assistant", "pi.tool-result", "camel.user", "camel.message", "camel.history.marker",
  "pi.compaction", "camel.compaction.usage", "camel.legacy.migration", "camel.host.bootstrap", "camel.host.record", "camel.host.archive"];
async function fixture(content = "content must never be logged") {
  const { db } = await database;
  const session = randomUUID();
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ($1, 'test', '{}', 1, 'test', 'test', 'test')", [session]);
  const storage = await PostgresPiStorage.open(db, session);
  const kinds = ["camel.legacy.context", "camel.context.message", "pi.system", ...never, "camel.legacy.context", "camel.context.message", "pi.system"];
  const writes: StorageWrite[] = [{ type: "conversation", value: { id: 1 as never } }, { type: "conversation", value: { id: 100 as never } }];
  kinds.forEach((kind, i) => writes.push({ type: "entry", value: { id: (i + 2) as EntryId, conversationId: 1 as never, kind,
    ...(kind === "camel.legacy.context" ? { head: (i + 2) as EntryId } : {}), data: { fixture: content } } }));
  writes.push({ type: "entry", value: { id: 101 as EntryId, conversationId: 100 as never, kind: "pi.system" } });
  await storage.commit(writes, () => {}, context);
  await storage.close(context);
  return { db, session, before: await snapshot(db, session) };
}
async function snapshot(db: Db, session: string) {
  return (await db.query("select id, conversation_id, record from pi_durable_entries where session_id = $1 order by id", [session])).rows;
}

test("stage 1 CLI defaults to dry-run, sizes exact rows, and writes nothing; apply preserves every other row and every reserved ID", async () => {
  const { db, session, before } = await fixture();
  const idsBefore = (await db.query("select * from pi_durable_record_ids where session_id = $1 order by id", [session])).rows;
  const ownersBefore = (await db.query("select * from actor_owners where actor = $1", [session])).rows;
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/ops/reclaim-checkpoints.ts", "--session", session],
    { env: { ...process.env, AGENT_DATABASE_URL: (await database).url } });
  const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines[0].type, "reclaim_session");
  assert.equal(lines[0].rows, 3);
  assert.equal(lines[0].skipped_reason, null);
  assert.equal(lines[1].mode, "dry-run");
  assert.equal(stdout.includes("content must never be logged"), false);
  assert.deepEqual(await snapshot(db, session), before);
  assert.deepEqual((await db.query("select * from actor_owners where actor = $1", [session])).rows, ownersBefore);
  const events: ReclaimSession[] = [];
  const applied = await reclaimCheckpoints(db, { apply: true, session, limit: 1 }, row => events.push(row));
  assert.equal(applied.rows, 3);
  assert.equal(applied.bytes, lines[0].bytes);
  assert.equal(events[0].skipped_reason, null);
  assert.deepEqual(await snapshot(db, session), before.filter(row => ![2, 3, 4].includes(Number(row.id))));
  assert.deepEqual((await db.query("select * from pi_durable_record_ids where session_id = $1 order by id", [session])).rows, idsBefore);
  assert.equal((await reclaimCheckpoints(db, { apply: true, session }, () => {})).sessions, 0, "repeat run has nothing to reclaim");
});

test("records holding a NUL (a binary file read as text) neither stop a run nor change what it selects", async () => {
  // jsonb refuses \u0000, and json's ->> too: one such record anywhere stopped the first dry run in production.
  const { db, session, before } = await fixture("PK\u0003\u0004\u0000 \\u0000 \\\u0000");
  assert.ok(before.some(row => row.record.includes("\\u0000")));
  assert.equal((await reclaimCheckpoints(db, { session }, () => {})).rows, 3);
  await reclaimCheckpoints(db, { apply: true, session }, () => {});
  assert.deepEqual(await snapshot(db, session), before.filter(row => ![2, 3, 4].includes(Number(row.id))));
  const host = await hostTranscriptSession({ retired: true, content: "PK\u0000" });
  await reclaimHostTranscripts(host.db, { apply: true, session: host.session }, () => {});
  assert.deepEqual(await kinds(host.db, host.session), ["camel.legacy.migration", "camel.host.bootstrap", "camel.user", "camel.history.marker", "camel.host.disabled"]);
});

test("a record jsonb cannot read (half an emoji) is never selected, and the rest of its session still is", async () => {
  const { db, session, before } = await fixture();
  // As JSON.stringify writes a lone surrogate: the text before a cut in the middle of an emoji.
  const unreadable = JSON.stringify({ id: 1, conversationId: 1, kind: "camel.context.message", data: { text: "🟥\ud83d" } });
  assert.ok(unreadable.includes("\\ud83d"));
  await db.query("insert into pi_durable_entries (session_id, id, conversation_id, head, commit_seq, record) values ($1, 1, 1, null, 1, $2)", [session, unreadable]);
  assert.equal((await reclaimCheckpoints(db, { session }, () => {})).rows, 3);
  await reclaimCheckpoints(db, { apply: true, session }, () => {});
  assert.deepEqual((await snapshot(db, session)).map(row => Number(row.id)), [1, ...before.map(row => Number(row.id)).filter(id => ![2, 3, 4].includes(id))]);
});

test("stage 1 skips live owners (including draining nodes), pending runs, and every nonterminal task status", async () => {
  const { db, session, before } = await fixture();
  const node = randomUUID(), lease = randomUUID();
  await db.query("insert into runtime_nodes (node, session, expires_at, draining) values ($1, $2, now() + interval '1 hour', true)", [node, lease]);
  await db.query("insert into actor_owners (actor, node, session, epoch) values ($1, $2, $3, 1)", [session, node, lease]);
  assert.equal((await reclaimSession(db, session, true)).skipped_reason, "live_owner");
  await db.query("update actor_owners set node = null, session = null where actor = $1", [session]);
  await db.query("update agents set pending_runs = true where id = $1", [session]);
  assert.equal((await reclaimSession(db, session, true)).skipped_reason, "pending_runs");
  await db.query("update agents set pending_runs = false where id = $1", [session]);
  for (const status of ["pending", "running", "waiting", "sleeping", "completing"]) {
    await db.query(`insert into pi_durable_tasks (session_id, id, conversation_id, kind, status, abort_requested, background, record)
      values ($1, 102, 1, 'test', $2, 0, 0, '{}') on conflict (session_id, id) do update set status = excluded.status`, [session, status]);
    assert.equal((await reclaimSession(db, session, true)).skipped_reason, "unfinished_task", status);
  }
  assert.deepEqual(await snapshot(db, session), before);
  await db.query("update pi_durable_tasks set status = 'terminal' where session_id = $1", [session]);
  assert.equal((await reclaimSession(db, session, true)).rows, 3);
});

/** Intercept one transaction statement, leaving the actual reads, locks and writes on Postgres. */
function intercept(db: Db, before: (text: string) => Promise<void>): Db {
  return new Proxy(db, { get(target, key) {
    if (key === "connect") return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(inner, name) {
        if (name === "query") return async (text: string, values?: unknown[]) => {
          await before(text); return inner.query(text, values);
        };
        const value = Reflect.get(inner, name, inner); return typeof value === "function" ? value.bind(inner) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("stage 1 rechecks idleness after taking locks when a session wakes mid-run", async () => {
  const { db, session, before } = await fixture();
  let woke = false;
  const raced = intercept(db, async text => {
    if (!woke && text.startsWith("insert into actor_owners")) {
      woke = true;
      await db.query("update agents set pending_runs = true where id = $1", [session]);
    }
  });
  assert.equal((await reclaimSession(raced, session, true)).skipped_reason, "pending_runs");
  assert.ok(woke);
  assert.deepEqual(await snapshot(db, session), before);
  assert.equal((await db.query("select 1 from actor_owners where actor = $1", [session])).rowCount, 0, "claim-row insert rolled back");
});

test("stage 1 holds the claim against a first acquisition until deletion commits; lock contention is skipped", async () => {
  const { db, session } = await fixture();
  const node = randomUUID(), lease = randomUUID();
  await db.query("insert into runtime_nodes (node, session, expires_at) values ($1, $2, now() + interval '1 hour')", [node, lease]);
  let acquire: Promise<unknown> | undefined;
  const locked = intercept(db, async text => {
    if (!text.startsWith("with obsolete")) return;
    acquire = db.query("insert into actor_owners (actor, node, session, epoch) values ($1, $2, $3, 1) on conflict (actor) do update set node = $2, session = $3, epoch = actor_owners.epoch + 1", [session, node, lease]);
    await until(async () => (await db.query("select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like 'insert into actor_owners (actor, node, session, epoch) values%'")).rowCount, "claim acquisition waiting for reclaim");
  });
  assert.equal((await reclaimSession(locked, session, true)).rows, 3);
  await acquire;
  assert.equal((await db.query("select node from actor_owners where actor = $1", [session])).rows[0].node, node);

  const other = await fixture();
  const holder = await db.connect();
  try {
    await holder.query("begin");
    await holder.query("select id from agents where id = $1 for update", [other.session]);
    assert.equal((await reclaimSession(db, other.session, true)).skipped_reason, "locked");
    assert.deepEqual(await snapshot(db, other.session), other.before);
  } finally { await holder.query("rollback"); holder.release(); }
});

test("after reclaim a cold agent runs, pages history, and forks retained and pre-checkpoint messages", { timeout: 60_000 }, async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `answer to ${lastUser(body)}` }),
    { AGENT_IDLE_MS: "1000" });
  const session = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const idle = () => until(async () => (await r.db.query("select 1 from agents a where id = $1 and not pending_runs and not exists (select 1 from actor_owners where actor = a.id and node is not null)", [session])).rowCount, "agent unload");
  await r.prompt(session, "first");
  await idle();
  const storage = await PostgresPiStorage.open(r.db, session);
  try {
    const last = (await r.db.query("select max(id) as id from pi_durable_entries where session_id = $1", [session])).rows[0].id;
    const model = await contextAt(storage, { entryId: Number(last), index: -1 });
    const [head, ...ids] = await storage.mintIds(model.length + 1);
    await storage.commit([{ type: "entry", value: { id: head as EntryId, conversationId: 1 as never, kind: "camel.legacy.context", head: head as EntryId } },
      ...model.map((message, i) => ({ type: "entry" as const, value: { id: ids[i] as EntryId, conversationId: 1 as never, kind: "camel.context.message", model: [message] } }))], () => {}, context);
  } finally { await storage.close(context); }
  const result = await reclaimSession(r.db, session, true);
  assert.equal(result.skipped_reason, null);
  assert.ok(result.rows > 0);
  assert.equal((await r.prompt(session, "second")).outcome.result.reply, "answer to second");
  const sent = JSON.stringify(r.model.bodies.at(-1).messages);
  assert.ok(sent.includes("first") && sent.includes("answer to first") && sent.includes("second"));
  const page = await r.call(`/v1/agents/${session}/history?limit=2`);
  assert.equal(page.status, 200, page.text);
  assert.equal(page.json.entries.length, 2);
  const older = await r.call(`/v1/agents/${session}/history?limit=2&before=${encodeURIComponent(page.json.next)}`);
  assert.equal(older.status, 200, older.text);
  assert.equal(older.json.entries.length, 2);
  const made = await r.call(`/v1/agents/${session}/fork`, { body: { atMessage: 3 } });
  assert.equal(made.status, 201, made.text);
  assert.equal((await r.prompt(made.json.id, "forked")).outcome.result.reply, "answer to forked");
  const early = await r.call(`/v1/agents/${session}/fork`, { body: { atMessage: 0 } });
  assert.equal(early.status, 201, early.text);
  assert.deepEqual(early.json.forkedFrom, { agentId: session, atMessage: 0 });
  const copied = (await r.call(`/v1/agents/${early.json.id}/history`)).json.messages;
  assert.deepEqual(copied, [older.json.entries[0].message], "the fork keeps the original indexed message");
  assert.equal((await r.prompt(early.json.id, "early fork")).outcome.result.reply, "answer to early fork");
  const raw = r.model.bodies.at(-1).messages.filter((message: any) => message.role !== "system");
  assert.deepEqual(raw.map((message: any) => [message.role, message.content]),
    [["user", [{ type: "text", text: "first" }]], ["user", [{ type: "text", text: "early fork" }]]]);
});

test("stage 1 honors a compaction's retained head, never its marker ID, and leaves sessions without a head alone", async () => {
  const { db, session, before } = await fixture();
  const marker = before.findLast(row => JSON.parse(row.record).kind === "camel.legacy.context")!;
  // A checkpoint message before the compaction marker is its retained head. It and later copies stay live.
  await db.query("update pi_durable_entries set head = 3, record = (record::jsonb || jsonb_build_object('kind', 'pi.compaction', 'head', 3))::text where session_id = $1 and id = $2", [session, marker.id]);
  const compacted = await snapshot(db, session);
  assert.equal((await reclaimSession(db, session, true)).rows, 1, "only the old head below retained ID 3");
  assert.deepEqual(await snapshot(db, session), compacted.filter(row => Number(row.id) !== 2));
  const noHead = await fixture();
  await db.query("update pi_durable_entries set head = null where session_id = $1", [noHead.session]);
  const unchanged = await snapshot(db, noHead.session);
  assert.equal((await reclaimCheckpoints(db, { apply: true, session: noHead.session }, () => {})).sessions, 0);
  assert.deepEqual(await snapshot(db, noHead.session), unchanged);
});

test("stage 1 bounds a run by session limit and resumes across completed sessions", async () => {
  // A separate schema makes candidate ordering independent of the other fixtures.
  const fresh = await testDatabase();
  const source = await fixture();
  for (const session of ["a", "b", "c"]) {
    await fresh.db.query("insert into agents (id, tenant, header, revision, name, type, model) values ($1, 'test', '{}', 1, 'test', 'test', 'test')", [session]);
    await fresh.db.query("insert into pi_durable_metadata (session_id, next_id, next_seq) values ($1, '100', 1)", [session]);
    for (const row of source.before.filter(row => Number(row.conversation_id) === 1)) {
      await fresh.db.query("insert into pi_durable_entries (session_id, id, conversation_id, head, commit_seq, record) values ($1, $2, 1, $3, 1, $4)",
        [session, row.id, JSON.parse(row.record).head ?? null, row.record]);
    }
  }
  const events: ReclaimSession[] = [];
  assert.equal((await reclaimCheckpoints(fresh.db, { apply: true, limit: 2 }, row => events.push(row))).sessions, 2);
  assert.deepEqual(events.map(row => row.session), ["a", "b"]);
  assert.equal((await reclaimCheckpoints(fresh.db, { apply: true, limit: 2 }, row => events.push(row))).sessions, 1);
  assert.equal(events.at(-1)!.session, "c");
  assert.equal((await reclaimCheckpoints(fresh.db, { apply: true }, () => {})).rows, 0);
});

/**
 * A session as a release before the host transcript's removal wrote it, then as its first load without it retired it
 * (`retired`): host records, archive blocks (an import's from before #322 too), the snapshot document, the base marker
 * and its document.
 */
async function hostTranscriptSession(options: { retired: boolean; content?: string }) {
  const { db } = await database;
  const session = randomUUID();
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ($1, 'test', '{}', 1, 'test', 'test', 'test')", [session]);
  const storage = await PostgresPiStorage.open(db, session);
  const entry = (id: number, kind: string, data?: Record<string, unknown>) => ({ type: "entry" as const, value: { id: id as EntryId, conversationId: 1 as never, kind, ...(data ? { data: data as never } : {}) } });
  const writes: StorageWrite[] = [{ type: "conversation", value: { id: 1 as never } },
    entry(2, "camel.legacy.migration"), entry(3, "camel.legacy.record", { records: ["host content"] }), entry(4, "camel.host.bootstrap"),
    entry(5, "camel.host.archive", { records: ["host content"] }), entry(6, "camel.host.record", { record: { t: "turn", active: false, ...(options.content ? { text: options.content } : {}) } }),
    entry(7, "camel.user", { message: "kept" }),
    { type: "document.create", record: { id: 8 as never, kind: "camel.host.snapshot", scope: { kind: "session" } }, content: { version: 1, kind: "base", value: { enabled: !options.retired, snapshot: { total: 3 } } } },
    entry(9, "camel.history.marker", { t: "base", total: 3, active: false, turnStart: 3, awaiting: [] }),
    { type: "document.create", record: { id: 10 as never, kind: "camel.history.base", scope: { kind: "session" } }, content: { version: 1, kind: "base", value: { entry: 9 } } },
  ];
  if (options.retired) writes.push(entry(11, "camel.host.disabled", { retired: "journal" }));
  await storage.commit(writes, () => {}, context);
  await storage.close(context);
  return { db, session };
}
const kinds = async (db: Db, session: string) => (await db.query("select (record::jsonb)->>'kind' as kind from pi_durable_entries where session_id = $1 order by id", [session])).rows.map(row => row.kind);
const documents = async (db: Db, session: string) => (await db.query("select kind from pi_durable_documents where session_id = $1 order by id", [session])).rows.map(row => row.kind);

test("stage 2 removes a retired host transcript's records, archive and snapshot document once its index holds the history before the journal's base", async () => {
  const { db, session } = await hostTranscriptSession({ retired: true });
  const before = await kinds(db, session);
  const dry = await reclaimSession(db, session, false, HOST_TRANSCRIPT);
  assert.equal(dry.rows, 4, "three entries and the snapshot document");
  assert.deepEqual(await kinds(db, session), before, "a dry run writes nothing");
  const ids = (await db.query("select count(*)::int as n from pi_durable_record_ids where session_id = $1", [session])).rows[0].n;
  const events: ReclaimSession[] = [];
  const applied = await reclaimHostTranscripts(db, { apply: true, session }, row => events.push(row));
  assert.deepEqual([applied.rows, applied.bytes], [dry.rows, dry.bytes]);
  assert.deepEqual(await kinds(db, session), ["camel.legacy.migration", "camel.host.bootstrap", "camel.user", "camel.history.marker", "camel.host.disabled"]);
  assert.deepEqual(await documents(db, session), ['"camel.history.base"']);
  assert.equal((await db.query("select count(*)::int as n from pi_durable_document_revisions where session_id = $1 and document_id = 8", [session])).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from pi_durable_record_ids where session_id = $1", [session])).rows[0].n, ids, "IDs stay reserved");
  assert.equal((await reclaimHostTranscripts(db, { apply: true, session }, () => {})).sessions, 0, "a repeat run finds nothing");
});

test("stage 2 leaves a host transcript not retired yet", async () => {
  for (const options of [{ retired: false }]) {
    const { db, session } = await hostTranscriptSession(options);
    const before = await kinds(db, session);
    assert.equal((await reclaimHostTranscripts(db, { apply: true, session }, () => {})).sessions, 0, JSON.stringify(options));
    assert.deepEqual(await kinds(db, session), before);
    assert.ok((await documents(db, session)).includes('"camel.host.snapshot"'));
  }
});

test("stage 2 skips a session with a live owner, as stage 1 does", async () => {
  const { db, session } = await hostTranscriptSession({ retired: true });
  const node = randomUUID(), lease = randomUUID();
  await db.query("insert into runtime_nodes (node, session, expires_at, draining) values ($1, $2, now() + interval '1 hour', false)", [node, lease]);
  await db.query("insert into actor_owners (actor, node, session, epoch) values ($1, $2, $3, 1)", [session, node, lease]);
  assert.equal((await reclaimSession(db, session, true, HOST_TRANSCRIPT)).skipped_reason, "live_owner");
  assert.ok((await kinds(db, session)).includes("camel.host.record"));
});
