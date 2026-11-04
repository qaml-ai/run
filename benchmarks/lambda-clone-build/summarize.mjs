// Offline analysis only. No credentials, network, or VM operations.
import { existsSync, readFileSync } from "node:fs";
const dir = new URL("./", import.meta.url);
const files = ["results.json", "node22-results.json", "rust-results.json", "typescript-results.json", "typescript-go127-results.json"];
const runs = files.map(file => JSON.parse(readFileSync(new URL(file, dir), "utf8")));
const auditFile = new URL("cleanup-audit.json", dir);
const audit = existsSync(auditFile) ? JSON.parse(readFileSync(auditFile, "utf8")) : undefined;
if (!audit?.verified || runs.flatMap(run => run.created).some(vm => !audit.owned.some(own => own.microvmId === vm.id && own.state === "TERMINATED"))) {
  throw new Error("Run audit.ts after every benchmark run before summarizing; every owned VM must be verified terminated.");
}
const median = a => { const s = [...a].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const metrics = step => {
  const m = /BENCH wall=([\d.]+) user=([\d.]+) sys=([\d.]+) rss_kb=(\d+) exit=(\d+)/.exec(step.stdout ?? "");
  return m ? { wall: +m[1], user: +m[2], sys: +m[3], rssKB: +m[4], cpuCores: (+m[2] + +m[3]) / +m[1] } : null;
};
const summary = runs.map((run, index) => {
  if (!run.cleanupVerified) throw new Error(`${files[index]} has not verified cleanup`);
  const groups = {};
  for (const step of run.steps) {
    const label = step.label.replace(/-\d+$/, ""), measurement = metrics(step);
    (groups[label] ??= []).push({ seconds: measurement?.wall ?? step.seconds ?? step.clientSeconds, exitCode: step.exitCode, ...measurement });
  }
  const before = run.steps.find(s => s.label === "persistence-before");
  if (before) {
    const hash = before.stdout.match(/[a-f0-9]{64}/)[0];
    const size = before.stdout.match(/\d+\s+\/root\/bench-1\/ripgrep/)[0];
    const process = before.stdout.split("\n").find(line => line.includes("sleep 3600"));
    for (const step of run.steps.filter(s => s.label.startsWith("resume-"))) {
      if (step.exitCode !== 0 || !step.stdout.includes(hash) || !step.stdout.includes(size) || !step.stdout.includes(process) || !step.stdout.startsWith("persistent\n")) {
        throw new Error(`Persistence verification failed: ${step.label}`);
      }
    }
  }
  const lifetimeSeconds = run.created.reduce((total, vm) => {
    const final = audit?.owned.find(v => v.microvmId === vm.id);
    if (final?.terminatedAt) return total + final.terminatedAt - final.startedAt;
    const firstTermination = run.api.find(event => event.op === "TerminateMicrovm" && event.id === vm.id);
    if (!firstTermination) throw new Error(`No termination for ${vm.id}`);
    return total + (Date.parse(firstTermination.at) - Date.parse(vm.startedAt)) / 1000;
  }, 0);
  const cycles = run.steps.filter(s => /^suspend-/.test(s.label)).length;
  return { file: files[index], firstExec: run.created.map(v => v.firstExecSeconds),
    groups: Object.fromEntries(Object.entries(groups).map(([label, trials]) => [label, { trials, median: median(trials.map(t => t.seconds)) }])),
    persistenceVerified: !!before, lifetimeSeconds, baselineCompute: lifetimeSeconds * run.hourlyRate / 3600,
    snapshot2GiB: run.created.length * 2 * 0.00155 + cycles * 2 * (0.0038 + 0.00155), cycles };
});
const baseCompute = summary.reduce((sum, run) => sum + run.baselineCompute, 0);
const snapshots = summary.reduce((sum, run) => sum + run.snapshot2GiB, 0);
const rustInstalls = [runs[0], runs[2]].flatMap(run => run.steps.filter(s => /^rust-install(?:-\d+)?$/.test(s.label)).map(s => metrics(s).wall));
console.log(JSON.stringify({ runs: summary, rustInstall: { trials: rustInstalls, median: median(rustInstalls) }, cost: { baselinePlus2GiBSnapshots: baseCompute + snapshots,
  fourTimesComputePlus8GiBSnapshots: 4 * (baseCompute + snapshots),
  note: "Lifetimes include suspension; final audit supplies server timestamps when available, otherwise intervals end at first TerminateMicrovm response. Add suspended storage and unmetered transfer. Snapshot size is assumed, not observed." } }, null, 2));
