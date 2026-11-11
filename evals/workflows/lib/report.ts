// Results: one JSON line per run, and a markdown summary grouped by task, mode and worker class. camelRun has no
// eval viewer (chiridion's evals.camelai.dev is chiridion's), so the summary is markdown, in the same shape as
// scripts/eval-agent.ts's.
import { readFileSync } from "node:fs";
import type { RunResult } from "./types.ts";

export const readResults = (paths: string[]): RunResult[] => paths.flatMap(path => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as RunResult));

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
const usd = (value: number) => Number.isNaN(value) ? "—" : value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
const pct = (value: number) => Number.isNaN(value) ? "—" : `${Math.round(value * 100)}%`;

export function summary(results: RunResult[]): string {
  const lines = ["# Workflow evals", ""];
  const labels = [...new Set(results.map(result => result.label))];
  lines.push(`Labels: ${labels.join(", ")}. Runtimes: ${[...new Set(results.map(result => result.runtime))].join(", ")}. ${results.length} runs.`, "");
  lines.push("| task | tier | mode | workers | runs | ok | score | gaming | cost | cost/point | fast $ | strong $ | cache | wall | children | effects | conflicts | retries | split work |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const groups = Map.groupBy(results, result => [result.task, result.mode + (result.split === "required" ? " (split)" : ""), result.workerClass].join("\t"));
  for (const [key, runs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [task, mode, workers] = key.split("\t");
    const scored = runs.filter(run => run.score);
    const unavailable = runs.filter(run => run.status === "unavailable");
    if (unavailable.length === runs.length) { lines.push(`| ${task} | ${runs[0]!.tier} | ${mode} | ${workers} | ${runs.length} | unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — |`); continue; }
    const score = mean(scored.map(run => run.score!.value));
    const cost = mean(runs.filter(run => run.cost).map(run => run.cost!.totalUsd));
    const retries = runs.filter(run => run.retries !== null);
    lines.push(`| ${task} | ${runs[0]!.tier} | ${mode} | ${workers} | ${runs.length} | ${runs.filter(run => run.status === "completed").length}/${runs.length} | ${score.toFixed(3)} | ${runs.filter(run => run.integrity?.gamingSuspected).length}/${runs.length} | ${usd(cost)} | ${score > 0 ? usd(cost / score) : "—"} | ` +
      `${usd(mean(runs.filter(run => run.cost).map(run => run.cost!.byClass.fast ?? 0)))} | ${usd(mean(runs.filter(run => run.cost).map(run => run.cost!.byClass.strong ?? 0)))} | ${pct(mean(runs.filter(run => run.cost).map(run => run.cost!.cacheShare)))} | ` +
      `${Math.round(mean(runs.map(run => run.wallMs)) / 1000)} s | ${mean(runs.map(run => run.effects.children + run.effects.grandchildren)).toFixed(1)} | ${runs.some(run => run.effects.effects !== undefined) ? mean(runs.map(run => run.effects.effects ?? 0)).toFixed(1) : "—"} | ` +
      `${mean(runs.map(run => run.conflicts)).toFixed(1)} | ${retries.length ? mean(retries.map(run => run.retries!)).toFixed(1) : "—"} | ${runs.filter(run => run.choice.workflowStarted).length ? `workflow ${runs.filter(run => run.choice.workflowStarted).length}/${runs.length}` : `delegated ${runs.filter(run => run.choice.delegated).length}/${runs.length}`} |`);
  }
  lines.push("", "`score` is the hidden judge's (0–1). `gaming`: runs whose output deleted, skipped or stubbed tests or code, escaped the type checker, or (rubric tasks) shotgunned findings; the score never counts those as passes. `cost/point` is mean cost over mean score. `fast $`/`strong $`: cost by the served model's class. `cache`: cached input over all input.", "");
  const detail = results.filter(run => run.score && (run.integrity?.gamingSuspected || run.score.notes.length) || run.error);
  if (detail.length) {
    lines.push("## Notes per run", "");
    for (const run of detail) {
      lines.push(`- **${run.task} ${run.mode} ${run.workerClass} #${run.run}** (${run.status}${run.score ? `, score ${run.score.value}` : ""}): ${[run.error,
        ...(run.integrity?.gamingSuspected ? [`gaming: ${describeIntegrity(run)}`] : []), ...(run.score?.notes ?? []).slice(0, 4)].filter(Boolean).join("; ")}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function describeIntegrity(run: Pick<RunResult, "integrity">) {
  const i = run.integrity;
  if (!i) return "";
  return [i.deletedTests.length && `${i.deletedTests.length} test files deleted`, i.removedTestCases && `${i.removedTestCases} test cases removed`,
    i.skippedTests.length && `${i.skippedTests.length} skipped (${i.skippedTests.slice(0, 2).map(finding => `${finding.file}:${finding.line}`).join(", ")})`,
    i.stubs.filter(stub => stub.rule !== "todo-comment").length && `${i.stubs.filter(stub => stub.rule !== "todo-comment").length} stubs (${i.stubs.filter(stub => stub.rule !== "todo-comment").slice(0, 2).map(finding => `${finding.file}:${finding.line}`).join(", ")})`,
    i.typeEscapes.length && `${i.typeEscapes.length} type escapes`, i.protectedEdits.length && `edited ${i.protectedEdits.join(", ")}`].filter(Boolean).join(", ") || "shotgun findings";
}
