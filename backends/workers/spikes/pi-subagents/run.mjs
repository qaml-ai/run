// Drive the deployed spike: one fresh object per run, polled until the parent answers, it resets, or time runs out.
// SPIKE_URL=https://... SPIKE_TOKEN_FILE=... node spikes/pi-subagents/run.mjs ctx=0 n=1,5,10 [remote=1] [crashAt=20000]
// crashAt resets the parent object that long after the start (as an eviction would) and keeps polling across it.
import { readFileSync } from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.split("=")));
const base = process.env.SPIKE_URL, token = readFileSync(process.env.SPIKE_TOKEN_FILE, "utf8").trim();
const levels = (args.n ?? "1,5,10,25,50,100").split(",").map(Number);
const ctx = Number(args.ctx ?? 0), tokens = Number(args.tokens ?? 2000), tools = Number(args.tools ?? 3), tps = Number(args.tps ?? 50);
const remote = args.remote === "1", crashAt = args.crashAt ? Number(args.crashAt) : undefined;
const limitMs = Number(args.limitMs ?? 8 * 60_000);
// pollMs: how often the driver asks; each ask is a request to the object, which opens a new invocation (CPU accounting).
const pollMs = Number(args.pollMs ?? 5_000);
const call = async (path, method = "GET") => {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  try { return { status: response.status, json: JSON.parse(text) }; } catch { return { status: response.status, text: text.slice(0, 300) }; }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const n of levels) {
  const name = `${remote ? "r" : "n"}${n}-ctx${ctx}${crashAt ? "-crash" : ""}${args.pollMs ? `-p${pollMs}` : ""}-${Date.now().toString(36)}`;
  const started = Date.now();
  const start = await call(`/run/${name}/start?n=${n}&tps=${tps}&tokens=${tokens}&tools=${tools}&ctx=${ctx}&watch=5${remote ? "&remote=1" : ""}`, "POST");
  const instance = start.json?.instance;
  const timeline = [];
  let crashed = false, lastBeforeReset;
  while (Date.now() - started < limitMs) {
    await sleep(pollMs);
    if (crashAt !== undefined && !crashed && Date.now() - started >= crashAt) {
      crashed = true;
      timeline.push({ t: Date.now() - started, crash: (await call(`/run/${name}/crash`, "POST")).status });
      continue;
    }
    const stats = await call(`/run/${name}/stats`);
    const s = stats.json;
    timeline.push({ t: Date.now() - started, status: stats.status, instance: s?.instance, answered: s?.summary?.answered, toolResults: s?.pi?.toolResults, deltas: s?.summary?.deltas, streaming: s?.summary?.concurrency?.at(-1), db: s?.databaseBytes, error: stats.text });
    if (s && s.instance !== instance && !lastBeforeReset) lastBeforeReset = timeline.at(-2);
    if (s && s.instance !== instance && crashAt === undefined) break;
    if (s?.pi?.parentAnswered) break;
  }
  const final = await call(`/run/${name}/stats?usage=1${remote ? "&children=1" : ""}`);
  console.log(JSON.stringify({ name, n, ctx, tokens, tools, tps, remote, crashAt, startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), wallMs: Date.now() - started, startStatus: start.status, instance, reset: final.json?.instance !== instance, final: final.json ?? final, lastBeforeReset, timeline }));
}
