/**
 * What the journal costs before each model request: per model call, the database statements, rows and bytes, and the
 * Pi storage calls (context reads, commits, other reads) between the previous response (or the prompt) and the request
 * reaching a local provider. RTT_MS adds a round trip to every statement, as RDS does. STATEMENTS=1 counts statements by
 * text; TRACE=1 prints each storage call.
 *
 *   AGENT_TEST_DATABASE_URL=postgres://... MESSAGES=200 RTT_MS=1 LIVE_TURNS=3 \
 *     node --expose-gc --experimental-strip-types --disable-warning=ExperimentalWarning benchmarks/session-memory/context-reads.ts
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import pg from "pg";
import { AgentSupervisor } from "../../src/supervisor.ts";
import { fileAppendLog } from "../../shared/append-log.ts";
import { transcriptPath } from "../../src/transcript.ts";
import { migrate } from "../../src/db.ts";
import { PostgresPiStorage } from "../../src/pi-durable/storage.ts";

const messages = Number(process.env.MESSAGES ?? 200), turns = Math.max(1, Math.round(messages / 4));
const detailBytes = Number(process.env.DETAIL_BYTES ?? 4_000), textBytes = Number(process.env.TEXT_BYTES ?? 2_000);
const toolRounds = Number(process.env.TOOL_ROUNDS ?? 3), liveTurns = Number(process.env.LIVE_TURNS ?? 3), rttMs = Number(process.env.RTT_MS ?? 0);
const root = await mkdtemp(join(tmpdir(), "pi-context-reads-"));
const pool = new pg.Pool({ connectionString: process.env.AGENT_TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/postgres", max: 10 });
await migrate(pool);

// Every query (pool or transaction client) pays RTT_MS and is counted with its rows and their bytes.
const totals = { queries: 0, rows: 0, bytes: 0 };
const delay = () => rttMs > 0 ? new Promise(resolve => setTimeout(resolve, rttMs)) : undefined;
const statements = new Map<string, number>();
const counted = async (run: () => Promise<any>, text?: unknown) => {
  await delay();
  const result = await run();
  if (window && process.env.STATEMENTS) { const key = String(typeof text === "string" ? text : (text as any)?.text).replace(/\s+/g, " ").slice(0, 110); statements.set(key, (statements.get(key) ?? 0) + 1); }
  totals.queries++; totals.rows += result?.rows?.length ?? 0;
  for (const row of result?.rows ?? []) for (const value of Object.values(row)) if (typeof value === "string") totals.bytes += value.length;
  return result;
};
const wrapClient = (client: any) => new Proxy(client, { get(target, key) {
  if (key === "query") return (...args: any[]) => counted(() => target.query(...args), args[0]);
  const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
} });
const db = new Proxy(pool, { get(target, key) {
  if (key === "query") return (...args: any[]) => counted(() => (target.query as any)(...args), args[0]);
  if (key === "connect") return async () => wrapClient(await target.connect());
  const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
} }) as unknown as pg.Pool;

// Pi storage calls by kind: Pi's context reads (by stack), commits, and every other read.
type Bucket = { calls: number; rows: number; bytes: number; ms: number };
let window: { started: number; reads: Record<string, Bucket>; queries: number; rows: number; bytes: number } | undefined;
const caller = (stack: string) => /readContext|captureContextBounds|deriveContext/.test(stack) ? "context" : "other";
for (const method of ["scanEntries", "findLatestHeadMarker", "entry", "conversation", "task", "scanTasks", "document", "findDocument", "scanDocuments", "submission", "scanSubmissions", "commit"] as const) {
  const original = (PostgresPiStorage.prototype as any)[method];
  (PostgresPiStorage.prototype as any)[method] = async function (...args: any[]) {
    const stack = new Error().stack ?? "", started = performance.now();
    const result = await original.apply(this, args);
    if (window && process.env.TRACE) {
      const frames = stack.split("\n").slice(2).map(line => line.trim()).filter(line => !/context-reads|node:internal|storage\.ts|harness\/storage|tracked|admit/.test(line)).slice(0, 4).map(line => line.replace(/^at (async )?/, "").replace(/\(?file:\/\/\S*\/(node_modules\/@earendil-works\/)?/, "").replace(/\)$/, ""));
      const what = method === "commit" ? args[0].map((write: any) => write.type === "entry" ? `entry:${write.value.kind}` : write.type === "task" ? `task:${write.value.kind}:${write.value.state?.status}` : write.type.startsWith("document") ? `${write.type}:${write.record?.kind ?? write.id ?? ""}` : write.type).join(",") : method;
      console.log(`TRACE ${label.padEnd(16)} ${what.slice(0, 90).padEnd(90)} <- ${frames.join(" < ")}`);
    }
    if (window) {
      const key = `${method === "commit" ? "commit" : caller(stack)}`;
      const bucket = window.reads[key] ??= { calls: 0, rows: 0, bytes: 0, ms: 0 };
      const items = method === "scanEntries" ? result.items : method === "commit" ? [] : result === undefined ? [] : [result];
      bucket.calls++; bucket.rows += items.length; bucket.bytes += items.reduce((sum: number, item: unknown) => sum + JSON.stringify(item).length, 0);
      bucket.ms += performance.now() - started;
    }
    return result;
  };
}
const open = () => { window = { started: performance.now(), reads: {}, queries: totals.queries, rows: totals.rows, bytes: totals.bytes }; };
const round = (bucket: Bucket) => ({ ...bucket, ms: Math.round(bucket.ms * 10) / 10, bytes: Math.round(bucket.bytes / 1024) + "KB" });
const close = (label: string) => {
  const current = window!; window = undefined;
  return { call: label, ms: Math.round((performance.now() - current.started) * 10) / 10, queries: totals.queries - current.queries,
    rows: totals.rows - current.rows, KB: Math.round((totals.bytes - current.bytes) / 1024),
    reads: Object.fromEntries(Object.entries(current.reads).map(([key, bucket]) => [key, round(bucket)])) };
};

// Local OpenAI-compatible provider: TOOL_ROUNDS tool rounds per turn, then a short answer. Each request closes the
// window its pre-request work ran in; its response opens the next.
let calls = 0, label = "";
const rows: Record<string, unknown>[] = [];
const server = createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += part;
  const body = JSON.parse(raw); calls++;
  if (window) rows.push({ ...close(label), requestKB: Math.round(raw.length / 1024), sent: body.messages.length });
  const lastUser = body.messages.findLastIndex((m: any) => m.role === "user");
  const done = body.messages.slice(lastUser + 1).filter((m: any) => m.role === "tool").length;
  const tool = done < toolRounds && body.tools?.length;
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name: "fixture_tool", arguments: "{\"q\":\"x\"}" } }] } : { role: "assistant", content: "Done." };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id: `r${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: `r${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 4, total_tokens: 1004 } })}\n\n`);
  res.end("data: [DONE]\n\n");
  label = `${label.split(" call")[0]} call ${done + 2}`;
  open();
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2_000_000, maxTokens: 256 } as any;
const bridge = { definitions: [{ name: "fixture_tool", description: "Local benchmark tool", parameters: { type: "object", properties: { q: { type: "string" } } } }], call: async () => ({ result: "y".repeat(textBytes) }) };

function history(): any[] {
  const records: any[] = [];
  let t = 1_700_000_000_000;
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 0; i < turns; i++) {
    const id = `seed-${i}`;
    records.push({ t: "turn", active: true });
    records.push({ t: "message", message: { role: "user", content: `Question ${i}`, timestamp: t++ } });
    records.push({ t: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "fixture_tool", arguments: { q: String(i) } }], api: "openai-completions", provider: "openai", model: "fixture", usage, stopReason: "toolUse", timestamp: t++ } });
    records.push({ t: "message", message: { role: "toolResult", toolCallId: id, toolName: "fixture_tool", content: [{ type: "text", text: `r${i} `.repeat(textBytes / 4) }], details: { blob: `d${i} `.repeat(detailBytes / 4) }, isError: false, timestamp: t++ } });
    records.push({ t: "message", message: { role: "assistant", content: [{ type: "text", text: `Answer ${i}` }], api: "openai-completions", provider: "openai", model: "fixture", usage, stopReason: "stop", timestamp: t++ } });
    records.push({ t: "turn", active: false });
  }
  return records;
}

const supervisor = new AgentSupervisor(root, { engine: "pi-durable", hosting: "inline", db, maxAgents: 2 } as any);
const agent = `reads-${randomUUID()}`;
const config = { model, apiKey: "fixture", codeMode: false };
const turn = async (name: string) => {
  label = `${name} call 1`;
  let firstToken: number | undefined;
  open();
  const started = performance.now();
  const result: any = await supervisor.request(agent, "prompt", { text: name, requestId: name }, (event: any) => {
    if (firstToken === undefined && event?.type === "message_update") firstToken = performance.now();
  });
  if (result.error) throw new Error(result.error);
  window = undefined;
  rows.push({ turn: name, ttftMs: firstToken === undefined ? undefined : Math.round(firstToken - started), turnMs: Math.round(performance.now() - started) });
};
try {
  const log = fileAppendLog<any>(transcriptPath(join(root, agent)));
  await log.rewrite(history); await log.close();
  await supervisor.start(agent, config, bridge);
  await turn("warm-up");
  // Resume: a fresh load of the native journal, as a session reloaded on another node.
  await supervisor.close();
  rows.length = 0;
  const loadStarted = performance.now(); open();
  await supervisor.start(agent, config, bridge);
  rows.push({ ...close("load"), loadMs: Math.round(performance.now() - loadStarted) });
  for (let i = 0; i < liveTurns; i++) await turn(`turn-${i + 1}`);
  const journal = await pool.query("select count(*)::int as entries, sum(length(record))::bigint as bytes from pi_durable_entries where session_id = $1", [agent]);
  console.log(JSON.stringify({ messages, rttMs, toolRounds, detailBytes, textBytes, journal: journal.rows[0] }));
  for (const row of rows) console.log(JSON.stringify(row));
  if (process.env.STATEMENTS) for (const [text, count] of [...statements].sort((a, b) => b[1] - a[1])) console.log(String(count).padStart(5), text);
} finally {
  await supervisor.close(); server.closeAllConnections(); server.close(); await pool.end(); await rm(root, { recursive: true, force: true });
}
