// The runtime side of a run: the task's input on a volume, the agent types as definitions, the orchestrator, the
// three orchestration modes (dry, workflow, workflow-direct), and what the runtime reports afterwards (usage,
// children, workflow items). Everything goes through the public API with a tenant key, so it runs against the
// Workers pilot or a local Workers dev runtime alike; never against production (see `guardUrl`).
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime, schema, tool, type Tools } from "../../../clients/node.ts";
import type { AgentEvent } from "../../../clients/types.ts";
import { execIn, judgeImage, walk } from "./score.ts";
import type { AgentType, Classes, CostBreakdown, Mode, ModelClass, RunResult, Task } from "./types.ts";

/** Production hosts this harness refuses outright: evals never run on a production tenant. */
const PRODUCTION = [/(^|\.)run\.camelai\.com$/, /(^|\.)agents\.camelai\.dev$/, /(^|\.)camelai\.com$/];
const ALLOWED = [/^run-pilot\.camelai\.dev$/, /^localhost$/, /^127\.0\.0\.1$/, /^\[::1\]$/];
export function guardUrl(url: string, allowHost?: string) {
  const host = new URL(url).hostname;
  if (PRODUCTION.some(pattern => pattern.test(host)) && host !== "run-pilot.camelai.dev") throw new Error(`${host} is production: workflow evals run on the pilot (run-pilot.camelai.dev) or a local runtime`);
  if (!ALLOWED.some(pattern => pattern.test(host)) && host !== allowHost) throw new Error(`${host} is not a known eval runtime; pass --allow-host ${host} if it is a dev runtime`);
  return host;
}

/** Model classes as the runtime names them (src/virtual-models.ts), and the served models behind each, for cost by class. */
export const CLASS_MODELS: Record<ModelClass, string> = { fast: "camelrun/fast", strong: "camelrun/strong" };
const SERVED: Record<ModelClass, RegExp> = { fast: /muse-ember/, strong: /gemini-4-carbon/ };
export const classOf = (model: string): ModelClass | "other" => model.startsWith("camelrun/") ? (model.slice(9) as ModelClass) in SERVED ? model.slice(9) as ModelClass : "other" : (Object.keys(SERVED) as ModelClass[]).find(name => SERVED[name].test(model)) ?? "other";

/** The agent types' instructions. Model-facing: keep them short and plain, and review any change. */
const TYPES: Record<Exclude<AgentType, "orchestrator" | "other">, { description: string; systemPrompt: string; mode: "rw" | "ro" }> = {
  worker: { mode: "rw", description: "Does one task it is given, and may edit files in /workspace.",
    systemPrompt: "You are a worker. Do exactly the task you are given, completely, editing files under /workspace with your file tools. You cannot run commands. Never stub, skip or delete code or tests to make work look finished. End with a short summary of what you changed." },
  critic: { mode: "ro", description: "Reviews work someone else did and reports problems. Never edits files.",
    systemPrompt: "You are a critic. Find every problem in the work you are asked to review: wrong behaviour, missing pieces, stubs, skipped or weakened tests. Only report; never fix. Answer with a list of concrete findings, each naming the file and what is wrong, or say there are none." },
  lead: { mode: "rw", description: "Plans a large piece of work or judges between options.",
    systemPrompt: "You are a lead. Plan, decide or judge as asked, from the files in /workspace. Be concrete: name files, steps and decisions." },
};
/** The orchestrator's system prompt. Model-facing. It names the sub-agents but does not say to use them: whether the agent splits the work is measured. */
export const ORCHESTRATOR = "You are the lead agent on a large task. You may hand parts of it to sub-agents with delegate: worker (does one task and may edit files), critic (reviews someone else's work and reports problems, never edits) and lead (plans and judges). Sub-agents see /workspace as you do, but not this conversation, so give each a complete task. Decide for yourself whether and how to split the work. You cannot run commands. Keep your final reply short.";
/** `--split required`: the orchestrator type as the design defines it, doing no item work itself, so worker classes can be compared. Model-facing. */
const SPLIT_REQUIRED = " Do none of the item work yourself: split it among workers, have critics check their work, and send fixes back to workers.";

export type WorkflowApiKind = "public" | "test-hook";
export interface RunOptions { label: string; mode: Mode; workerClass: ModelClass; classes: Classes; run: number; dir: string; budgetUsd: number; split: "free" | "required"; workflowApi: "auto" | WorkflowApiKind }

export class Runtime {
  readonly client: AgentRuntime;
  readonly url: string;
  private readonly token: string;
  constructor(url: string, token: string) { this.url = url; this.token = token; this.client = new AgentRuntime({ url, apiKey: token }); }

  async api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(new URL(path, this.url), { method: init.method ?? "GET", headers: { authorization: `Bearer ${this.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const text = await response.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* text */ }
    return { status: response.status, body };
  }
  /**
   * Which workflow API this runtime has: the designed public one (`/v1/workflows`), the TEST_MODE operator hook the
   * internal WorkflowObject ships with before the public route (#806: `/__test/workflows/:name`, a local Workers
   * runtime and the operator token only), or none.
   */
  async workflowApi(prefer: "auto" | WorkflowApiKind = "auto"): Promise<WorkflowApiKind | null> {
    if (prefer !== "test-hook" && (await this.api("/v1/workflows?limit=1")).status === 200) return "public";
    if (prefer !== "public" && (await this.api("/__test/workflows/wfeval-probe")).status !== 404) return "test-hook";
    return null;
  }
  private workflowPath(kind: WorkflowApiKind, id: string, action = "") { return `${kind === "public" ? "/v1/workflows" : "/__test/workflows"}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`; }
  /** Starts a script. The test hook takes no args and no name (the name is in the path), so args are inlined as a const either way. */
  async startWorkflow(kind: WorkflowApiKind, name: string, input: { script: string; args: Record<string, unknown>; budgetUsd: number; concurrency: number }) {
    const code = `const args = ${JSON.stringify(input.args)};\n${input.script.replace(/^export\s+/gm, "")}`;
    const { status, body } = kind === "public"
      ? await this.api("/v1/workflows", { method: "POST", body: { name, script: code, args: input.args, budget: { usd: input.budgetUsd }, concurrency: input.concurrency, ttlSeconds: 86_400 } })
      : await this.api(this.workflowPath(kind, name), { method: "POST", body: { code, budgetUsd: input.budgetUsd, concurrency: input.concurrency } });
    if (status !== 201 && status !== 200) throw new Error(`starting the workflow: ${status} ${JSON.stringify(body).slice(0, 300)}`);
    return kind === "public" ? String(body.id) : name;
  }
  abortWorkflow(kind: WorkflowApiKind, id: string) { return this.api(this.workflowPath(kind, id, "abort"), { method: "POST", body: {} }); }

  async upload(task: Task, name: string) {
    const root = join(task.dir, "input");
    return this.uploadFiles(name, Object.fromEntries(walk(root).map(path => [path, readFileSync(join(root, path), "utf8")])));
  }
  /** A new volume holding these files, written as one commit. */
  async uploadFiles(name: string, files: Record<string, string>) {
    const volume = await this.client.createVolume({ name });
    const result = await this.client.volume(volume.id).commit(Object.entries(files).map(([path, text]) => ({ path, version: 0, text })));
    if ("conflicts" in result) throw new Error(`Uploading ${name}: ${JSON.stringify(result.conflicts).slice(0, 300)}`);
    return volume.id;
  }
  /** The volume as it is now, unpacked into `dest`. */
  async download(volumeId: string, dest: string) {
    mkdirSync(dest, { recursive: true });
    const { body } = await this.client.volume(volumeId).archive();
    const bytes = Buffer.from(await new Response(body).arrayBuffer());
    const untar = spawnSync("tar", ["-xzf", "-", "-C", dest], { input: bytes });
    if (untar.status !== 0) throw new Error(`Unpacking the output: ${untar.stderr.toString().slice(0, 300)}`);
  }

  /** Worker, critic and lead as definitions on the run's volume, so usage groups by type. */
  async defineTypes(prefix: string, volumeId: string, classes: Classes) {
    const ids: Record<string, AgentType> = {};
    const keys: Record<string, string> = {};
    for (const [type, spec] of Object.entries(TYPES)) {
      const key = `${prefix}-${type}`;
      const definition = await this.client.upsertDefinition(key, { name: type, description: spec.description, systemPrompt: spec.systemPrompt, model: classes[type as keyof Classes],
        mounts: [{ volumeId, path: "/workspace", mode: spec.mode }], limits: { ttlSeconds: 86_400 } });
      ids[(definition as { id: string }).id] = type as AgentType;
      ids[key] = type as AgentType;
      keys[type] = key;
    }
    return { ids, keys };
  }

  /** Cost of an agent and everything under it, by definition and model. */
  async usage(agentId: string, types: Record<string, AgentType>, rollup = true): Promise<CostBreakdown> {
    const groups: Record<string, any>[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.agentUsage(agentId, { groupBy: ["definition", "model"], rollup, days: 2, limit: 500, cursor });
      groups.push(...page.groups);
      cursor = page.next;
    } while (cursor);
    const cost: CostBreakdown = { totalUsd: 0, byType: {}, byModel: {}, byClass: {}, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cacheShare: 0, responses: 0 };
    for (const group of groups) {
      const usd = Number(group.cost ?? 0), model = String(group.model ?? "unknown");
      const type: AgentType = group.definition ? types[String(group.definition)] ?? "other" : "orchestrator";
      cost.totalUsd += usd;
      cost.byType[type] = (cost.byType[type] ?? 0) + usd;
      cost.byModel[model] = (cost.byModel[model] ?? 0) + usd;
      cost.byClass[classOf(model)] = (cost.byClass[classOf(model)] ?? 0) + usd;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) cost.tokens[key] += Number(group[key] ?? 0);
      cost.responses += Number(group.responses ?? 0);
    }
    const inputs = cost.tokens.input + cost.tokens.cacheRead + cost.tokens.cacheWrite;
    cost.cacheShare = inputs ? +(cost.tokens.cacheRead / inputs).toFixed(4) : 0;
    return cost;
  }

  /** Children and grandchildren, by status, and the tool errors in their histories that were write conflicts. */
  async children(agentId: string) {
    const byStatus: Record<string, number> = {};
    let children = 0, grandchildren = 0, failed = 0, conflicts = 0;
    const visit = async (id: string, depth: number) => {
      const { status, body } = await this.api<{ children: { agentId: string; status: string }[] }>(`/v1/agents/${encodeURIComponent(id)}/children`);
      if (status !== 200) return;
      for (const child of body.children ?? []) {
        if (depth === 1) children++; else grandchildren++;
        byStatus[child.status] = (byStatus[child.status] ?? 0) + 1;
        if (child.status === "failed" || child.status === "aborted") failed++;
        conflicts += await this.conflicts(child.agentId);
        if (depth < 3) await visit(child.agentId, depth + 1);
      }
    };
    await visit(agentId, 1);
    return { children, grandchildren, failedChildren: failed, byStatus, conflicts };
  }
  /** Write conflicts an agent's tools reported (a volume version check, a commit conflict). */
  async conflicts(agentId: string) {
    const { status, body } = await this.api<{ messages: { role: string; isError?: boolean; content?: { type: string; text?: string }[] }[] }>(`/v1/agents/${encodeURIComponent(agentId)}/history`);
    if (status !== 200) return 0;
    return (body.messages ?? []).filter(message => message.role === "toolResult" && message.isError &&
      /conflict|changed since|was modified|COMMIT_CONFLICT|not at version/i.test((message.content ?? []).map(part => part.text ?? "").join(" "))).length;
  }

  /** Every item of a workflow, all attempts (`GET …/items`, paged by `next`: a cursor, or the hook's `ord` as `after`). */
  async workflowItems(kind: WorkflowApiKind, id: string) {
    const items: Record<string, any>[] = [];
    let next: string | number | undefined;
    do {
      const query = new URLSearchParams({ attempts: "true", limit: "500", ...(next === undefined ? {} : typeof next === "number" ? { after: String(next) } : { cursor: next }) });
      const { status, body } = await this.api(`${this.workflowPath(kind, id, "items")}?${query}`);
      if (status !== 200) throw new Error(`workflow items ${status}: ${JSON.stringify(body).slice(0, 200)}`);
      items.push(...(body.items ?? []));
      next = body.next ?? undefined;
    } while (next !== undefined && next !== null);
    return items;
  }
  /** Waits for a workflow to end (completed, failed, aborted, budget_exhausted), or to sit paused or waiting past `stallMs`. */
  async waitWorkflow(kind: WorkflowApiKind, id: string, deadline: number, stallMs = 600_000, pollMs = 10_000) {
    let since = Date.now(), last = "";
    for (;;) {
      const { status, body } = await this.api(this.workflowPath(kind, id));
      if (status !== 200) throw new Error(`workflow ${id}: ${status}`);
      if (["completed", "failed", "aborted", "budget_exhausted"].includes(body.status)) return body;
      if (body.status !== last) { last = body.status; since = Date.now(); }
      if ((["paused", "waiting"].includes(body.status) && Date.now() - since > stallMs) || Date.now() > deadline) return { ...body, stalled: true };
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
  /** Effects, children, jobs, retries and conflicts from a workflow's items; cost from its ledger. */
  workflowStats(items: Record<string, any>[], workflow: Record<string, any>, types: Record<string, AgentType> = {}) {
    const byStatus: Record<string, number> = {};
    for (const item of items) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    const agents = items.filter(item => item.kind === "agent");
    const cost: CostBreakdown = { totalUsd: Number(workflow.spent?.usd ?? 0), byType: {}, byModel: {}, byClass: {}, responses: 0,
      tokens: { input: Number(workflow.spent?.inputTokens ?? 0), output: Number(workflow.spent?.outputTokens ?? 0), cacheRead: Number(workflow.spent?.cachedInputTokens ?? 0), cacheWrite: 0 }, cacheShare: 0 };
    for (const item of items) {
      // An item's type: its own field once PR 8 adds one, else the definition the effect named.
      const usd = Number(item.costUsd ?? 0), model = String(item.model ?? "unknown");
      const type = (item.type ?? item.args?.type ?? types[String(item.args?.definition)] ?? "other") as AgentType;
      cost.byType[type] = (cost.byType[type] ?? 0) + usd;
      cost.byModel[model] = (cost.byModel[model] ?? 0) + usd;
      cost.byClass[classOf(model)] = (cost.byClass[classOf(model)] ?? 0) + usd;
    }
    const inputs = cost.tokens.input + cost.tokens.cacheRead;
    cost.cacheShare = inputs ? +(cost.tokens.cacheRead / inputs).toFixed(4) : 0;
    return {
      effects: { children: agents.length, grandchildren: 0, effects: items.length, jobs: items.filter(item => item.kind === "job").length, failedChildren: agents.filter(item => ["failed", "aborted", "refused"].includes(item.status)).length, byStatus },
      retries: items.filter(item => Number(item.attempt ?? 1) > 1 && item.current !== false).reduce((sum, item) => sum + Number(item.attempt) - 1, 0),
      conflicts: items.filter(item => /conflict/i.test(String(item.error ?? item.reason ?? ""))).length,
      cost,
    };
  }
}

/**
 * Dry mode's stand-in for phase 1's `job()`: tools the harness serves to the orchestrator that run one command over
 * the volume as it is now, in the task's judge image with no network, and answer its output. They never run the
 * hidden judge. Model-facing: the descriptions are the tools' wording.
 */
function jobTools(runtime: Runtime, task: Task, volumeId: string, log: (entry: unknown) => void, jobs: { count: number; ms: number }): Tools {
  if (!task.jobs?.includes("go")) return {};
  const run = async (script: string, env: Record<string, string> = {}) => {
    const started = Date.now(), dir = mkdtempSync(join(tmpdir(), "wf-eval-job-"));
    try {
      await runtime.download(volumeId, dir);
      const result = execIn("docker", dir, ["sh", "-c", script], { env, image: judgeImage(join(task.dir, task.judgeImage ?? "judge")), timeoutMs: 180_000 });
      const output = `${result.stdout}${result.stderr}`.slice(0, 12_000) + (result.timedOut ? "\n(timed out after 180 s)" : "");
      log({ job: script.slice(0, 80), exit: result.status, ms: Date.now() - started });
      return output || "(no output)";
    } finally { jobs.count++; jobs.ms += Date.now() - started; rmSync(dir, { recursive: true, force: true }); }
  };
  const go = "export GOPROXY=off GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=mod HOME=/tmp GOCACHE=/tmp/gocache; cd /work/go || exit 1";
  return {
    go_build: tool({ description: "Build /workspace/go as it is now (go build ./... then go vet ./...) in a fresh container, and answer the compiler's output. Takes up to a minute.",
      input: schema.Object({}, { additionalProperties: false }),
      execute: () => run(`${go}; go build ./... 2>&1 | head -c 8000; echo "go build exit: $?"; go vet ./... 2>&1 | head -c 4000`) }),
    go_decode: tool({ description: "Build cmd/toml-decoder from /workspace/go and run it on the TOML given, answering its stdout, stderr and exit code: for checking the port on examples you write.",
      input: schema.Object({ toml: schema.String({ description: "TOML to decode" }) }, { additionalProperties: false }),
      execute: ({ toml }) => run(`${go}; go build -o /tmp/decoder ./cmd/toml-decoder 2>&1 | head -c 6000 || exit 1; printf '%s' "$TOML_INPUT" | /tmp/decoder; echo "exit: $?"`, { TOML_INPUT: toml }) }),
  };
}

/** Runs one task once in one mode, and returns everything but the score. */
export async function orchestrate(runtime: Runtime, task: Task, options: RunOptions): Promise<Omit<RunResult, "score" | "integrity"> & { volumeId?: string; cleanup: () => Promise<void> }> {
  const started = Date.now(), deadline = started + task.budget.wallMinutes * 60_000;
  const prefix = `wfeval-${options.label}-${task.id}-${options.mode}-${options.workerClass}-${options.run}-${started.toString(36)}`.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 100);
  const events = join(options.dir, "events.jsonl");
  mkdirSync(options.dir, { recursive: true });
  writeFileSync(events, "");
  const log = (entry: unknown) => appendFileSync(events, JSON.stringify(entry) + "\n");
  const base: Omit<RunResult, "score" | "integrity"> = {
    schema: 1, label: options.label, split: options.split, task: task.id, taskVersion: task.version, tier: task.tier, mode: options.mode, workerClass: options.workerClass, classes: options.classes,
    run: options.run, runtime: new URL(runtime.url).host, startedAt: new Date(started).toISOString(), wallMs: 0, status: "completed", cost: null, budgetUsd: options.budgetUsd,
    effects: { children: 0, grandchildren: 0, failedChildren: 0, byStatus: {} }, conflicts: 0, retries: 0,
    choice: { delegated: false, delegateCalls: 0, workflowStarted: false, workflowIds: [], toolCalls: {} }, artifacts: options.dir,
  };
  const api = options.mode === "dry" ? null : await runtime.workflowApi(options.mode === "workflow" ? "public" : options.workflowApi);
  if (options.mode !== "dry" && !api)
    return { ...base, status: "unavailable", error: options.mode === "workflow"
      ? "This runtime has no /v1/workflows: workflow mode needs the public route and the workflows builtin (phase-1 PR 7)"
      : "This runtime has no workflow API: workflow-direct needs /v1/workflows, or on a local TEST_MODE runtime the WorkflowObject's operator hook (#806) with the agent() executor (#804)", cleanup: async () => {} };

  const volumeId = await runtime.upload(task, prefix);
  const cleanups: (() => Promise<unknown>)[] = [() => runtime.client.volume(volumeId).delete()];
  const cleanup = async () => { for (const step of cleanups.reverse()) await step().catch(error => log({ cleanupError: String(error) })); };

  if (options.mode === "workflow-direct") {
    // The task's reference script, its children made from the run's type definitions (which mount the task's volume).
    const types = await runtime.defineTypes(prefix, volumeId, options.classes);
    for (const key of Object.values(types.keys)) cleanups.push(() => runtime.client.deleteDefinition(key));
    const id = await runtime.startWorkflow(api!, prefix.slice(0, 64), { script: readFileSync(join(task.dir, "workflow.js"), "utf8"),
      args: { ...task.workflowArgs, definitions: types.keys, workerClass: options.workerClass }, budgetUsd: options.budgetUsd, concurrency: 8 });
    cleanups.push(() => runtime.abortWorkflow(api!, id));
    const ended = await runtime.waitWorkflow(api!, id, deadline);
    const stats = runtime.workflowStats(await runtime.workflowItems(api!, id), ended, types.ids);
    log({ workflow: ended });
    return { ...base, ...stats, status: ended.status === "completed" ? "completed" : ended.status === "budget_exhausted" ? "budget" : ended.stalled ? "timeout" : "failed",
      error: ended.error ?? ended.fault?.message, choice: { ...base.choice, workflowStarted: true, workflowIds: [id] }, wallMs: Date.now() - started, volumeId, cleanup };
  }

  // dry and workflow: an orchestrator agent given the task, with the agent types to delegate to.
  const types = await runtime.defineTypes(prefix, volumeId, options.classes);
  for (const key of Object.values(types.keys)) cleanups.push(() => runtime.client.deleteDefinition(key));
  const toolCalls: Record<string, number> = {};
  let delegateCalls = 0;
  const jobs = { count: 0, ms: 0 };
  const agent = await runtime.client.createAgent({
    tools: jobTools(runtime, task, volumeId, log, jobs),
    name: `wf-eval ${task.id}`, model: options.classes.orchestrator, systemPrompt: (task.jobs?.length ? ORCHESTRATOR.replace("You cannot run commands.", "You cannot run commands except through the build tools you are given.") : ORCHESTRATOR) + (options.split === "required" ? SPLIT_REQUIRED : ""), ttlSeconds: 86_400,
    mounts: [{ volumeId, path: "/workspace", mode: "rw" }], spendLimit: { usd: options.budgetUsd }, subagents: true,
    delegate: { agents: Object.entries(types.keys).map(([name, definition]) => ({ name, definition })), maxParallel: 8, maxDepth: 1 },
    onEvent(event: AgentEvent) {
      if (event.type === "tool_execution_start") { toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1; log({ call: event.toolName, args: JSON.stringify(event.args).slice(0, 4000) }); }
      else if (event.type === "tool_execution_end") log({ result: event.toolName, isError: event.isError, text: JSON.stringify(event.result).slice(0, 2000) });
      else if (event.type === "subagent_start") { delegateCalls++; log({ subagentStart: event.agentId, name: event.name, depth: event.depth }); }
      else if (event.type === "subagent_end") log({ subagentEnd: event.agentId, status: event.status, error: event.error });
      else if (event.type === "message_end" && event.message?.role === "assistant") log({ assistant: (event.message.content as { type: string; text?: string }[]).filter(part => part.type === "text").map(part => part.text).join("\n").slice(0, 4000), stopReason: (event.message as { stopReason?: string }).stopReason });
      else if (event.type === "spend_limit_reached") log({ spendLimit: event.message });
    },
  } as Parameters<AgentRuntime["createAgent"]>[0]);
  cleanups.push(() => agent.destroy());
  // The spend watchdog: the agent's spend limit bounds it and its sub-agents; this also stops a workflow it started.
  let stopped: RunResult["status"] | undefined;
  const watchdog = setInterval(async () => {
    try {
      const spent = (await runtime.usage(agent.id, types.ids)).totalUsd;
      if (spent > options.budgetUsd * 1.05 && !stopped) { stopped = "budget"; log({ watchdog: "budget", spent }); await agent.abort({ children: "abort" }); }
    } catch (error) { log({ watchdogError: String(error) }); }
  }, 30_000);
  let reply: string | undefined, runError: string | undefined, runStatus: RunResult["status"] = "completed";
  try {
    const result = await agent.prompt(task.prompt, { timeoutMs: Math.max(60_000, deadline - Date.now()) });
    reply = result.reply;
    // toolCalls includes code mode's inner calls, which the event stream does not show as tool calls.
    const calls: { tool: string; innerCallId?: string }[] = result.toolCalls ?? [];
    delegateCalls = Math.max(delegateCalls, calls.filter(call => call.tool === "delegate").length);
    for (const call of calls) if (call.innerCallId) toolCalls[`codemode:${call.tool}`] = (toolCalls[`codemode:${call.tool}`] ?? 0) + 1;
    if (result.error) { runError = result.error; runStatus = result.stopped === "spend_limit" ? "budget" : "failed"; }
    else if (result.stopped === "spend_limit") runStatus = "budget";
  } catch (error) {
    runError = (error as Error).message;
    runStatus = Date.now() >= deadline || /timed? ?out/i.test(runError) ? "timeout" : "failed";
    await agent.abort({ children: "abort" }).catch(() => {});
  } finally { clearInterval(watchdog); }
  if (stopped) runStatus = stopped;

  // workflow mode: what the agent started, run to its end.
  const workflowIds: string[] = [];
  let workflowStats: ReturnType<Runtime["workflowStats"]> | undefined;
  if (options.mode === "workflow") {
    const { body } = await runtime.api(`/v1/workflows?owner=${encodeURIComponent(agent.id)}`);
    for (const workflow of body.workflows ?? body.data ?? []) {
      workflowIds.push(workflow.id);
      cleanups.push(() => runtime.abortWorkflow("public", workflow.id));
      const ended = await runtime.waitWorkflow("public", workflow.id, deadline);
      const stats = runtime.workflowStats(await runtime.workflowItems("public", workflow.id), ended, types.ids);
      log({ workflow: ended });
      workflowStats = workflowStats ? { ...stats, retries: workflowStats.retries + stats.retries, conflicts: workflowStats.conflicts + stats.conflicts } : stats;
      if (ended.status === "budget_exhausted") runStatus = "budget"; else if (ended.stalled) runStatus = "timeout"; else if (ended.status !== "completed" && runStatus === "completed") runStatus = "failed";
    }
    // The agent hears each workflow's ending as a notification and may act on it: give that turn time to land.
    if (workflowIds.length) await new Promise(resolve => setTimeout(resolve, 60_000));
  }

  const children = await runtime.children(agent.id);
  const own = await runtime.usage(agent.id, types.ids);
  const cost = workflowStats ? mergeCost(own, workflowStats.cost) : own;
  return {
    ...base, status: runStatus, error: runError, reply, wallMs: Date.now() - started, volumeId, cleanup,
    cost, effects: workflowStats ? { ...workflowStats.effects, children: workflowStats.effects.children + children.children, grandchildren: children.grandchildren, jobs: (workflowStats.effects.jobs ?? 0) + jobs.count } : { ...children, ...(jobs.count ? { jobs: jobs.count } : {}) },
    conflicts: children.conflicts + (workflowStats?.conflicts ?? 0), retries: workflowStats ? workflowStats.retries : null,
    choice: { delegated: children.children > 0 || delegateCalls > 0, delegateCalls: Math.max(delegateCalls, children.children), workflowStarted: workflowIds.length > 0 || !!toolCalls.workflow_start, workflowIds, toolCalls },
  };
}

/** The orchestrator's own usage (rollup) plus a workflow's ledger. If the runtime ever rolls workflow children up under their starting agent, this double counts: check against `GET /v1/usage` when PR 7 lands. */
function mergeCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const add = <K extends string>(x: Partial<Record<K, number>>, y: Partial<Record<K, number>>) => { const out = { ...x }; for (const [key, value] of Object.entries(y) as [K, number][]) out[key] = (out[key] ?? 0) + value; return out; };
  const tokens = { input: a.tokens.input + b.tokens.input, output: a.tokens.output + b.tokens.output, cacheRead: a.tokens.cacheRead + b.tokens.cacheRead, cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite };
  const inputs = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return { totalUsd: a.totalUsd + b.totalUsd, byType: add(a.byType, b.byType), byModel: add(a.byModel, b.byModel) as Record<string, number>, byClass: add(a.byClass, b.byClass), tokens, cacheShare: inputs ? +(tokens.cacheRead / inputs).toFixed(4) : 0, responses: a.responses + b.responses };
}
