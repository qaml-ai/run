// Swarm-workflow evals: tiered tasks with hidden judges, run in three orchestration modes, with cost, cache share,
// effects, conflicts, retries, gaming checks and whether the agent split the work. See README.md.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning evals/workflows/run.ts list
//   … run.ts check [--tasks s-ts-port] [--sandbox host]          score every task's fixtures (reference, untouched, gamed); no runtime
//   … run.ts score <task> <dir> [--sandbox host]                  score a tree you have
//   AGENT_URL=https://run-pilot.camelai.dev AGENT_RUNTIME_TOKEN=… \
//   … run.ts run [--tasks s-ts-port,s-esm-refactor] [--modes dry] [--workers fast,strong] [--runs 1] [--label name] [--max-usd 5]
//               [--orchestrator camelrun/strong] [--split free|required] [--workflow-api auto|public|test-hook] [--allow-host dev.example] [--keep]
//   … run.ts summary .agent-runtime/eval/workflows-<label>.jsonl [more.jsonl]
//
// `run` appends one JSON line per run to .agent-runtime/eval/workflows-<label>.jsonl, writes
// .agent-runtime/eval/workflows-<label>/<task>-<mode>-<workers>-<n>/ (result.json, events.jsonl, output/), and the
// markdown summary to .agent-runtime/eval/workflows-<label>.md. Model calls cost money: not part of CI.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLASS_MODELS, guardUrl, orchestrate, Runtime } from "./lib/runtime.ts";
import { readResults, summary } from "./lib/report.ts";
import { dockerReady, type Sandbox } from "./lib/score.ts";
import { checkTask, loadTasks, scoreTree, task as findTask } from "./lib/tasks.ts";
import type { Classes, Mode, ModelClass, RunResult } from "./lib/types.ts";

const argv = process.argv.slice(2);
const arg = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined; };
const list = (name: string, fallback: string) => (arg(name) ?? fallback).split(",").map(item => item.trim()).filter(Boolean);
const DIR = ".agent-runtime/eval";

function sandbox(): Sandbox {
  const chosen = (arg("sandbox") ?? "docker") as Sandbox;
  if (chosen === "docker") { const ready = dockerReady(); if (!ready.ok) throw new Error(`Scoring runs model-written code in docker, which is not ready: ${ready.why}. --sandbox host runs it on this machine (only for trees you trust).`); }
  return chosen;
}

async function main() {
  const command = argv[0];
  if (command === "list") {
    for (const task of loadTasks()) console.log(`${task.tier}  ${task.id.padEnd(22)} ${task.status.padEnd(8)} $${task.budget.usd} / ${task.budget.wallMinutes} min  ${task.title}`);
    return;
  }
  if (command === "check") {
    const box = sandbox();
    let failed = 0;
    for (const task of loadTasks().filter(task => task.status === "ready" && (!arg("tasks") || list("tasks", "").includes(task.id)))) {
      for (const result of await checkTask(task, box)) {
        if (!result.ok) failed++;
        console.log(`${result.ok ? "ok  " : "FAIL"} ${task.id} / ${result.fixture}: score ${result.score.value} (${result.score.passed}/${result.score.expected}), gaming ${result.score.integrity.gamingSuspected}${result.why ? ` — ${result.why}` : ""}`);
      }
    }
    if (failed) process.exitCode = 1;
    return;
  }
  if (command === "score") {
    const [id, dir] = argv.slice(1);
    if (!id || !dir) throw new Error("score <task> <dir>");
    console.log(JSON.stringify(await scoreTree(findTask(id), resolve(dir), sandbox()), null, 2));
    return;
  }
  if (command === "summary") { console.log(summary(readResults(argv.slice(1).filter(path => !path.startsWith("--"))))); return; }
  if (command !== "run") throw new Error("Commands: list, check, score, run, summary (see the header of evals/workflows/run.ts)");

  const url = process.env.AGENT_URL, token = process.env.AGENT_RUNTIME_TOKEN;
  if (!url || !token) throw new Error("Set AGENT_URL (the pilot or a local Workers runtime) and AGENT_RUNTIME_TOKEN (a tenant API key for it)");
  guardUrl(url, arg("allow-host"));
  const box = sandbox();
  const label = arg("label") ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const maxUsd = Number(arg("max-usd") ?? 5);
  const tasks = list("tasks", loadTasks().filter(task => task.status === "ready" && task.tier === "S").map(task => task.id).join(",")).map(findTask);
  for (const task of tasks) if (task.status !== "ready") throw new Error(`${task.id} is ${task.status}: see its task.json and README.md for what it needs`);
  const modes = list("modes", "dry") as Mode[];
  const workers = list("workers", "fast") as ModelClass[];
  const runs = Number(arg("runs") ?? 1);
  const split = (arg("split") ?? "free") as "free" | "required";
  const runtime = new Runtime(url, token);
  const out = join(DIR, `workflows-${label}`);
  mkdirSync(out, { recursive: true });
  let spent = 0;
  // One run at a time: comparisons should not share a tenant's busy-agent slots or a provider's rate limit.
  for (const task of tasks) for (const mode of modes) for (const workerClass of workers) for (let run = 1; run <= runs; run++) {
    if (spent + task.budget.usd > maxUsd) { console.log(`stopping: ${task.id} could take spend from $${spent.toFixed(2)} past --max-usd ${maxUsd}`); break; }
    const classes: Classes = { orchestrator: arg("orchestrator") ?? CLASS_MODELS.strong, worker: CLASS_MODELS[workerClass], critic: CLASS_MODELS.strong, lead: CLASS_MODELS.strong };
    const dir = join(out, `${task.id}-${mode}-${workerClass}-${run}`);
    let result: RunResult;
    try {
      const ran = await orchestrate(runtime, task, { label, mode, workerClass, classes, run, dir, budgetUsd: task.budget.usd, split, workflowApi: (arg("workflow-api") ?? "auto") as "auto" | "public" | "test-hook" });
      const { cleanup, volumeId, ...rest } = ran;
      let score = null;
      if (volumeId && rest.status !== "unavailable") {
        await runtime.download(volumeId, join(dir, "output"));
        score = await scoreTree(task, join(dir, "output"), box);
      }
      if (!argv.includes("--keep")) await cleanup();
      result = { ...rest, score, integrity: score?.integrity ?? null };
    } catch (error) {
      result = { schema: 1, label, split, task: task.id, taskVersion: task.version, tier: task.tier, mode, workerClass, classes, run, runtime: new URL(url).host, startedAt: new Date().toISOString(), wallMs: 0,
        status: "error", error: (error as Error).stack?.slice(0, 2000) ?? String(error), score: null, integrity: null, cost: null, budgetUsd: task.budget.usd,
        effects: { children: 0, grandchildren: 0, failedChildren: 0, byStatus: {} }, conflicts: 0, retries: null, choice: { delegated: false, delegateCalls: 0, workflowStarted: false, workflowIds: [], toolCalls: {} }, artifacts: dir };
    }
    spent += result.cost?.totalUsd ?? 0;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
    appendFileSync(`${out}.jsonl`, JSON.stringify(result) + "\n");
    console.log(`${task.id} ${mode} ${workerClass} #${run}: ${result.status}${result.error ? ` (${result.error.split("\n")[0]})` : ""}, score ${result.score?.value ?? "—"}${result.integrity?.gamingSuspected ? " GAMING" : ""}, ` +
      `$${(result.cost?.totalUsd ?? 0).toFixed(3)}, cache ${Math.round((result.cost?.cacheShare ?? 0) * 100)}%, ${Math.round(result.wallMs / 1000)} s, ${result.effects.children} children, split: ${result.choice.workflowStarted ? "workflow" : result.choice.delegated ? "delegate" : "none"}`);
  }
  const markdown = summary(readResults([`${out}.jsonl`]));
  writeFileSync(`${out}.md`, markdown);
  console.log(`\n${markdown}\nTotal spend: $${spent.toFixed(3)}. Results: ${out}.jsonl, ${out}.md`);
}

// Exit explicitly: an agent client's sockets can outlive its agent and keep the process up.
await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
process.exit();
