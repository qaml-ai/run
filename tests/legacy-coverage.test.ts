import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { api } from "../src/api.ts";
import { ConsoleAuth } from "../src/console-auth.ts";
import type { Db } from "../src/db.ts";
import { legacyCoverage } from "../src/legacy-coverage.ts";
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
/** A journal base: its document, its base revision and the marker entry it names (total less kept is what the index must hold). */
async function base(db: Db, session: string, total: number, kept: number) {
  await pi(db, session, [{ id: 50, conversationId: 1, kind: "camel.history.marker", data: { t: "base", total, kept: Array.from({ length: kept }, () => ({})) } }]);
  await db.query(`insert into pi_durable_documents (session_id, id, kind, family, key_value, scope_kind, owner_id, created_at, record)
    values ($1, 60, '"camel.history.base"', 0, '""', 'session', 0, 1, '{}')`, [session]);
  await db.query("insert into pi_durable_document_revisions (session_id, document_id, seq, kind, version, content) values ($1, 60, 1, 'base', 1, $2)",
    [session, JSON.stringify({ entry: 50 })]);
}
const seed = { id: 2, conversationId: 1, kind: "camel.legacy.migration", data: {} };
const bootstrap = { id: 3, conversationId: 1, kind: "camel.host.bootstrap", data: {} };
const retired = { id: 70, conversationId: 1, kind: "camel.host.disabled", data: { retired: "journal" } };
const marker = { id: 80, conversationId: 1, kind: "camel.history.marker", data: { t: "turn", active: false, total: 1 } };
// Larger than a page, so Postgres keeps it out of line (TOAST): the scan reads only its first bytes.
const big = (id: number) => ({ id, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", content: "x".repeat(300_000) }] });

async function seeded() {
  const { db } = await testDatabase();
  // Ready: retired, its index holds everything before the base. A new agent with a journal base and no host generation.
  await agent(db, "ready"); await pi(db, "ready", [seed, bootstrap, retired, marker, big(90)]); await base(db, "ready", 10, 2);
  await db.query("insert into agent_history_index (agent, indexed) values ('ready', 8)");
  await agent(db, "fresh"); await pi(db, "fresh", [seed]); await base(db, "fresh", 0, 0);
  return db;
}

test("each bucket counts what it names, with example ids; a clean database reads all zero and ready", async () => {
  const db = await seeded();
  const clean = await legacyCoverage(db);
  assert.deepEqual(clean.counts, { unretired_host_transcripts: 0, retired_index_short: 0, pi_without_journal_history: 0, no_pi_with_legacy_log_rows: 0, agents_without_pi_storage: 0, agents_total: 2 });
  assert.deepEqual(clean.gate, { ready: true, blocking: [], review: [] });
  assert.deepEqual(clean.examples, {});

  // Host generations never retired: none, or a rollback's disabled entry without retired: "journal".
  await agent(db, "unretired"); await pi(db, "unretired", [seed, bootstrap, marker, big(90)]);
  await agent(db, "rolled-back"); await pi(db, "rolled-back", [seed, bootstrap, { ...retired, data: { retired: false } }, marker]);
  // Retired, with the index behind the base, or no index row, or no base.
  await agent(db, "short"); await pi(db, "short", [seed, bootstrap, retired, marker]); await base(db, "short", 10, 2);
  await db.query("insert into agent_history_index (agent, indexed) values ('short', 7)");
  await agent(db, "unindexed"); await pi(db, "unindexed", [seed, bootstrap, retired, marker]); await base(db, "unindexed", 10, 2);
  await agent(db, "baseless"); await pi(db, "baseless", [seed, bootstrap, retired, marker]);
  await db.query("insert into agent_history_index (agent, indexed) values ('baseless', 100)");
  // Pi storage, no journal history. Its messages quote the kinds, which never count as its entries' kinds.
  await agent(db, "legacy-only");
  await pi(db, "legacy-only", [seed, { id: 4, conversationId: 1, kind: "pi.user", message: { content: 'see "kind":"camel.history.marker" and "kind":"camel.host.bootstrap"' } },
    { id: 5, conversationId: 2, kind: "camel.history.marker", data: {} }]);
  // No Pi storage: one whose legacy log still has hot rows, one with none.
  await agent(db, "log-rows");
  await db.query("insert into log_records (log_key, seq, body) values ('sessions/log-rows/transcript', 1, '{}')");
  await agent(db, "never-started");
  // A deleted agent's leftovers count nowhere.
  await pi(db, "deleted", [seed, bootstrap]);

  const coverage = await legacyCoverage(db, { now: (() => { let t = Date.parse("2026-10-27T12:00:00Z"); return () => (t += 5); })() });
  assert.deepEqual(coverage.counts, { unretired_host_transcripts: 2, retired_index_short: 3, pi_without_journal_history: 1, no_pi_with_legacy_log_rows: 1, agents_without_pi_storage: 2, agents_total: 10 });
  assert.deepEqual(coverage.examples, {
    unretired_host_transcripts: ["rolled-back", "unretired"], retired_index_short: ["baseless", "short", "unindexed"],
    pi_without_journal_history: ["legacy-only"], no_pi_with_legacy_log_rows: ["log-rows"], agents_without_pi_storage: ["log-rows", "never-started"],
  });
  assert.deepEqual(coverage.gate, { ready: false, blocking: ["unretired_host_transcripts", "retired_index_short", "pi_without_journal_history"], review: ["no_pi_with_legacy_log_rows"] });
  assert.equal(coverage.generatedAt, "2026-10-27T12:00:00.005Z");
  assert.equal(coverage.durationMs, 5);
});

test("it reads in a read-only transaction with a statement timeout, and writes nothing", async () => {
  const db = await seeded();
  const tables = ["agents", "pi_durable_entries", "pi_durable_documents", "pi_durable_document_revisions", "agent_history_index", "log_records"];
  const dump = async () => Promise.all(tables.map(async table => (await db.query(`select * from ${table} order by 1, 2`)).rows));
  const before = await dump();
  const sent: string[] = [];
  let readOnly: unknown, timeout: unknown;
  // The pool's own clients are left as they are (pool.query calls them with a callback): each wrapper is a view of one.
  const watched = Object.create(db, { connect: { value: async () => {
    const client = await db.connect();
    const query = client.query.bind(client);
    return Object.create(client, { query: { value: async (text: string, values?: unknown[]) => {
      sent.push(text);
      const result = await query(text, values);
      if (/with flagged/.test(text)) {
        readOnly = (await query("show transaction_read_only")).rows[0].transaction_read_only;
        timeout = (await query("show statement_timeout")).rows[0].statement_timeout;
      }
      return result;
    } } });
  } } }) as Db;
  await legacyCoverage(watched);
  assert.equal(readOnly, "on");
  assert.equal(timeout, "1min");
  assert.ok(sent.every(text => !/\b(insert|update|delete|create|alter|drop|truncate)\b/i.test(text.replace(/'[^']*'/g, ""))), "only reads");
  assert.deepEqual(await dump(), before);
  // A statement over the timeout is stopped by Postgres.
  await assert.rejects(legacyCoverage(Object.create(db, { connect: { value: async () => {
    const client = await db.connect();
    const query = client.query.bind(client);
    return Object.create(client, { query: { value: (text: string, values?: unknown[]) => query(/with flagged/.test(text) ? "select pg_sleep(1)" : text, values) } });
  } } }) as Db, { timeoutMs: 50 }), /statement timeout/);
});

test("GET /v1/operations/legacy-coverage is the platform operator's alone", async t => {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { ops: { tokenSha256: sha(OPS), apiKeys: {} }, other: { tokenSha256: sha(OTHER), apiKeys: {} } } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, secretsKey: "ab".repeat(32), tenants });
  const consoleAuth = new ConsoleAuth({ accounts, publicUrl: "https://run.example.test", passwords: new Passwords(db) });
  const app = api({ accounts, consoleAuth, clients: {} as never, defaultModel: async () => "test", createAgent: async () => ({}), billingAdmins: ["ops"] } as never);
  const apiToken = (await accounts.createToken("ops", "ops script")).token;
  const get = (token?: string) => app.request("/v1/operations/legacy-coverage", { headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal((await get()).status, 401);
  assert.equal((await get(OTHER)).status, 403, "another tenant's operator token");
  assert.equal((await get(apiToken)).status, 403, "the platform operator's tenant's API token");
  const cookie = (await consoleAuth.session("ops", "github", "octocat")).split(";")[0];
  assert.equal((await app.request("/v1/operations/legacy-coverage", { headers: { cookie } })).status, 403, "the platform operator's console session");
  const logged: string[] = [];
  t.mock.method(console, "log", (line: string) => { logged.push(line); });
  const answer = await get(OPS);
  assert.equal(answer.status, 200);
  const body = await answer.json();
  assert.equal(body.counts.agents_total, 0);
  assert.equal(body.gate.ready, true);
  assert.equal(typeof body.durationMs, "number");
  assert.ok(logged.some(line => JSON.parse(line).type === "legacy_coverage_viewed" && JSON.parse(line).by === "ops"));
});
