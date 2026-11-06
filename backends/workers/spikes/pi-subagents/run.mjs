// Drive the deployed spike: one fresh object per run, polled until its children answer, it resets, or time runs out.
// SPIKE_URL=https://... SPIKE_TOKEN_FILE=... node spikes/pi-subagents/run.mjs ctx=0 n=1,5,10
import { readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.split("=")));
const base = process.env.SPIKE_URL, token = readFileSync(process.env.SPIKE_TOKEN_FILE, "utf8").trim();
const levels = (args.n ?? "1,5,10,25,50,100").split(",").map(Number);
const ctx = Number(args.ctx ?? 0), tokens = Number(args.tokens ?? 2000), tools = Number(args.tools ?? 3), tps = Number(args.tps ?? 50);
const limitMs = Number(args.limitMs ?? 8 * 60_000);
const call = async (path, method = "GET") => {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, text: text.slice(0, 300) }; }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const n of levels) {
  const name = `n${n}-ctx${ctx}-${Date.now().toString(36)}`;
  const started = Date.now();
  const start = await call(`/run/${name}/start?n=${n}&tps=${tps}&tokens=${tokens}&tools=${tools}&ctx=${ctx}&watch=5`, "POST");
  const instance = start.json?.instance;
  const timeline = [];
  let last;
  while (Date.now() - started < limitMs) {
    await sleep(5_000);
    const stats = await call(`/run/${name}/stats`);
    const row = { t: Date.now() - started, status: stats.status, instance: stats.json?.instance, opened: stats.json?.opened, answered: stats.json?.summary?.answered, children: stats.json?.summary?.children, deltas: stats.json?.summary?.deltas, db: stats.json?.databaseBytes, lagP99: stats.json?.summary?.loopLagMs?.p99, error: stats.text };
    timeline.push(row);
    if (stats.json) last = stats.json;
    if (stats.json && stats.json.instance !== instance) { last = { ...last, reset: true }; break; }
    if (stats.json?.summary?.parentDoneMs != null) break;
  }
  const final = await call(`/run/${name}/stats?usage=1`);
  console.log(JSON.stringify({ name, n, ctx, tokens, tools, tps, startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), startStatus: start.status, instance, reset: final.json?.instance !== instance, final: final.json ?? final, lastBeforeReset: last?.reset ? last : undefined, timeline }));
}
