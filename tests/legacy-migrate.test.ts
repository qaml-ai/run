import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, type Api, type Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fileStorage } from "../shared/storage.ts";
import { Accounts } from "../src/accounts.ts";
import { api } from "../src/api.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { ConsoleAuth } from "../src/console-auth.ts";
import type { Db } from "../src/db.ts";
import { HistoryIndex } from "../src/history-pages.ts";
import { legacyCoverage, legacyLogLister } from "../src/legacy-coverage.ts";
import { legacyMigrate, LegacyMigrateCursorError, type LegacyAgentResult } from "../src/legacy-migrate.ts";
import { Ownership } from "../src/ownership.ts";
import { Passwords } from "../src/passwords.ts";
import { legacyHistory, recordsHistory } from "../src/pi-durable/retired-host.ts";
import { HostJournal } from "../src/pi-durable/host-journal.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { Tenants } from "../src/tenants.ts";
import { journalMessages } from "./fixtures/journal-history.ts";
import { historyOf, hostTranscriptSession, setDualWrite, type TranscriptRecord } from "./fixtures/host-transcript.ts";
import { rollBack } from "./fixtures/pi-rollback.ts";
import { seedWithoutGeneration } from "./fixtures/pi-seed-before-322.ts";
import { testDatabase } from "./database.ts";

// Sessions a release before the host transcript's removal seeded, as nodes ran it then.
setDualWrite(true);

const TENANT = "owner";
const id = (name: string) => `client_${createHash("sha256").update(name).digest("hex").slice(0, 40)}`;
const user = (content: string, requestId?: string) => ({ role: "user" as const, content, timestamp: 1, ...(requestId ? { requestId } : {}) }) as AgentMessage;
const turn = (question: string, answer: string, requestId?: string): TranscriptRecord[] => [
  { t: "turn", active: true }, { t: "message", message: user(question, requestId) }, { t: "message", message: fauxAssistantMessage(answer) }, { t: "turn", active: false },
];
const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false, baseUrl: "http://127.0.0.1:9/v1",
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 } as Model<Api>;
const bridge = { definitions: [], call: async () => { throw new Error("No application tools"); } };

/** A runtime on one host: a supervisor and its sessions, over a test database and file Storage. */
async function runtime(t: { after(fn: () => Promise<void>): void }) {
  const { db } = await testDatabase();
  const directory = await mkdtemp(join(tmpdir(), "legacy-migrate-"));
  const storage = fileStorage(join(directory, "storage"));
  const supervisor = new AgentSupervisor(join(directory, "agents"), { db, storage, hosting: "inline" });
  const sessions = new ClientSessions(supervisor, { db, storage, secret: "legacy-migrate-secret-32-characters" });
  t.after(async () => { await sessions.close(); await supervisor.close(); await rm(directory, { recursive: true, force: true }); });
  const location = (agent: string) => ({ sessionId: agent, directory: join(directory, "agents", agent), db });
  const legacyLog = (agent: string) => storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(agent));
  const row = (agent: string) => db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, $2, $3, 'legacy', 'general', 'fixture', null, false, 1)",
    [agent, TENANT, JSON.stringify({ version: 3, id: agent, tenant: TENANT, expiresAt: null, config: {} })]);
  const lister = legacyLogLister(agent => sessions.legacyLogEmpty(agent));
  const walk = async (options: { dryRun?: boolean; maxBytes?: number; budgetMs?: number } = {}) => {
    const results: LegacyAgentResult[] = [];
    let cursor: string | undefined, last;
    do {
      last = await legacyMigrate(db, { ...options, ...(cursor ? { cursor } : {}), lister, migrate: (agent, given) => sessions.migrateLegacy(agent, { ...given, now: Date.parse("2026-10-28T12:00:00Z") }) });
      results.push(...last.results);
      cursor = last.next ?? undefined;
    } while (cursor);
    return { results, last };
  };
  return { db, storage, supervisor, sessions, location, legacyLog, row, lister, walk, index: new HistoryIndex(db, storage) };
}
type Runtime = Awaited<ReturnType<typeof runtime>>;

/** Retire a session's host transcript as a load does, without indexing what it holds. */
async function retire(location: Parameters<typeof openPiStorage>[0]) {
  const storage = await openPiStorage(location);
  try { assert.ok(await HostJournal.retire(storage)); } finally { await storage.close(context); }
}

/**
 * One agent of each legacy format, as production holds them, with the history the readers before #465 gave for each
 * (`expected`): a host transcript never retired; one a rollback disabled, the legacy engine's turn after it in its legacy
 * log; an import before #322 never adopted, with Pi's messages past its log; a legacy log alone; a retired host
 * transcript whose index is short of its base. Also a busy agent, one loaded here, and a large one.
 */
async function legacyAgents(rt: Runtime) {
  const expected = new Map<string, AgentMessage[]>();
  const host = id("host");
  await rt.row(host);
  const hostRecords = [...turn("first", "one", "req-1"), ...turn("second", "two", "req-2")];
  await hostTranscriptSession(rt.location(host), hostRecords);
  expected.set(host, historyOf(hostRecords));

  const rolled = id("rolled-back");
  await rt.row(rolled);
  await hostTranscriptSession(rt.location(rolled), turn("before rollback", "on Pi"));
  {
    const storage = await openPiStorage(rt.location(rolled));
    const log = rt.legacyLog(rolled);
    await rollBack(storage, log);
    // The legacy engine's own turn after the rollback, in the legacy log only.
    const records = await log.read();
    await log.rewrite(() => [...records, ...turn("after rollback", "legacy engine")]);
    await log.close();
    const old = await legacyHistory(storage, await (async () => { const reader = rt.legacyLog(rolled); try { return await reader.read() as never; } finally { await reader.close(true); } })());
    expected.set(rolled, old.messages);
    await storage.close(context);
  }

  const pre322 = id("pre-322");
  await rt.row(pre322);
  {
    const old = [user("original question", "orig"), fauxAssistantMessage("original answer")];
    const records: TranscriptRecord[] = [{ t: "turn", active: true }, ...old.map(message => ({ t: "message" as const, message })), { t: "turn", active: false }];
    const log = rt.legacyLog(pre322);
    await log.rewrite(() => records);
    await log.close();
    // Its index held the imported history already.
    await rt.index.begin(pre322, old.length);
    await rt.index.write(pre322, undefined, { start: 0, messages: old, turns: [0] });
    const storage = await openPiStorage(rt.location(pre322));
    await seedWithoutGeneration(storage, pre322, records);
    const fresh = [user("committed question"), fauxAssistantMessage("committed answer")];
    for (const message of fresh) await storage.commit([{ type: "entry", value: {
      id: await storage.mintId<EntryId>(), conversationId: 1 as ConversationId, kind: message.role === "user" ? "pi.user" : "pi.assistant", model: [message] as any,
    } }], context);
    await storage.close(context);
    expected.set(pre322, [...old, ...fresh]);
  }

  const logOnly = id("legacy-log");
  await rt.row(logOnly);
  {
    const records = [...turn("pre-Pi", "legacy", "pre-1"), ...turn("again", "still legacy")];
    const log = rt.legacyLog(logOnly);
    await log.rewrite(() => records);
    await log.close();
    expected.set(logOnly, recordsHistory(records as never).messages);
  }

  const short = id("short");
  await rt.row(short);
  {
    const records = [...turn("retired", "but"), ...turn("index", "short")];
    // Retired as a load does, but its index never written.
    await hostTranscriptSession(rt.location(short), records);
    await retire(rt.location(short));
    assert.deepEqual(await journalMessages(rt.location(short)), historyOf(records), "the retired records hold what the index lacks");
    expected.set(short, historyOf(records));
  }

  const busy = id("busy");
  await rt.row(busy);
  await hostTranscriptSession(rt.location(busy), turn("busy", "busy"));
  await rt.db.query("update agents set pending_runs = true where id = $1", [busy]);

  const loaded = id("loaded");
  await rt.row(loaded);
  await hostTranscriptSession(rt.location(loaded), turn("loaded", "here"));

  const large = id("large");
  await rt.row(large);
  await hostTranscriptSession(rt.location(large), turn("large", "x".repeat(200_000)));

  return { expected, host, rolled, pre322, logOnly, short, busy, loaded, large };
}

/** Everything a conversion could write: the journals, the history index, the legacy logs' tail. */
async function dump(db: Db) {
  const tables = ["pi_durable_entries", "pi_durable_documents", "pi_durable_document_revisions", "pi_durable_submissions", "agent_history_index", "agent_history_chunks", "log_records", "actor_owners"];
  return Promise.all(tables.map(async table => (await db.query(`select * from ${table} order by 1, 2`)).rows));
}

test("each legacy format converts to the current one, its history read the same before and after; a dry run writes nothing", { timeout: 120_000 }, async t => {
  const rt = await runtime(t);
  const agents = await legacyAgents(rt);
  const converted = [agents.host, agents.rolled, agents.pre322, agents.logOnly, agents.short];
  // Before: the legacy readers give each its history.
  for (const agent of converted) assert.deepEqual((await rt.sessions.agentHistory(agent, TENANT))!.messages, agents.expected.get(agent), `history of ${agent} before`);
  // One loaded here (its runs' journal read, its host not started): skipped while it is.
  assert.deepEqual(await rt.sessions.abortAgent(agents.loaded, TENANT), { cancelled: [] });

  const logs = async () => Promise.all(converted.map(async agent => { const log = rt.legacyLog(agent); try { return await log.read(); } finally { await log.close(true); } }));
  const logsBefore = await logs();
  const before = await dump(rt.db);
  const dry = await rt.walk({ maxBytes: 100_000 });
  assert.equal(dry.last.dryRun, true, "a dry run unless asked otherwise");
  assert.deepEqual(await dump(rt.db), before, "a dry run writes nothing");
  const byAgent = (results: LegacyAgentResult[]) => new Map(results.map(result => [result.agent, result]));
  const planned = byAgent(dry.results);
  assert.deepEqual(Object.fromEntries(converted.map(agent => [agent, [planned.get(agent)?.code, planned.get(agent)?.kind]])), {
    [agents.host]: ["would_migrate", "host_transcript"], [agents.rolled]: ["would_migrate", "not_on_pi"], [agents.pre322]: ["would_migrate", "not_on_pi"],
    [agents.logOnly]: ["would_migrate", "legacy_log"], [agents.short]: ["would_migrate", "history_before_base"],
  });
  assert.equal(planned.get(agents.busy)?.code, "skipped_busy");
  assert.equal(planned.get(agents.loaded)?.code, "skipped_hosted");
  assert.equal(planned.get(agents.large)?.code, "too_large");
  assert.ok(planned.get(agents.large)!.bytes! > 100_000);
  await assert.rejects(legacyMigrate(rt.db, { cursor: (await legacyMigrate(rt.db, { budgetMs: 1, batch: 1, lister: rt.lister, migrate: async agent => ({ agent, code: "current" }) })).next!, dryRun: false, lister: rt.lister, migrate: async agent => ({ agent, code: "current" }) }), LegacyMigrateCursorError, "a dry run's cursor never goes on as a migration");

  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => { logged.push(line); });
  const run = await rt.walk({ dryRun: false, maxBytes: 100_000 });
  t.mock.restoreAll();
  const done = byAgent(run.results);
  assert.deepEqual(Object.fromEntries(converted.map(agent => [agent, [done.get(agent)?.code, done.get(agent)?.kind]])), {
    [agents.host]: ["migrated", "host_transcript"], [agents.rolled]: ["migrated", "not_on_pi"], [agents.pre322]: ["migrated", "not_on_pi"],
    [agents.logOnly]: ["migrated", "legacy_log"], [agents.short]: ["migrated", "history_before_base"],
  });
  assert.deepEqual(run.last.kinds, { host_transcript: 1, not_on_pi: 2, legacy_log: 1, history_before_base: 1 });
  assert.equal(logged.filter(line => JSON.parse(line).type === "legacy_migrated").length, 5);
  assert.deepEqual(done.get(agents.pre322)!.indexedFrom, 2, "the index's messages are kept, the rest written after them");
  assert.deepEqual(await logs(), logsBefore, "legacy logs are read, never written");
  // The claims taken for it are let go.
  assert.equal((await rt.db.query("select count(*)::int as n from actor_owners where node is not null")).rows[0].n, 0);

  // After: the same history, read as the current format, cold and from the history index.
  for (const agent of converted) {
    assert.deepEqual((await rt.sessions.agentHistory(agent, TENANT))!.messages, agents.expected.get(agent), `history of ${agent}`);
    const total = agents.expected.get(agent)!.length;
    assert.equal(await rt.index.indexed(agent), total, `index of ${agent}`);
  }
  // Each starts now, its history whole; a converted context holds a summary and the history's last messages.
  for (const agent of converted) {
    await rt.supervisor.start(agent, { model, apiKey: "fixture", codeMode: false }, bridge);
    assert.deepEqual(await rt.supervisor.history(agent, count => rt.index.messages(agent, count)), agents.expected.get(agent));
    await rt.supervisor.stop(agent);
  }
  // Only what was left counts in legacy coverage: the busy, loaded and large agents.
  const coverage = await legacyCoverage(rt.db, { lister: rt.lister });
  assert.deepEqual(coverage.gate.blocking, ["unretired_host_transcripts", "pi_without_journal_history", "pi_without_base_document"]);
  assert.deepEqual(new Set(coverage.examples.unretired_host_transcripts), new Set([agents.busy, agents.loaded, agents.large]));

  // Again: nothing is converted twice; the large one with a higher bound, once the loaded one is let go.
  await rt.sessions.close();
  const sessions = new ClientSessions(rt.supervisor, { db: rt.db, storage: rt.storage, secret: "legacy-migrate-secret-32-characters" });
  t.after(() => sessions.close());
  await rt.db.query("update agents set pending_runs = false where id = $1", [agents.busy]);
  const again: LegacyAgentResult[] = [];
  for (let cursor: string | undefined, page; ; cursor = page.next!) {
    page = await legacyMigrate(rt.db, { dryRun: false, maxBytes: 1_000_000, ...(cursor ? { cursor } : {}), lister: rt.lister, migrate: (agent, given) => sessions.migrateLegacy(agent, given) });
    again.push(...page.results);
    if (!page.next) break;
  }
  assert.deepEqual(again.map(result => [result.agent, result.code]).sort(), [[agents.busy, "migrated"], [agents.loaded, "migrated"], [agents.large, "migrated"]].sort());
  const clean = await legacyCoverage(rt.db, { lister: rt.lister });
  assert.deepEqual(clean.gate, { ready: true, blocking: [], review: [] });
  for (const agent of converted) assert.equal((await sessions.migrateLegacy(agent, { dryRun: false, maxBytes: 1_000_000 })).code, "current");
});

test("what the converter cannot read whole is left as it is, for review", { timeout: 60_000 }, async t => {
  const rt = await runtime(t);
  // An import before #322 whose legacy log is gone: the readers before #465 gave it no history.
  const orphan = id("orphan");
  await rt.row(orphan);
  const storage = await openPiStorage(rt.location(orphan));
  await seedWithoutGeneration(storage, orphan, turn("archived", "only"));
  await storage.close(context);
  // A retired session whose index is short of its base, and whose host records reclaim removed.
  const reclaimed = id("reclaimed");
  await rt.row(reclaimed);
  await hostTranscriptSession(rt.location(reclaimed), turn("reclaimed", "records"));
  await retire(rt.location(reclaimed));
  await rt.db.query(`delete from pi_durable_entries where session_id = $1 and substr(record, 1, 200) like '%"kind":"camel.host.bootstrap"%'`, [reclaimed]);
  const before = await dump(rt.db);
  const results = new Map((await rt.walk({ dryRun: false })).results.map(result => [result.agent, result]));
  assert.equal(results.get(orphan)?.code, "review");
  assert.match(results.get(orphan)!.error!, /legacy log is empty/);
  assert.equal(results.get(reclaimed)?.code, "review");
  assert.match(results.get(reclaimed)!.error!, /no host records/);
  assert.deepEqual(await dump(rt.db), before, "nothing written");
});

test("across nodes: an agent another node holds is skipped; one no node holds converts under this node's claim, let go after", { timeout: 60_000 }, async t => {
  const { db } = await testDatabase();
  const directory = await mkdtemp(join(tmpdir(), "legacy-migrate-nodes-"));
  const storage = fileStorage(join(directory, "storage"));
  const here = new Ownership(db, { node: "http://a", ttlMs: 60_000 }), there = new Ownership(db, { node: "http://b", ttlMs: 60_000 });
  await here.start(); await there.start();
  const supervisor = new AgentSupervisor(join(directory, "agents"), { db, storage, hosting: "inline" });
  const sessions = new ClientSessions(supervisor, { db, storage, secret: "legacy-migrate-secret-32-characters", ownership: here });
  t.after(async () => { await sessions.close(); await supervisor.close(); await here.close(); await there.close(); await rm(directory, { recursive: true, force: true }); });
  const location = (agent: string) => ({ sessionId: agent, directory: join(directory, "agents", agent), db });
  const held = id("held"), free = id("free");
  const records = turn("question", "answer");
  for (const agent of [held, free]) {
    await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, $2, $3, 'legacy', 'general', 'fixture', null, false, 1)",
      [agent, TENANT, JSON.stringify({ version: 3, id: agent, tenant: TENANT, expiresAt: null, config: {} })]);
    await hostTranscriptSession(location(agent), records);
  }
  assert.ok("claim" in await there.acquire(held));
  const migrate = (agent: string, dryRun: boolean) => sessions.migrateLegacy(agent, { dryRun, maxBytes: 1_000_000 });
  assert.equal((await migrate(held, true)).code, "skipped_hosted");
  assert.equal((await migrate(held, false)).code, "skipped_hosted");
  assert.equal((await migrate(free, true)).code, "would_migrate");
  assert.equal((await db.query("select count(*)::int as n from actor_owners where actor = $1", [free])).rows[0].n, 0, "a dry run takes no claim");
  assert.equal((await migrate(free, false)).code, "migrated");
  assert.deepEqual((await db.query("select node, epoch from actor_owners where actor = $1", [free])).rows, [{ node: null, epoch: 1 }], "taken once, and let go");
  assert.equal((await db.query("select node from actor_owners where actor = $1", [held])).rows[0].node, "http://b", "left to its node");
  assert.deepEqual((await sessions.agentHistory(free, TENANT))!.messages, historyOf(records));
});

test("a load waits for a conversion here, then finds the agent converted", { timeout: 60_000 }, async t => {
  const rt = await runtime(t);
  const agent = id("waits");
  await rt.row(agent);
  const records = turn("waiting", "for the conversion");
  await hostTranscriptSession(rt.location(agent), records);
  const migrating = rt.sessions.migrateLegacy(agent, { dryRun: false, maxBytes: 1_000_000 });
  // Loaded (by an abort, which loads it) while the conversion runs: it waits, then finds the agent converted.
  const loading = rt.sessions.abortAgent(agent, TENANT);
  assert.equal((await migrating).code, "migrated");
  assert.deepEqual(await loading, { cancelled: [] });
  assert.deepEqual((await rt.sessions.agentHistory(agent, TENANT))!.messages, historyOf(records));
  // Loaded here now: another conversion leaves it.
  assert.equal((await rt.sessions.migrateLegacy(agent, { dryRun: false, maxBytes: 1_000_000 })).code, "skipped_hosted");
});

test("an agent its own load retired meanwhile converts from where the load left it, then is current", { timeout: 60_000 }, async t => {
  const rt = await runtime(t);
  const agent = id("retired-by-load");
  await rt.row(agent);
  const records = [...turn("first", "one"), ...turn("second", "two")];
  await hostTranscriptSession(rt.location(agent), records);
  // A dry run plans its retirement; then its first start retires it, as loads do since #467.
  assert.equal((await rt.sessions.migrateLegacy(agent, { dryRun: true, maxBytes: 1_000_000 })).kind, "host_transcript");
  await rt.supervisor.start(agent, { model, apiKey: "fixture", codeMode: false }, bridge);
  // Running: never converted beside its host.
  assert.equal((await rt.sessions.migrateLegacy(agent, { dryRun: false, maxBytes: 1_000_000 })).code, "skipped_hosted");
  await rt.supervisor.stop(agent);
  const result = await rt.sessions.migrateLegacy(agent, { dryRun: false, maxBytes: 1_000_000 });
  // The start retired it without an index here (a supervisor alone has none): the conversion fills the index from its records.
  assert.deepEqual([result.code, result.kind], ["migrated", "history_before_base"]);
  assert.equal((await rt.sessions.migrateLegacy(agent, { dryRun: false, maxBytes: 1_000_000 })).code, "current");
  assert.deepEqual((await rt.sessions.agentHistory(agent, TENANT))!.messages, historyOf(records));
});

test("POST /v1/operations/legacy-migrate is the platform operator's alone, a dry run by default", async t => {
  const { db } = await testDatabase();
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const OPS = "ops-operator-token-at-least-24-chars", OTHER = "other-ops-token-at-least-24-chars";
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { ops: { tokenSha256: sha(OPS), apiKeys: {} }, other: { tokenSha256: sha(OTHER), apiKeys: {} } } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, secretsKey: "ab".repeat(32), tenants });
  const consoleAuth = new ConsoleAuth({ accounts, publicUrl: "https://run.example.test", passwords: new Passwords(db) });
  const calls: { agent: string; dryRun: boolean; maxBytes: number }[] = [];
  const clients = { legacyLogEmpty: async () => false, migrateLegacy: async (agent: string, options: { dryRun: boolean; maxBytes: number }) => { calls.push({ agent, ...options }); return { agent, code: options.dryRun ? "would_migrate" : "migrated", kind: "legacy_log" }; } };
  const app = api({ accounts, consoleAuth, clients: clients as never, defaultModel: async () => "test", createAgent: async () => ({}), billingAdmins: ["ops"] } as never);
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ('client_x', 'ops', '{}', 1, 'test', 'test', 'test')");
  const post = (token: string | undefined, body: unknown) => app.request("/v1/operations/legacy-migrate", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post(undefined, {})).status, 401);
  assert.equal((await post(OTHER, {})).status, 403);
  assert.equal((await post((await accounts.createToken("ops", "ops script")).token, {})).status, 403, "the platform operator's tenant's API token");
  assert.equal((await post(OPS, { dryRun: "no" })).status, 400);
  assert.equal((await post(OPS, { maxBytes: 65 * 1024 * 1024 })).status, 400, "past the history index's full-read bound");
  assert.equal((await post(OPS, { cursor: "nope" })).status, 400);
  t.mock.method(console, "log", () => {});
  const dry = await (await post(OPS, {})).json();
  assert.deepEqual([dry.complete, dry.dryRun, dry.counts.would_migrate, dry.kinds], [true, true, 1, { legacy_log: 1 }]);
  const run = await (await post(OPS, { dryRun: false, maxBytes: 1024 })).json();
  assert.deepEqual([run.dryRun, run.maxBytes, run.counts.migrated], [false, 1024, 1]);
  assert.deepEqual(calls, [{ agent: "client_x", dryRun: true, maxBytes: 16 * 1024 * 1024 }, { agent: "client_x", dryRun: false, maxBytes: 1024 }]);
});
