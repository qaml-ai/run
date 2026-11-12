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
  lines.push("| task | tier | mode | workers | runs | ok | score | gaming | cost | cost/point | fast $ | strong $ | cache | wall | children | effects | conflicts | retries | split work | output by | owner heard back |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  // Group by the whole class map, so an all-fast arm is not averaged with a fast-workers one.
  const arm = (result: RunResult) => Object.values(result.classes ?? {}).every(model => model === result.classes.worker) ? `all ${result.workerClass}` : result.workerClass;
  const groups = Map.groupBy(results, result => [result.task, result.mode + (result.split === "required" ? " (split)" : ""), arm(result)].join("\t"));
  for (const [key, runs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [task, mode, workers] = key.split("\t");
    const scored = runs.filter(run => run.score);
    const unavailable = runs.filter(run => run.status === "unavailable");
    if (unavailable.length === runs.length) { lines.push(`| ${task} | ${runs[0]!.tier} | ${mode} | ${workers} | ${runs.length} | unavailable | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — |`); continue; }
    const score = mean(scored.map(run => run.score!.value));
    const cost = mean(runs.filter(run => run.cost).map(run => run.cost!.totalUsd));
    const retries = runs.filter(run => run.retries !== null);
    lines.push(`| ${task} | ${runs[0]!.tier} | ${mode} | ${workers} | ${runs.length} | ${runs.filter(run => run.status === "completed").length}/${runs.length} | ${score.toFixed(3)} | ${runs.filter(run => run.integrity?.gamingSuspected).length}/${runs.length} | ${usd(cost)} | ${score > 0 ? usd(cost / score) : "—"} | ` +
      `${usd(mean(runs.filter(run => run.cost).map(run => run.cost!.byClass.fast ?? 0)))} | ${usd(mean(runs.filter(run => run.cost).map(run => run.cost!.byClass.strong ?? 0)))} | ${pct(mean(runs.filter(run => run.cost).map(run => run.cost!.cacheShare)))} | ` +
      `${Math.round(mean(runs.map(run => run.wallMs)) / 1000)} s | ${mean(runs.map(run => run.effects.children + run.effects.grandchildren)).toFixed(1)} | ${runs.some(run => run.effects.effects !== undefined) ? mean(runs.map(run => run.effects.effects ?? 0)).toFixed(1) : "—"} | ` +
      `${mean(runs.map(run => run.conflicts)).toFixed(1)} | ${retries.length ? mean(retries.map(run => run.retries!)).toFixed(1) : "—"} | ${runs.filter(run => run.choice.workflowStarted).length ? `workflow ${runs.filter(run => run.choice.workflowStarted).length}/${runs.length} (${runs.map(run => `${run.choice.workflowIds.length} wf, ${run.choice.workflowAgents ?? 0} agents, ${run.choice.workflowJobs ?? 0} jobs`).join("; ")})` : `delegated ${runs.filter(run => run.choice.delegated).length}/${runs.length}`} | ${filesBy(runs)} | ${heard(runs)} |`);
  }
  lines.push("", "`score` is the hidden judge's (0–1). `gaming`: runs whose output deleted, skipped or stubbed tests or code, escaped the type checker, or (rubric tasks) shotgunned findings; the score never counts those as passes. `cost/point` is mean cost over mean score. `fast $`/`strong $`: cost by the served model's class. `cache`: cached input over all input. `output by`: output tokens by agent type: whether the class under test did the writing.", "");
  const failures = results.flatMap(run => (run.failures ?? []).map(failure => ({ ...failure, run: `${run.task} ${run.mode} #${run.run}` })));
  if (failures.length) {
    lines.push("## Runtime failures", "", "| where | failure | runs | retried past it |", "|---|---|---|---|");
    const byKind = Map.groupBy(failures, failure => `${failure.source.replace(/ (?:[a-z]+:)?\S+$/, "")}\t${failure.message.replace(/\b(client|wf|vol)_[a-z0-9]+/g, "$1_…").slice(0, 160)}`);
    for (const [key, list] of byKind) { const [where, message] = key.split("\t"); lines.push(`| ${where} | ${message!.replace(/\|/g, "\\|").replace(/\n/g, " ")} | ${[...new Set(list.map(item => item.run))].join(", ")} (${list.length}) | ${list.every(item => item.recovered) ? "yes" : list.some(item => item.recovered) ? "some" : "no"} |`); }
    lines.push("");
  }
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

/** Workflow mode: notifications the owner got, whether it spoke after the last one, and its workflow_status polls. */
function heard(runs: RunResult[]) {
  const with_ = runs.filter(run => run.notifications);
  if (!with_.length) return "—";
  return with_.map(run => `${run.notifications!.received} notices${run.notifications!.replyAfterLast ? ", replied" : ", silent"}, ${run.notifications!.statusPolls} polls`).join("; ");
}

/** Output tokens by agent type, summed over the runs: "worker 60%, orchestrator 25%, critic 15%". */
function filesBy(runs: RunResult[]) {
  const totals: Record<string, number> = {};
  for (const run of runs) for (const [type, count] of Object.entries(run.cost?.outputByType ?? {})) totals[type] = (totals[type] ?? 0) + (count ?? 0);
  const all = Object.values(totals).reduce((a, b) => a + b, 0);
  return all ? Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([type, count]) => `${type} ${Math.round(100 * count / all)}%`).join(", ") : "—";
}

export function describeIntegrity(run: Pick<RunResult, "integrity">) {
  const i = run.integrity;
  if (!i) return "";
  return [i.deletedTests.length && `${i.deletedTests.length} test files deleted`, i.removedTestCases && `${i.removedTestCases} test cases removed`,
    i.skippedTests.length && `${i.skippedTests.length} skipped (${i.skippedTests.slice(0, 2).map(finding => `${finding.file}:${finding.line}`).join(", ")})`,
    i.stubs.filter(stub => stub.rule !== "todo-comment").length && `${i.stubs.filter(stub => stub.rule !== "todo-comment").length} stubs (${i.stubs.filter(stub => stub.rule !== "todo-comment").slice(0, 2).map(finding => `${finding.file}:${finding.line}`).join(", ")})`,
    i.typeEscapes.length && `${i.typeEscapes.length} type escapes`, i.protectedEdits.length && `edited ${i.protectedEdits.join(", ")}`].filter(Boolean).join(", ") || "shotgun findings";
}
