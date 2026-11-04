// Database load of code mode's nested calls on Postgres storage: for one turn whose script makes N tool calls, the
// statements (round trips), transactions and WAL bytes it costs, and Pi's Storage.commit calls and batches.
//
//   TOOL=codemode|js_exec node --experimental-strip-types benchmarks/codemode-db/run.ts
//
// Needs Postgres (AGENT_TEST_DATABASE_URL, as the tests) and v8-exec built. TOOL=js_exec measures a checkout from
// before code mode, where the script runs through js_exec.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentHost } from "../../src/agent-host.ts";
import { openPiStorage } from "../../src/pi-durable/storage.ts";
import { testDatabase } from "../../tests/database.ts";

const TOOL = process.env.TOOL ?? "codemode";
const counts = { statements: 0, transactions: 0, commits: 0, batches: 0 };
const inTransaction = new WeakSet<object>();
/** STATEMENTS=1: each statement's start (its first 90 characters), with how many times it ran, for the 50-call case. */
const statementTexts = new Map<string, number>();
let tally = false;
const query = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: object, ...args: any[]) {
  const text = String(typeof args[0] === "string" ? args[0] : args[0]?.text ?? "").trim().toLowerCase();
  counts.statements++;
  if (tally) { const key = text.replace(/\s+/g, " ").slice(0, 90); statementTexts.set(key, (statementTexts.get(key) ?? 0) + 1); }
  if (text.startsWith("begin")) { inTransaction.add(this); counts.transactions++; }
  else if (text.startsWith("commit") || text.startsWith("rollback")) inTransaction.delete(this);
  else if (!inTransaction.has(this)) counts.transactions++;
  return (query as any).apply(this, args);
} as typeof query;

const { db } = await testDatabase();
const lsn = async () => (await db.query("select pg_current_wal_lsn() as lsn")).rows[0].lsn as string;
const walBytes = async (from: string) => Number((await db.query("select pg_wal_lsn_diff(pg_current_wal_lsn(), $1) as bytes", [from])).rows[0].bytes);
const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });

/** One fresh agent's turn running `scripts`, each making `calls` tool calls in a row: what it cost the database. */
async function turn(scripts: number, calls: number) {
  const id = `bench-${scripts}x${calls}-${Math.random().toString(36).slice(2, 8)}`;
  const directory = await mkdtemp(join(tmpdir(), "codemode-db-"));
  const storage = await openPiStorage({ sessionId: id, directory, db });
  const commit = storage.commit.bind(storage);
  (storage as any).commit = (batches: any[], ...rest: any[]) => { counts.commits++; counts.batches += batches.length; return (commit as any)(batches, ...rest); };
  const host = createAgentHost({
    emit: () => {}, tool: async () => ({ ok: true }), cancelTools: async () => null, runLimit: async () => undefined,
    legacyLog: { empty: async () => true }, piStorage: async () => storage,
    file: async () => { throw new Error("no files"); }, modelAuth: async () => { throw new Error("no per-call credentials"); }, fs: async () => { throw new Error("no files"); },
  } as any);
  await host.handle("init", { id, directory, model: faux.getModel(), apiKey: "fixture", tools: [{ name: "echo", description: "Echo", parameters: { type: "object" } }] });
  const code = `let n = 0; for (let i = 0; i < ${calls}; i++) { await tools.echo({ i }); n++; } return n;`;
  faux.setResponses([...Array.from({ length: scripts }, (_, index) => fauxAssistantMessage(fauxToolCall(TOOL, { code }, { id: `script-${index}` }), { stopReason: "toolUse" })), fauxAssistantMessage("done")]);
  const before = { ...counts }, at = await lsn();
  const run = await host.handle("prompt", { text: "go" }) as { error: unknown };
  const wal = await walBytes(at);
  if (run.error) throw new Error(`The turn failed: ${JSON.stringify(run.error)}`);
  await host.dispose();
  await storage.close(BACKGROUND_CONTEXT);
  return { statements: counts.statements - before.statements, transactions: counts.transactions - before.transactions,
    commits: counts.commits - before.commits, batches: counts.batches - before.batches, walBytes: wal };
}

const rows: Record<string, unknown>[] = [];
await turn(1, 1); // warm: the first agent's statements prepare and caches fill
const base = await turn(1, 0);
for (const calls of [50, 256]) {
  tally = calls === 50 && process.env.STATEMENTS === "1";
  const measured = await turn(1, calls);
  tally = false;
  const per = Object.fromEntries(Object.entries(measured).map(([key, value]) => [key, Math.round((value - (base as any)[key]) / calls * 10) / 10]));
  rows.push({ case: `1 script x ${calls} calls`, ...measured, perCall: per });
}
rows.unshift({ case: "1 script x 0 calls", ...base });
rows.push({ case: "3 scripts x 10 calls (one turn)", ...await turn(3, 10) });
console.log(JSON.stringify({ tool: TOOL, rows }, null, 2));
if (statementTexts.size) console.log([...statementTexts].sort((a, b) => b[1] - a[1]).map(([text, n]) => `${String(n).padStart(6)}  ${text}`).join("\n"));
faux.unregister();
process.exit(0);
