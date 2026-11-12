// Swarm-workflow evals: tiered tasks with hidden judges, run in three orchestration modes, with cost, cache share,
// effects, conflicts, retries, gaming checks and whether the agent split the work. See README.md.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning evals/workflows/run.ts list
//   … run.ts check [--tasks s-ts-port] [--sandbox host]          score every task's fixtures (reference, untouched, gamed); no runtime
//   … run.ts score <task> <dir> [--sandbox host]                  score a tree you have
//   AGENT_URL=https://run-pilot.camelai.dev AGENT_RUNTIME_TOKEN=… \
//   … run.ts run [--tasks s-ts-port,s-esm-refactor] [--modes dry] [--workers fast,strong] [--runs 1] [--label name] [--max-usd 5]
//               [--orchestrator camelrun/strong] [--classes critic=camelrun/fast,lead=camelrun/fast] [--budget-usd n] [--runtime-log file] [--split free|required] [--workflow-api auto|public|test-hook] [--allow-host dev.example] [--keep]
//   … run.ts summary .agent-runtime/eval/workflows-<label>.jsonl [more.jsonl]
//   … run.ts rescore .agent-runtime/eval/workflows-<label>.jsonl   score saved outputs again after a judge fix
//   AGENT_URL=… AGENT_RUNTIME_TOKEN=… \
//   … run.ts choice [--modes dry,workflow] [--guidance none,evals/workflows/choice/guidance-design-draft.md] [--prompts esm-400,typo] [--runs 1] [--label name] [--max-usd 3]
//               scores whether the agent splits work when it should (evals/workflows/choice/prompts.json); stops each run at its first decision
//
// `run` appends one JSON line per run to .agent-runtime/eval/workflows-<label>.jsonl, writes
// .agent-runtime/eval/workflows-<label>/<task>-<mode>-<workers>-<n>/ (result.json, events.jsonl, output/), and the
// markdown summary to .agent-runtime/eval/workflows-<label>.md. Model calls cost money: not part of CI.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { choiceSummary, choose, loadPrompts } from "./lib/choice.ts";
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
  if (command === "choice") return choiceCommand();
  if (command === "rescore") {
    // After a judge fix: score each run's saved output again and rewrite its line (and result.json).
    const box = sandbox();
    for (const path of argv.slice(1).filter(item => !item.startsWith("--"))) {
      const results = readResults([path]);
      for (const result of results) {
        const output = join(result.artifacts, "output");
        if (!existsSync(output)) continue;
        const before = result.score?.value;
        result.score = await scoreTree(findTask(result.task), output, box);
        result.integrity = result.score.integrity;
        result.rescoredAt = new Date().toISOString();
        writeFileSync(join(result.artifacts, "result.json"), JSON.stringify(result, null, 2));
        console.log(`${result.task} ${result.mode} ${result.workerClass} #${result.run}: ${before ?? "—"} -> ${result.score.value}`);
      }
      writeFileSync(path, results.map(result => JSON.stringify(result)).join("\n") + "\n");
    }
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
    const budgetUsd = Number(arg("budget-usd") ?? task.budget.usd);
    if (spent + budgetUsd > maxUsd) { console.log(`stopping: ${task.id} could take spend from $${spent.toFixed(2)} past --max-usd ${maxUsd}`); break; }
    // --classes critic=camelrun/fast,lead=… overrides a role's model (e.g. the all-fast arm of the class eval).
    const overrides = Object.fromEntries(list("classes", "").map(pair => pair.split("=") as [string, string]));
    const classes: Classes = { orchestrator: arg("orchestrator") ?? CLASS_MODELS.strong, worker: CLASS_MODELS[workerClass], critic: CLASS_MODELS.strong, lead: CLASS_MODELS.strong, ...overrides };
    const dir = join(out, `${task.id}-${mode}-${workerClass}-${run}`);
    let result: RunResult;
    // --runtime-log: the local runtime's log (local-runtime.ts's output); its new error lines join the run's failures.
    const runtimeLog = arg("runtime-log"), logFrom = runtimeLog && existsSync(runtimeLog) ? statSync(runtimeLog).size : 0;
    try {
      const ran = await orchestrate(runtime, task, { label, mode, workerClass, classes, run, dir, budgetUsd, split, workflowApi: (arg("workflow-api") ?? "auto") as "auto" | "public" | "test-hook" });
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
        status: "error", error: (error as Error).stack?.slice(0, 2000) ?? String(error), score: null, integrity: null, cost: null, budgetUsd,
        effects: { children: 0, grandchildren: 0, failedChildren: 0, byStatus: {} }, conflicts: 0, retries: null, choice: { delegated: false, delegateCalls: 0, workflowStarted: false, workflowIds: [], toolCalls: {} }, artifacts: dir };
    }
    if (runtimeLog && existsSync(runtimeLog)) {
      const added = readFileSync(runtimeLog).subarray(logFrom).toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
      // The run's whole slice of the runtime log, kept with its other artifacts.
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "runtime.log"), added);
      const errors = [...new Set(added.split("\n").filter(line => /\bERROR\b|Uncaught|✘/.test(line)).map(line => line.replace(/^.*?(?:ERROR\]|✘)\s*/, "").trim().slice(0, 300)))];
      result.failures = [...(result.failures ?? []), ...errors.slice(0, 30).map(message => ({ source: "runtime log", message }))];
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

async function choiceCommand() {
  const url = process.env.AGENT_URL, token = process.env.AGENT_RUNTIME_TOKEN;
  if (!url || !token) throw new Error("Set AGENT_URL (the pilot or a local Workers runtime) and AGENT_RUNTIME_TOKEN (a tenant API key for it)");
  guardUrl(url, arg("allow-host"));
  const runtime = new Runtime(url, token);
  const label = arg("label") ?? `choice-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  const maxUsd = Number(arg("max-usd") ?? 3), runs = Number(arg("runs") ?? 1);
  const wanted = arg("prompts") ? list("prompts", "") : undefined;
  const prompts = loadPrompts().filter(prompt => !wanted || wanted.includes(prompt.id));
  const guidance = list("guidance", "none").map(item => item === "none" ? undefined : { name: basename(item, ".md"), text: readFileSync(item, "utf8") });
  const out = join(DIR, `workflows-${label}`);
  mkdirSync(out, { recursive: true });
  let spent = 0;
  for (const mode of list("modes", "dry") as ("dry" | "workflow")[]) for (const wording of guidance) for (let run = 1; run <= runs; run++) for (const prompt of prompts) {
    if (spent >= maxUsd) { console.log(`stopping at $${spent.toFixed(2)} (--max-usd ${maxUsd})`); break; }
    const result = await choose(runtime, prompt, { label, mode, guidance: wording, run, dir: out, capUsd: 0.5, capMs: 360_000, orchestrator: arg("orchestrator") ?? CLASS_MODELS.strong });
    spent += result.costUsd;
    appendFileSync(`${out}.jsonl`, JSON.stringify(result) + "\n");
    console.log(`${prompt.id} (${prompt.expect}) ${mode} ${wording?.name ?? "runtime"}: ${result.decision}${result.correct ? "" : " WRONG"}, ${result.subagents} sub-agents, $${result.costUsd.toFixed(3)}, ${Math.round(result.wallMs / 1000)} s${result.error ? ` (${result.error.split("\n")[0]})` : ""}`);
  }
  const markdown = choiceSummary(readFileSync(`${out}.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line)));
  writeFileSync(`${out}.md`, markdown);
  console.log(`\n${markdown}\nTotal spend: $${spent.toFixed(3)}. Results: ${out}.jsonl, ${out}.md`);
}

// Exit explicitly: an agent client's sockets can outlive its agent and keep the process up.
await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
process.exit();
