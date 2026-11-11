// Summarize run.ts result files: node benchmarks/agent-memory/summarize.mjs results/*.json
import { readFileSync } from "node:fs";

const mb = x => x === undefined ? "" : Math.round(x).toString();
const rows = process.argv.slice(2).map(file => {
  const r = JSON.parse(readFileSync(file, "utf8"));
  // Wrangler's dev proxy workerd is local tooling: the runtime figures leave it out (run.ts groups it apart since
  // it was split; older files counted it inside "workerd", so subtract the proxy measured at the resident point).
  const proxy = (r.residentProcesses ?? []).filter(p => p.group === "workerd" && !/entry=127\.0\.0\.1:0\b/.test(p.cmd)).reduce((a, p) => a + p.mb, 0);
  const cpu = r.cpuSecondsPerTurn ?? {};
  return {
    file: file.split("/").pop(), backend: r.backend, agents: r.created ?? r.agents, concurrency: r.concurrency, code: r.code ?? true,
    baseline: mb(r.baselineMB - proxy), resident: mb(r.residentMB - proxy), perAgent: r.marginalMBPerAgent?.toFixed(2),
    residentPeak: mb(r.residentPeakMB === undefined ? undefined : r.residentPeakMB - proxy), peakPerAgent: r.peakMBPerAgent?.toFixed(2),
    peak: mb(r.peakMB - proxy), idle: mb(r.idleMB - proxy), proxyCounted: proxy,
    cpuMsPerTurn: Math.round(1000 * ((cpu.server ?? 0) + (cpu.workerd ?? 0) + (cpu.celld ?? 0) + (cpu["v8-exec"] ?? 0))),
    pgCpuMsPerTurn: Math.round(1000 * (cpu.postgres ?? 0)), pgPeakPss: mb(r.peakPostgresMB),
    turns: `${(r.created ?? 0) * r.turns - (r.turnErrors ?? 0)}/${(r.created ?? 0) * r.turns}`,
    code: r.codeResults ? `${r.codeResults.ok} ok/${r.codeResults.failed} failed` : "", wallS: Math.round((r.turnsWallMs ?? 0) / 1000),
    error: r.error ? r.error.split("\n")[0].slice(0, 120) : (r.firstTurnError ?? "").slice(0, 120),
  };
});
console.table(rows);
