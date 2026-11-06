/**
 * The spike's core in Node, for what workerd does not report: the JavaScript heap. Same harness, tools and fake
 * model (served over loopback HTTP), on Pi's Node SQLite storage. Run from backends/workers:
 *
 *   node --expose-gc --experimental-strip-types spikes/pi-subagents/node-bench.ts n=10 tps=50 tokens=2000 tools=3 ctx=0
 *
 * Prints one JSON line: the in-agent summary plus peak heapUsed and RSS sampled every 100 ms.
 */
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { respond } from "./fake-model.ts";
import { Metrics, lagProbe, openSpike, startRun, context } from "./core.ts";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.split("=")).map(([k, v]) => [k, Number(v)]));
const run = { n: args.n ?? 1, tps: args.tps ?? 50, tokens: args.tokens ?? 2000, tools: args.tools ?? 3, ctx: args.ctx ?? 0, id: "bench" };

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const response = await respond(new Request(`http://127.0.0.1${req.url}`, { method: req.method, body: Buffer.concat(chunks), headers: { "content-type": "application/json" } }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  res.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;

const directory = await mkdtemp(join(tmpdir(), "pi-subagents-bench-"));
const metrics = new Metrics();
const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const baseline = process.memoryUsage();
let peakRss = 0;
lagProbe(metrics, 30 * 60_000, () => {
  const memory = process.memoryUsage();
  metrics.peakHeap = Math.max(metrics.peakHeap, memory.heapUsed);
  peakRss = Math.max(peakRss, memory.rss);
});
const spike = await openSpike(await openNodeSqliteStorage(join(directory, "session.sqlite")), `http://127.0.0.1:${port}/v1`, metrics, { watchChildren: 5 });
spike.harness.resume();
const submission = await startRun(spike, metrics, run);
await submission.wait(context);
await spike.harness.waitForIdle(context);
const summary = metrics.summary();
const size = (await stat(join(directory, "session.sqlite"))).size + (await stat(join(directory, "session.sqlite-wal")).catch(() => ({ size: 0 }))).size;
for (const watch of spike.watches) await watch.stop();
await spike.harness.close(context);
server.close();
await rm(directory, { recursive: true, force: true });
console.log(JSON.stringify({
  run,
  ...summary,
  baselineHeapMiB: Math.round(baseline.heapUsed / 104857.6) / 10,
  peakHeapMiB: Math.round(metrics.peakHeap / 104857.6) / 10,
  peakRssMiB: Math.round(peakRss / 104857.6) / 10,
  databaseMiB: Math.round(size / 104857.6) / 10,
}));
process.exit(0);
