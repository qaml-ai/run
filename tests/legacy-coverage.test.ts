import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { api } from "../src/api.ts";
import { ConsoleAuth } from "../src/console-auth.ts";
import type { Db } from "../src/db.ts";
import { legacyCoverage, LegacyCoverageCursorError } from "../src/legacy-coverage.ts";
import { Passwords } from "../src/passwords.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OPS = "ops-operator-token-at-least-24-chars", OTHER = "other-ops-token-at-least-24-chars";

async function agent(db: Db, id: string) {
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ($1, 'ops', '{}', 1, 'test', 'test', 'test')", [id]);
}
async function pi(db: Db, session: string, entries: object[]) {
  await db.query("insert into pi_durable_metadata (session_id, next_id, next_seq) values ($1, '1000', 1) on conflict do nothing", [session]);
  for (const entry of entries as { id: number; conversationId: number }[]) {
    await db.query("insert into pi_durable_entries (session_id, id, conversation_id, commit_seq, record) values ($1, $2, $3, 1, $4)",
      [session, entry.id, entry.conversationId, JSON.stringify(entry)]);
  }
}
async function document(db: Db, session: string, id: number, kind: string, revisions: { kind: "base" | "delta"; content: unknown }[]) {
  await db.query(`insert into pi_durable_documents (session_id, id, kind, family, key_value, scope_kind, owner_id, created_at, record)
    values ($1, $2, $3, 0, '""', 'session', 0, 1, '{}')`, [session, id, JSON.stringify(kind)]);
  for (const [seq, revision] of revisions.entries()) {
    await db.query("insert into pi_durable_document_revisions (session_id, document_id, seq, kind, version, content) values ($1, $2, $3, $4, 1, $5)",
      [session, id, seq + 1, revision.kind, JSON.stringify(revision.content)]);
  }
}
/** A journal base: its document, its base revision and the marker entry it names (total less kept is what the index must hold). */
async function base(db: Db, session: string, total: number, kept: number) {
  await pi(db, session, [{ id: 50, conversationId: 1, kind: "camel.history.marker", data: { t: "base", total, kept: Array.from({ length: kept }, () => ({})) } }]);
  await document(db, session, 60, "camel.history.base", [{ kind: "base", content: { entry: 50 } }]);
}
// Larger than a page, so Postgres keeps it out of line (TOAST).
const context = Array.from({ length: 2000 }, (_, i) => ({ role: "user", content: `message ${i} ${"x".repeat(100)}` }));
/** The host's snapshot document: as its retirement leaves it, enabled (with a delta since), or disabled by a rollback without `retired`. */
async function hostDocument(db: Db, session: string, state: "enabled" | "retired" | "rolled-back" | "delta") {
  const value = { enabled: state === "enabled" || state === "delta", snapshot: { total: 2, context }, ...(state === "retired" ? { retired: "journal" } : {}) };
  await document(db, session, 40, "camel.host.snapshot", [{ kind: "base", content: value }, ...(state === "delta" ? [{ kind: "delta" as const, content: [{ op: "replace", path: "/snapshot/total", value: 3 }] }] : [])]);
}
const seed = { id: 2, conversationId: 1, kind: "camel.legacy.migration", data: { generationId: 3 } };
const bootstrap = { id: 3, conversationId: 1, kind: "camel.host.bootstrap" };
const disabled = { id: 70, conversationId: 1, kind: "camel.host.disabled", data: { retired: "journal" } };
const marker = { id: 80, conversationId: 1, kind: "camel.history.marker", data: { t: "turn", active: false, total: 1 } };
const big = (id: number) => ({ id, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content: "x".repeat(300_000) }] });

async function seeded() {
  const { db } = await testDatabase();
  // Ready: retired, its index holds everything before the base. One reclaimed (its host document gone). A new agent.
  await agent(db, "ready"); await pi(db, "ready", [seed, bootstrap, disabled, marker, big(90)]); await hostDocument(db, "ready", "retired"); await base(db, "ready", 10, 2);
  await db.query("insert into agent_history_index (agent, indexed) values ('ready', 8)");
  await agent(db, "reclaimed"); await pi(db, "reclaimed", [seed, bootstrap, disabled, marker]); await base(db, "reclaimed", 10, 0);
  await db.query("insert into agent_history_index (agent, indexed) values ('reclaimed', 10)");
  await agent(db, "fresh"); await pi(db, "fresh", [{ ...seed, data: {} }]); await base(db, "fresh", 0, 0);
  return db;
}

async function everything(db: Db) {
  // Host generations never retired: enabled, enabled with a delta since, or a rollback's disabling without retired: "journal".
  await agent(db, "unretired"); await pi(db, "unretired", [seed, bootstrap, marker, big(90)]); await hostDocument(db, "unretired", "enabled");
  await agent(db, "delta"); await pi(db, "delta", [seed, bootstrap, marker]); await hostDocument(db, "delta", "delta");
  await agent(db, "rolled-back"); await pi(db, "rolled-back", [seed, bootstrap, { ...disabled, data: { retired: false } }, marker]); await hostDocument(db, "rolled-back", "rolled-back");
  // Retired, with the index behind the base, or no index row, or no base.
  await agent(db, "short"); await pi(db, "short", [seed, bootstrap, disabled, marker]); await hostDocument(db, "short", "retired"); await base(db, "short", 10, 2);
  await db.query("insert into agent_history_index (agent, indexed) values ('short', 7)");
  await agent(db, "unindexed"); await pi(db, "unindexed", [seed, bootstrap, disabled, marker]); await hostDocument(db, "unindexed", "retired"); await base(db, "unindexed", 10, 2);
  await agent(db, "baseless"); await pi(db, "baseless", [seed, bootstrap, disabled, marker]); await hostDocument(db, "baseless", "retired");
  await db.query("insert into agent_history_index (agent, indexed) values ('baseless', 100)");
  // Pi storage, no journal history. Its messages quote the kinds, which never count as its entries' kinds.
  await agent(db, "legacy-only");
  await pi(db, "legacy-only", [{ ...seed, data: {} }, { id: 4, conversationId: 1, kind: "pi.user", message: { content: 'see "kind":"camel.history.marker" and "kind":"camel.host.bootstrap"' } },
    { id: 5, conversationId: 2, kind: "camel.history.marker", data: {} }]);
  // Pi storage, no base document, but history markers: journal history.
  await agent(db, "markers-only"); await pi(db, "markers-only", [{ ...seed, data: {} }, marker]);
  // An import before #322: its host generation came after its archive, so only its host document says it has one.
  await agent(db, "late-host");
  await pi(db, "late-host", [{ ...seed, data: {} }, { id: 3, conversationId: 1, kind: "camel.legacy.record" }, { id: 4, conversationId: 1, kind: "camel.legacy.context" }, { id: 5, conversationId: 1, kind: "camel.host.bootstrap" }]);
  await hostDocument(db, "late-host", "enabled");
  // No Pi storage: one whose legacy log still has hot rows, one folded to Storage (`lister` finds it), one with none,
  // and one with Pi storage a refused start opened and left with no journal.
  await agent(db, "log-rows");
  await db.query("insert into log_records (log_key, seq, body) values ('sessions/log-rows/transcript', 1, '{}')");
  await agent(db, "folded");
  await agent(db, "never-started");
  await agent(db, "opened"); await pi(db, "opened", []);
  // A purged agent's tombstone counts only in the total, whatever a failed purge left behind.
  await agent(db, "tombstone"); await db.query("update agents set revoked = true, purged_at = 1 where id = 'tombstone'");
  await pi(db, "tombstone", [seed, bootstrap]); await hostDocument(db, "tombstone", "enabled");
  await db.query("insert into log_records (log_key, seq, body) values ('sessions/tombstone/transcript', 1, '{}')");
  // A deleted agent's leftovers count nowhere.
  await pi(db, "deleted", [seed, bootstrap]); await hostDocument(db, "deleted", "enabled");
}
const lister = async (ids: string[]) => ids.filter(id => id === "folded");
const all = { unretired_host_transcripts: 4, retired_index_short: 3, pi_without_journal_history: 2, pi_without_base_document: 7, no_pi_with_legacy_log_rows: 1, no_pi_with_legacy_log_objects: 1, agents_without_pi_storage: 4, agents_total: 17 };

test("each bucket counts what it names, with example ids; a clean database reads all zero and ready", async () => {
  const db = await seeded();
  const clean = await legacyCoverage(db, { lister });
  assert.equal(clean.complete, true);
  assert.equal(clean.next, null);
  assert.deepEqual(clean.counts, { unretired_host_transcripts: 0, retired_index_short: 0, pi_without_journal_history: 0, pi_without_base_document: 0, no_pi_with_legacy_log_rows: 0, no_pi_with_legacy_log_objects: 0, agents_without_pi_storage: 0, agents_total: 3 });
  assert.deepEqual(clean.gate, { ready: true, blocking: [], review: [] });
  assert.deepEqual(clean.checked, { legacyLogObjects: true });
  assert.deepEqual(clean.examples, {});
  // Without Storage listed, a walk is never ready: a legacy log folded out of log_records would go unseen.
  assert.deepEqual((await legacyCoverage(db)).gate, { ready: false, blocking: [], review: [] });

  await everything(db);
  const coverage = await legacyCoverage(db, { lister, now: (() => { let t = Date.parse("2026-10-27T12:00:00Z"); return () => (t += 5); })() });
  assert.deepEqual(coverage.counts, all);
  assert.deepEqual(coverage.examples, {
    unretired_host_transcripts: ["delta", "late-host", "rolled-back", "unretired"], retired_index_short: ["baseless", "short", "unindexed"],
    pi_without_journal_history: ["late-host", "legacy-only"], pi_without_base_document: ["baseless", "delta", "late-host", "legacy-only", "markers-only", "rolled-back", "unretired"],
    no_pi_with_legacy_log_rows: ["log-rows"], no_pi_with_legacy_log_objects: ["folded"], agents_without_pi_storage: ["folded", "log-rows", "never-started", "opened"],
  });
  assert.deepEqual(coverage.gate, { ready: false, blocking: ["unretired_host_transcripts", "retired_index_short", "pi_without_journal_history", "pi_without_base_document", "no_pi_with_legacy_log_rows", "no_pi_with_legacy_log_objects"], review: [] });
  assert.equal(coverage.generatedAt, "2026-10-27T12:00:00.005Z");
  assert.equal(coverage.calls, 1);
});

test("a walk stopped by its budget goes on from its cursor to the same counts", async () => {
  const db = await seeded();
  await everything(db);
  const pages = [];
  let cursor: string | undefined;
  do {
    const page = await legacyCoverage(db, { cursor, batch: 2, budgetMs: 1, lister });
    pages.push(page);
    cursor = page.next ?? undefined;
    if (!page.complete) assert.equal(page.gate.ready, false, "never ready before the walk is complete");
  } while (cursor);
  assert.ok(pages.length >= 7, "one batch of two per call");
  const last = pages.at(-1)!;
  assert.deepEqual(last.counts, all);
  assert.equal(last.calls, pages.length);
  assert.deepEqual(last.examples.retired_index_short, ["baseless", "short", "unindexed"]);
  await assert.rejects(legacyCoverage(db, { cursor: "not-a-cursor" }), LegacyCoverageCursorError);
  await assert.rejects(legacyCoverage(db, { cursor: Buffer.from(JSON.stringify({ v: 1, after: "", counts: {}, examples: {}, started: 0, spent: 0, calls: 0 })).toString("base64url") }), LegacyCoverageCursorError);
  // A walk that lists Storage goes on listing it.
  await assert.rejects(legacyCoverage(db, { cursor: pages[0].next! }), LegacyCoverageCursorError);
});

test("it reads in read-only transactions with a statement timeout, and writes nothing", async () => {
  const db = await seeded();
  await everything(db);
  const tables = ["agents", "pi_durable_entries", "pi_durable_documents", "pi_durable_document_revisions", "agent_history_index", "log_records"];
  const dump = async () => Promise.all(tables.map(async table => (await db.query(`select * from ${table} order by 1, 2`)).rows));
  const before = await dump();
  const sent: string[] = [];
  const states = new Set<string>();
  // The pool's own clients are left as they are (pool.query calls them with a callback): each wrapper is a view of one.
  const watched = Object.create(db, { connect: { value: async () => {
    const client = await db.connect();
    const query = client.query.bind(client);
    return Object.create(client, { query: { value: async (text: string, values?: unknown[]) => {
      sent.push(text);
      const result = await query(text, values);
      if (/^select|^\s*select/i.test(text) && !/^show/.test(text)) {
        const readOnly = (await query("show transaction_read_only")).rows[0].transaction_read_only;
        const timeout = (await query("show statement_timeout")).rows[0].statement_timeout;
        states.add(`${readOnly} ${timeout}`);
      }
      return result;
    } } });
  } } }) as Db;
  assert.deepEqual((await legacyCoverage(watched, { lister })).counts, all);
  assert.deepEqual([...states], ["on 20s"]);
  assert.ok(sent.filter(text => /^\s*select/i.test(text)).length >= 4, "every probe ran");
  assert.ok(sent.every(text => !/\b(insert|update|delete|create|alter|drop|truncate)\b/i.test(text.replace(/'[^']*'/g, ""))), "only reads");
  assert.deepEqual(await dump(), before);
  // A statement over the timeout is stopped by Postgres.
  await assert.rejects(legacyCoverage(Object.create(db, { connect: { value: async () => {
    const client = await db.connect();
    const query = client.query.bind(client);
    return Object.create(client, { query: { value: (text: string, values?: unknown[]) => query(/from agents a/.test(text) ? "select pg_sleep(1)" : text, /from agents a/.test(text) ? [] : values) } });
  } } }) as Db, { statementTimeoutMs: 50 }), /statement timeout/);
});

test("GET /v1/operations/legacy-coverage is the platform operator's alone", async t => {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { ops: { tokenSha256: sha(OPS), apiKeys: {} }, other: { tokenSha256: sha(OTHER), apiKeys: {} } } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, secretsKey: "ab".repeat(32), tenants });
  const consoleAuth = new ConsoleAuth({ accounts, publicUrl: "https://run.example.test", passwords: new Passwords(db) });
  const app = api({ accounts, consoleAuth, clients: {} as never, defaultModel: async () => "test", createAgent: async () => ({}), billingAdmins: ["ops"] } as never);
  const apiToken = (await accounts.createToken("ops", "ops script")).token;
  const get = (token?: string, query = "") => app.request(`/v1/operations/legacy-coverage${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await get()).status, 401);
  assert.equal((await get(OTHER)).status, 403, "another tenant's operator token");
  assert.equal((await get(apiToken)).status, 403, "the platform operator's tenant's API token");
  const cookie = (await consoleAuth.session("ops", "github", "octocat")).split(";")[0];
  assert.equal((await app.request("/v1/operations/legacy-coverage", { headers: { cookie } })).status, 403, "the platform operator's console session");
  assert.equal((await get(OPS, "?cursor=nope")).status, 400);
  assert.equal((await get(OPS, "?budgetMs=-1")).status, 400);
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => { logged.push(line); });
  const answer = await get(OPS, "?budgetMs=5000");
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.equal(body.complete, true);
  assert.equal(body.counts.agents_total, 0);
  assert.equal(body.gate.ready, true);
  assert.equal(typeof body.durationMs, "number");
  assert.ok(logged.some(line => JSON.parse(line).type === "legacy_coverage_viewed" && JSON.parse(line).by === "ops"));
});
