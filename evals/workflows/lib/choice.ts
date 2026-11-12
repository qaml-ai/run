// The choice eval: does an agent split work across sub-agents (dry mode) or into a workflow (workflow mode) when the
// task calls for it, and do it alone when it does not? It scores the wording an agent decides from: today the
// delegate tool's and the orchestrator's prompt, once PR 7 lands the `workflows` builtin's "when to write a workflow"
// (design open question 13), and any candidate wording passed with `--guidance`. A run stops at the agent's first
// decision, so the work itself is never paid for.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRuntime } from "../../../clients/node.ts";
import type { AgentEvent } from "../../../clients/types.ts";
import { CLASS_MODELS, ORCHESTRATOR, Runtime } from "./runtime.ts";
import type { Classes } from "./types.ts";

export interface ChoicePrompt { id: string; expect: "split" | "alone"; why: string; prompt: string; files: { dir: string; count: number; template: Template } }
type Template = "module" | "doc" | "table" | "contract" | "sql" | "source" | "readme";
export interface ChoiceResult {
  schema: 1; label: string; id: string; expect: "split" | "alone"; mode: "dry" | "workflow"; guidance: string | null; run: number;
  /** split: started a workflow that runs sub-agents (workflow mode) or at least two sub-agents in its first turn (dry mode); alone: neither before its turn ended or the cap. */
  decision: "split" | "alone" | "error";
  correct: boolean;
  subagents: number; workflowStarted: boolean;
  /** Workflow mode: what the first workflow's script runs: sub-agents, only jobs (commands, not a split), or neither. */
  workflowKind?: "agents" | "jobs" | "other";
  /** Workflow mode: workflows it started that ran no sub-agent (jobs, probes) before it decided. */
  otherWorkflows?: number; firstTools: string[]; costUsd: number; wallMs: number; capped: boolean; error?: string;
}

export const PROMPTS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "choice", "prompts.json");
export const loadPrompts = (): ChoicePrompt[] => JSON.parse(readFileSync(PROMPTS_FILE, "utf8")).prompts;

const pad = (n: number) => String(n).padStart(3, "0");
const TOPICS = ["billing", "onboarding", "search", "exports", "alerts", "teams", "audit logs", "webhooks", "imports", "reports"];
/** The prompt's files: small, plausible, deterministic. */
export function files(spec: ChoicePrompt["files"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 1; i <= spec.count; i++) {
    const at = (name: string) => spec.dir === "." ? name : `${spec.dir}/${name}`;
    const topic = TOPICS[i % TOPICS.length]!;
    if (spec.template === "module") out[at(`m${pad(i)}.js`)] = `'use strict';\nconst { format } = require('../util/format');\nconst RATE = ${i % 17 + 2};\nfunction total${i}(qty) { return qty * RATE; }\nfunction label${i}(name, qty) { return format('%s x%d', name, qty); }\nmodule.exports = { total${i}, label${i} };\n`;
    if (spec.template === "doc") out[at(`d${pad(i)}.md`)] = `# ${topic[0]!.toUpperCase()}${topic.slice(1)}, part ${i}\n\nThis guide explains how ${topic} works for workspace admins. Open **Settings**, choose *${topic}*, and follow the steps.\n\n1. Pick a workspace.\n2. Turn on ${topic}.\n3. Save, then check the activity log.\n\n> Changes take effect within a minute.\n`;
    if (spec.template === "table") out[at(`t${pad(i)}.csv`)] = ["id,name,amount", ...Array.from({ length: 30 }, (_, row) => `${row + 1},${TOPICS[(row + i) % 10]},${row % 11 === 3 ? "" : ((row * 37 + i * 11) % 500) - (row % 13 === 5 ? 600 : 0)}`)].join("\n") + "\n";
    if (spec.template === "contract") out[at(`c${pad(i)}.txt`)] = `MASTER SERVICES AGREEMENT No. ${1000 + i}\n\nBetween Shop Inc. and Vendor ${i} Ltd.\n\n4. Term. This agreement renews automatically on ${2027 + (i % 3)}-${String(1 + (i % 12)).padStart(2, "0")}-01 unless either party gives ${30 + (i % 4) * 30} days' written notice.\n\n7. Fees. Fees increase by ${(i % 5) + 2}% at each renewal${i % 7 === 0 ? ", capped at CPI" : ""}.\n`;
    if (spec.template === "sql") out[at(`s${pad(i)}.js`)] = `import { db } from "../db.js";\n\nexport async function findUser(id) {\n  return db.query(${i % 3 === 0 ? "\"SELECT * FROM users WHERE id = '\" + id + \"'\"" : "\"SELECT * FROM users WHERE id = $1\", [id]"});\n}\n\nexport async function list${i}(limit) {\n  return db.query("SELECT * FROM ${topic.replace(" ", "_")} LIMIT $1", [limit]);\n}\n\nexport function greet(user) {\n  return "Hello, " + findUser(user.id).name;\n}\n`;
    if (spec.template === "source") out[at(`s${pad(i)}.md`)] = `# Source ${i}\n\n${["A 2023 trial", "A 2024 survey", "A government pilot", "A meta-analysis", "A company case study"][i % 5]} (${["Iceland", "UK", "Spain", "Japan", "US"][i % 5]}).\n\n- Claims productivity ${i % 3 === 0 ? "fell" : "rose"} by ${(i * 7) % 30}% on a four-day week.\n- Claims ${i % 2 ? "burnout" : "sick days"} dropped.\n- Sample: ${(i * 53) % 2000 + 40} workers.\n`;
    if (spec.template === "readme") out[at("README.md")] = "# Shop\n\nCustomers recieve an email when their order ships.\n";
  }
  return out;
}

export interface ChoiceOptions { label: string; mode: "dry" | "workflow"; guidance?: { name: string; text: string }; run: number; dir: string; capUsd: number; capMs: number; orchestrator: string }

/** Runs one prompt to its first decision and stops the agent there. */
export async function choose(runtime: Runtime, prompt: ChoicePrompt, options: ChoiceOptions): Promise<ChoiceResult> {
  const started = Date.now(), prefix = `wfchoice-${options.label}-${prompt.id}-${options.run}-${started.toString(36)}`.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 90);
  const log = join(options.dir, `${prompt.id}-${options.mode}-${options.guidance?.name ?? "runtime"}-${options.run}.jsonl`);
  mkdirSync(options.dir, { recursive: true });
  writeFileSync(log, "");
  const base = { schema: 1 as const, label: options.label, id: prompt.id, expect: prompt.expect, mode: options.mode, guidance: options.guidance?.name ?? null, run: options.run };
  const cleanups: (() => Promise<unknown>)[] = [];
  try {
    const volumeId = await runtime.uploadFiles(prefix, files(prompt.files));
    cleanups.push(() => runtime.client.volume(volumeId).delete());
    const classes: Classes = { orchestrator: options.orchestrator, worker: CLASS_MODELS.fast, critic: CLASS_MODELS.strong, lead: CLASS_MODELS.strong };
    const types = await runtime.defineTypes(prefix, volumeId, classes);
    for (const key of Object.values(types.keys)) cleanups.push(() => runtime.client.deleteDefinition(key));
    let subagents = 0, workflowStarted = false, decided: (() => void) | undefined, workflowKind: ChoiceResult["workflowKind"], otherWorkflows = 0;
    const workflowIds = new Set<string>();
    const firstTools: string[] = [];
    const decision = new Promise<void>(resolve => { decided = resolve; });
    const agent = await runtime.client.createAgent({
      name: `wf-choice ${prompt.id}`, model: options.orchestrator, systemPrompt: ORCHESTRATOR + (options.guidance ? `\n\n${options.guidance.text.trim()}` : ""), ttlSeconds: 3600,
      mounts: [{ volumeId, path: "/workspace", mode: "rw" }], spendLimit: { usd: options.capUsd }, subagents: true,
      delegate: { agents: Object.entries(types.keys).map(([name, definition]) => ({ name, definition })), maxParallel: 8, maxDepth: 1 },
      onEvent(event: AgentEvent) {
        if (event.type === "tool_execution_start") {
          if (firstTools.length < 12) firstTools.push(event.toolName);
          appendFileSync(log, JSON.stringify({ call: event.toolName, args: JSON.stringify(event.args).slice(0, 1500) }) + "\n");
          if (event.toolName === "workflow_start" || (event.toolName === "codemode" && /\bworkflow_start\b/.test(JSON.stringify(event.args)))) {
            // Only a workflow that runs sub-agents splits the work. Agents also start workflows to run a command (jobs)
            // or to look around (a script that lists its globals): those are recorded, and the run goes on.
            const script = JSON.stringify(event.args);
            const kind = /\bagent\s*\(/.test(script) ? "agents" : /\bjob\s*\(/.test(script) ? "jobs" : "other";
            otherWorkflows += kind === "agents" ? 0 : 1;
            if (kind === "agents") { workflowStarted = true; workflowKind = kind; decided?.(); }
            else workflowKind ??= kind;
          }
        } else if (event.type === "tool_execution_end" && (event.toolName === "workflow_start" || event.toolName === "codemode")) {
          for (const match of JSON.stringify(event.result).matchAll(/\bwf_[A-Za-z0-9_-]{6,}/g)) workflowIds.add(match[0]);
        } else if (event.type === "subagent_start") {
          subagents++;
          appendFileSync(log, JSON.stringify({ subagentStart: event.agentId, name: event.name }) + "\n");
          if (options.mode === "dry" && subagents >= 2) decided?.();
        } else if (event.type === "message_end" && event.message?.role === "assistant") {
          appendFileSync(log, JSON.stringify({ assistant: (event.message.content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("\n").slice(0, 2000) }) + "\n");
        }
      },
    } as Parameters<AgentRuntime["createAgent"]>[0]);
    cleanups.push(() => agent.destroy());
    let capped = false;
    // In workflow mode the agent is told its /workspace's volume id, which agent({ repo }) and job({ at }) take, as in the task evals.
    const text = options.mode === "workflow" ? `${prompt.prompt}\n\nYour /workspace is volume ${volumeId}.` : prompt.prompt;
    const turn = agent.prompt(text, { timeoutMs: options.capMs }).then(() => undefined, error => { appendFileSync(log, JSON.stringify({ promptError: String(error) }) + "\n"); });
    const cap = new Promise<void>(resolve => setTimeout(() => { capped = true; resolve(); }, options.capMs));
    await Promise.race([turn, decision, cap]);
    const split = workflowStarted || (options.mode === "dry" && subagents >= 2);
    // The id comes back with workflow_start's answer, which lands after the call began: wait for it, then stop both.
    for (let wait = 0; workflowStarted && wait < 15 && !workflowIds.size; wait++) await new Promise(resolve => setTimeout(resolve, 1_000));
    await agent.abort({ children: "abort" }).catch(() => {});
    for (const id of workflowIds) await runtime.abortWorkflow("public", id);
    const costUsd = (await runtime.usage(agent.id, types.ids)).totalUsd;
    return { ...base, decision: split ? "split" : "alone", correct: (split ? "split" : "alone") === prompt.expect, subagents, workflowStarted, ...(workflowKind ? { workflowKind } : {}), ...(otherWorkflows ? { otherWorkflows } : {}), firstTools, costUsd, wallMs: Date.now() - started, capped: capped && !split };
  } catch (error) {
    return { ...base, decision: "error", correct: false, subagents: 0, workflowStarted: false, firstTools: [], costUsd: 0, wallMs: Date.now() - started, capped: false, error: String((error as Error).stack ?? error).slice(0, 1000) };
  } finally {
    for (const step of cleanups.reverse()) await step().catch(() => {});
  }
}

export function choiceSummary(results: ChoiceResult[]): string {
  const lines = ["# Choice eval", "", "Does the agent split the work when it should, and work alone when it should not?", ""];
  const groups = Map.groupBy(results, result => `${result.mode}\t${result.guidance ?? "runtime wording"}`);
  lines.push("| mode | wording | runs | accuracy | split when it should | split when it should not | delegated instead (workflow mode) | errors | cost |", "|---|---|---|---|---|---|---|---|---|");
  for (const [key, runs] of groups) {
    const [mode, wording] = key.split("\t");
    const scored = runs.filter(run => run.decision !== "error");
    const should = scored.filter(run => run.expect === "split"), shouldNot = scored.filter(run => run.expect === "alone");
    const rate = (list: ChoiceResult[]) => list.length ? `${list.filter(run => run.decision === "split").length}/${list.length}` : "—";
    lines.push(`| ${mode} | ${wording} | ${runs.length} | ${scored.length ? Math.round(100 * scored.filter(run => run.correct).length / scored.length) : 0}% | ${rate(should)} | ${rate(shouldNot)} | ${mode === "workflow" ? `${scored.filter(run => run.decision === "alone" && run.subagents >= 2).length}/${scored.length}` : "—"} | ${runs.length - scored.length} | $${runs.reduce((sum, run) => sum + run.costUsd, 0).toFixed(3)} |`);
  }
  lines.push("", "| prompt | expect | mode | wording | decision | sub-agents | first tools | cost | wall |", "|---|---|---|---|---|---|---|---|---|");
  for (const run of results) lines.push(`| ${run.id} | ${run.expect} | ${run.mode} | ${run.guidance ?? "runtime"} | ${run.decision}${run.otherWorkflows ? ` (+${run.otherWorkflows} job/probe workflows)` : ""}${run.correct ? "" : " (wrong)"}${run.capped ? " (cap)" : ""} | ${run.subagents} | ${run.firstTools.slice(0, 5).join(", ")} | $${run.costUsd.toFixed(3)} | ${Math.round(run.wallMs / 1000)} s |`);
  return lines.join("\n") + "\n";
}

export interface PollingResult {
  schema: 1; label: string; id: string; guidance: string | null; run: number;
  workflows: number; notices: number; replyAfterLast: boolean; statusPolls: number; pollsPerWorkflow: number;
  costUsd: number; wallMs: number; error?: string;
}
export const loadPolling = (): { id: string; prompt: string; files: ChoicePrompt["files"] }[] => JSON.parse(readFileSync(join(dirname(PROMPTS_FILE), "polling.json"), "utf8")).prompts;

/** Runs a prompt that needs a workflow to its end, and counts how the owner waited: workflow_status calls against notices. */
export async function waitStyle(runtime: Runtime, prompt: { id: string; prompt: string; files: ChoicePrompt["files"] }, options: Omit<ChoiceOptions, "mode">): Promise<PollingResult> {
  const started = Date.now(), prefix = `wfpoll-${options.label}-${prompt.id}-${options.run}-${started.toString(36)}`.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 90);
  const base = { schema: 1 as const, label: options.label, id: prompt.id, guidance: options.guidance?.name ?? null, run: options.run };
  const cleanups: (() => Promise<unknown>)[] = [];
  try {
    const volumeId = await runtime.uploadFiles(prefix, files(prompt.files));
    cleanups.push(() => runtime.client.volume(volumeId).delete());
    const classes: Classes = { orchestrator: options.orchestrator, worker: CLASS_MODELS.fast, critic: CLASS_MODELS.strong, lead: CLASS_MODELS.strong };
    const types = await runtime.defineTypes(prefix, volumeId, classes);
    for (const key of Object.values(types.keys)) cleanups.push(() => runtime.client.deleteDefinition(key));
    const agent = await runtime.client.createAgent({
      name: `wf-poll ${prompt.id}`, model: options.orchestrator, systemPrompt: ORCHESTRATOR + (options.guidance ? `\n\n${options.guidance.text.trim()}` : ""), ttlSeconds: 3600,
      mounts: [{ volumeId, path: "/workspace", mode: "rw" }], spendLimit: { usd: options.capUsd },
      delegate: { agents: Object.entries(types.keys).map(([name, definition]) => ({ name, definition })), maxParallel: 8, maxDepth: 1 },
    } as Parameters<AgentRuntime["createAgent"]>[0]);
    cleanups.push(() => agent.destroy());
    await agent.prompt(`${prompt.prompt}\n\nYour /workspace is volume ${volumeId}.`, { timeoutMs: options.capMs }).catch(() => {});
    const deadline = started + options.capMs;
    // Until every workflow it started has ended and it has had its turns on the notices.
    for (let pass = 0; pass < 6; pass++) {
      const before = await runtime.notifications(agent.id);
      for (const id of before.workflowIds ?? []) await runtime.waitWorkflow("public", id, deadline, 300_000, 5_000).catch(() => {});
      if (!await runtime.waitIdle(agent.id, deadline)) break;
      const after = await runtime.notifications(agent.id);
      if (after.received === before.received) break;
    }
    const seen = await runtime.notifications(agent.id);
    const workflows = Math.max(1, seen.workflowIds?.length ?? 0);
    for (const id of seen.workflowIds ?? []) await runtime.abortWorkflow("public", id);
    const costUsd = (await runtime.usage(agent.id, types.ids)).totalUsd;
    return { ...base, workflows: seen.workflowIds?.length ?? 0, notices: seen.received, replyAfterLast: seen.replyAfterLast, statusPolls: seen.statusPolls, pollsPerWorkflow: +(seen.statusPolls / workflows).toFixed(2), costUsd, wallMs: Date.now() - started };
  } catch (error) {
    return { ...base, workflows: 0, notices: 0, replyAfterLast: false, statusPolls: 0, pollsPerWorkflow: 0, costUsd: 0, wallMs: Date.now() - started, error: String((error as Error).stack ?? error).slice(0, 1000) };
  } finally {
    for (const step of cleanups.reverse()) await step().catch(() => {});
  }
}

export function pollingSummary(results: PollingResult[]): string {
  const lines = ["# Polling", "", "How the owner waits for its workflows: workflow_status calls against the notices it gets.", "",
    "| wording | runs | workflows | notices | polls per workflow | replied after the last notice | cost |", "|---|---|---|---|---|---|---|"];
  for (const [wording, runs] of Map.groupBy(results, result => result.guidance ?? "runtime wording")) {
    const sum = (key: "workflows" | "notices" | "statusPolls") => runs.reduce((total, run) => total + run[key], 0);
    lines.push(`| ${wording} | ${runs.length} | ${sum("workflows")} | ${sum("notices")} | ${(sum("statusPolls") / Math.max(1, sum("workflows"))).toFixed(2)} | ${runs.filter(run => run.replyAfterLast).length}/${runs.length} | $${runs.reduce((total, run) => total + run.costUsd, 0).toFixed(3)} |`);
  }
  lines.push("", "| prompt | wording | workflows | notices | polls | replied | cost | wall |", "|---|---|---|---|---|---|---|---|");
  for (const run of results) lines.push(`| ${run.id} | ${run.guidance ?? "runtime"} | ${run.workflows} | ${run.notices} | ${run.statusPolls} | ${run.replyAfterLast ? "yes" : "no"} | $${run.costUsd.toFixed(3)} | ${Math.round(run.wallMs / 1000)} s |${run.error ? ` ${run.error.split("\n")[0]}` : ""}`);
  return lines.join("\n") + "\n";
}
