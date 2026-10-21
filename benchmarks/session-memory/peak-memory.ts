/**
 * Peak heap/RSS of one large session through its lifecycle: import (first Pi load of a legacy history), resume
 * (reload of an imported/native session) and turns, with a local provider. Samples memory every 10 ms and reports
 * each phase's peak over the idle baseline before it.
 *
 *   AGENT_TEST_DATABASE_URL=postgres://... ENGINE=pi-durable TURNS=300 DETAIL_BYTES=100000 \
 *     node --expose-gc --experimental-strip-types --disable-warning=ExperimentalWarning benchmarks/session-memory/peak-memory.ts
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

const engine = (process.env.ENGINE ?? "pi-durable") as "legacy" | "pi-durable";
const turns = Number(process.env.TURNS ?? 300), detailBytes = Number(process.env.DETAIL_BYTES ?? 100_000), textBytes = Number(process.env.TEXT_BYTES ?? 2_000);
const toolRounds = Number(process.env.TOOL_ROUNDS ?? 3), liveTurns = Number(process.env.LIVE_TURNS ?? 2);
const gc = (globalThis as { gc?: () => void }).gc ?? (() => {});
const root = await mkdtemp(join(tmpdir(), "pi-peak-memory-"));
const db = new pg.Pool({ connectionString: process.env.AGENT_TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/postgres", max: 10 });
await migrate(db);

// Local OpenAI-compatible provider: a few tool rounds per turn, then a short answer.
let calls = 0, requestBytes = 0;
const server = createServer(async (req, res) => {
  let raw = ""; for await (const part of req) raw += part;
  const body = JSON.parse(raw); calls++; requestBytes = Math.max(requestBytes, raw.length);
  const lastUser = body.messages.findLastIndex((m: any) => m.role === "user");
  const done = body.messages.slice(lastUser + 1).filter((m: any) => m.role === "tool").length;
  const tool = done < toolRounds && body.tools?.length;
  const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${calls}`, type: "function", function: { name: "fixture_tool", arguments: "{\"q\":\"x\"}" } }] } : { role: "assistant", content: "Done." };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ id: `r${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: `r${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 4, total_tokens: 1004 } })}\n\n`);
  res.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false, baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2_000_000, maxTokens: 256 } as any;
const bridge = { definitions: [{ name: "fixture_tool", description: "Local benchmark tool", parameters: { type: "object", properties: { q: { type: "string" } } } }], call: async () => ({ result: "y".repeat(textBytes) }) };

// A legacy history: each turn is a user message, a tool call, a tool result with large details (kept in history and
// context but not sent to the model) and a short answer.
function history(): any[] {
  const records: any[] = [];
  let t = 1_700_000_000_000;
  for (let i = 0; i < turns; i++) {
    const id = `seed-${i}`;
    records.push({ t: "turn", active: true });
    records.push({ t: "message", message: { role: "user", content: `Question ${i}`, timestamp: t++ } });
    records.push({ t: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "fixture_tool", arguments: { q: String(i) } }], api: "openai-completions", provider: "openai", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: t++ } });
    records.push({ t: "message", message: { role: "toolResult", toolCallId: id, toolName: "fixture_tool", content: [{ type: "text", text: `r${i} `.repeat(textBytes / 4) }], details: { blob: `d${i} `.repeat(detailBytes / 4) }, isError: false, timestamp: t++ } });
    records.push({ t: "message", message: { role: "assistant", content: [{ type: "text", text: `Answer ${i}` }], api: "openai-completions", provider: "openai", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: t++ } });
    records.push({ t: "turn", active: false });
  }
  return records;
}

const mb = (n: number) => Math.round(n / 1048576);
let peak = { heap: 0, rss: 0, external: 0 };
const sampler = setInterval(() => {
  const m = process.memoryUsage();
  peak = { heap: Math.max(peak.heap, m.heapUsed), rss: Math.max(peak.rss, m.rss), external: Math.max(peak.external, m.external) };
}, 10);
const results: Record<string, unknown>[] = [];
async function phase(name: string, run: () => Promise<unknown>) {
  gc(); gc();
  const base = process.memoryUsage();
  peak = { heap: base.heapUsed, rss: base.rss, external: base.external };
  const started = performance.now();
  const extra = await run();
  const ms = Math.round(performance.now() - started);
  gc(); gc();
  const after = process.memoryUsage();
  const row = { phase: name, ms, baseHeapMB: mb(base.heapUsed), peakHeapRiseMB: mb(peak.heap - base.heapUsed), peakRssRiseMB: mb(peak.rss - base.rss), peakExternalRiseMB: mb(peak.external - base.external), retainedHeapMB: mb(after.heapUsed - base.heapUsed), ...(extra as object ?? {}) };
  results.push(row); console.error(JSON.stringify(row));
}

const supervisor = new AgentSupervisor(root, { engine, hosting: "inline", db, maxAgents: 2 });
const agent = `peak-${randomUUID()}`;
const config = { model, apiKey: "fixture", codeMode: false };
const status = async () => { const s: any = await supervisor.request(agent, "status", {}); return { engine: s.engine, migration: s.migration?.state, messages: s.messages, contextMessages: s.contextMessages }; };
try {
  const records = history();
  const log = fileAppendLog<any>(transcriptPath(join(root, agent)));
  await log.rewrite(() => records); await log.close();
  console.error(JSON.stringify({ engine, turns, detailBytes, textBytes, sourceMB: mb(Buffer.byteLength(records.map(r => JSON.stringify(r)).join("\n"))) }));
  await phase("first load (import)", async () => { await supervisor.start(agent, config, bridge); return await status(); });
  await phase("idle hosted", async () => {});
  for (let i = 0; i < liveTurns; i++) {
    await phase(`turn ${i + 1}`, async () => {
      const before = calls;
      const result: any = await supervisor.request(agent, "prompt", { text: `Live turn ${i}`, requestId: `live-${i}` }, () => {});
      if (result.error) throw new Error(result.error);
      return { modelCalls: calls - before };
    });
  }
  await phase("close", () => supervisor.close());
  await phase("resume load", async () => { await supervisor.start(agent, config, bridge); return await status(); });
  await phase("turn after resume", async () => {
    const before = calls;
    const result: any = await supervisor.request(agent, "prompt", { text: "After resume", requestId: "live-resume" }, () => {});
    if (result.error) throw new Error(result.error);
    return { modelCalls: calls - before, maxRequestMB: mb(requestBytes) };
  });
  const journal = await db.query("select record::json->>'kind' as kind, count(*)::int as entries, sum(length(record))::bigint as bytes from pi_durable_entries where session_id = $1 group by 1 order by bytes desc", [agent]).catch(error => ({ rows: [{ error: String(error) }] }));
  console.log(JSON.stringify({ engine, turns, detailBytes, results, journal: journal.rows }, null, 1));
} finally {
  clearInterval(sampler);
  await supervisor.close(); server.closeAllConnections(); server.close(); await db.end(); await rm(root, { recursive: true, force: true });
}
