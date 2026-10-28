import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fileStorage } from "../shared/storage.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { HistoryIndex } from "../src/history-pages.ts";
import { seedWithoutGeneration } from "./fixtures/pi-seed-before-322.ts";
import { hasPiStorage, openPiStorage } from "../src/pi-durable/storage.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import type { TranscriptRecord } from "./fixtures/host-transcript.ts";
import { testDatabase } from "./database.ts";

test("cold history of an import before #322 (no journal history) is refused, without starting or writing the session", async t => {
  const { db } = await testDatabase();
  const directory = await mkdtemp(join(tmpdir(), "pi-cold-history-"));
  const storage = fileStorage(join(directory, "storage"));
  const supervisor = new AgentSupervisor(join(directory, "agents"), { db, storage, hosting: "inline" });
  const sessions = new ClientSessions(supervisor, { db, storage, secret: "pi-history-secret-32-characters-long" });
  t.after(async () => { await sessions.close(); await supervisor.close(); await rm(directory, { recursive: true, force: true }); });
  const id = `client_${"a".repeat(40)}`;
  await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, 'owner', $2, 'history', 'general', 'fixture', null, false, 1)", [id, JSON.stringify({ id, tenant: "owner", expiresAt: null })]);
  const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
  const old = [user("original question"), fauxAssistantMessage("original answer")];
  const records: TranscriptRecord[] = [{ t: "turn", active: true }, ...old.map(message => ({ t: "message" as const, message })), { t: "turn", active: false }];
  const writeLog = async () => { const log = storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id)); await log.rewrite(() => records); await log.close(); };
  await writeLog();

  const journal = await openPiStorage({ sessionId: id, directory: join(directory, "agents", id), db });
  await seedWithoutGeneration(journal, id, records);
  // The host durably marks a turn before Pi receives its input. Its messages can then commit only to Pi.
  records.push({ t: "turn", active: true });
  await writeLog();
  const fresh = [user("committed question"), fauxAssistantMessage("committed answer")];
  for (const message of fresh) await journal.commit([{ type: "entry", value: {
    id: await journal.mintId<EntryId>(), conversationId: 1 as ConversationId,
    kind: message.role === "user" ? "pi.user" : "pi.assistant", model: [message] as any,
  } }], () => {}, context);
  await journal.close(context);
  // A session an earlier release made has no history ordinals (it opened its storage before them).
  await db.query("update pi_durable_metadata set history_next = null, history_last_id = null where session_id = $1", [id]);

  // No pending run or lagging index signals the WAL-only messages left by a failed legacy projection.
  assert.equal((await db.query("select pending_runs from agents where id = $1", [id])).rows[0].pending_runs, false);
  // Its history is in a legacy format this release no longer reads: refused, nothing started or written.
  await assert.rejects(sessions.historyPageFor(id, "owner", { limit: "1" }), (error: any) => error.status === 409 && /AGENT_NOT_MIGRATED: .*not_on_pi/.test(error.message));
  await assert.rejects(sessions.agentHistory(id, "owner"), /AGENT_NOT_MIGRATED/);
  assert.equal(supervisor.agents.size, 0);
  assert.equal(sessions.sessions.size, 0);
  const source = storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id));
  try { assert.deepEqual(await source.read(), records, "history/export reads do not mutate the source projection"); }
  finally { await source.close(); }

  await supervisor.purge(id);
  assert.equal(await hasPiStorage({ sessionId: id, directory, db }), false);
  assert.equal((await db.query("select count(*)::int as n from pi_durable_entries where session_id = $1", [id])).rows[0].n, 0);
});
