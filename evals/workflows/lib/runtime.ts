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
import type { AgentType, Classes, CostBreakdown, Mode, ModelClass, RunFailure, RunResult, Task } from "./types.ts";

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
export interface RunOptions { label: string; mode: Mode; workerClass: ModelClass; classes: Classes; run: number; dir: string; budgetUsd: number; split: "free" | "required"; workflowApi: "auto" | WorkflowApiKind;
  /** Candidate wording appended to the orchestrator's system prompt (`--guidance`), as the choice eval does. */
  guidance?: { name: string; text: string } }

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
   * The tenant's spend today, by served model: the run's cost is the change across it (runs are serialized), which
   * counts everything an agent, its workflows' children and their jobs charged, however usage rolls up.
   */
  async tenantSpend() {
    const page = await this.client.usage({ groupBy: ["model"], days: 1, limit: 500 });
    const byModel: Record<string, { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; responses: number }> = {};
    for (const group of page.groups) byModel[String(group.model)] = { cost: Number(group.cost ?? 0), input: Number(group.input ?? 0), output: Number(group.output ?? 0), cacheRead: Number(group.cacheRead ?? 0), cacheWrite: Number(group.cacheWrite ?? 0), responses: Number(group.responses ?? 0) };
    return byModel;
  }
  /** Waits until the agent has no prompt, notification turn or resume queued or running (GET …/state `busy`), twice in a row. */
  async waitIdle(agentId: string, deadline: number) {
    let quiet = 0;
    while (Date.now() < deadline) {
      const { status, body } = await this.api(`/v1/agents/${encodeURIComponent(agentId)}/state`);
      quiet = status === 200 && !body.busy ? quiet + 1 : 0;
      if (quiet >= 2) return true;
      await new Promise(resolve => setTimeout(resolve, 5_000));
    }
    return false;
  }
  /**
   * The agent's history: the workflow notifications it got (user messages the runtime wrote with metadata
   * `{ kind: "workflow", event }`, which the model sees wrapped in <workflow_notification>), whether it wrote text after
   * the last one (it reported back), and how many workflow_status calls it made (polling).
   */
  async notifications(agentId: string) {
    const { status, body } = await this.api<{ messages: { role: string; content?: unknown; metadata?: { kind?: string; event?: string; workflowId?: string } }[] }>(`/v1/agents/${encodeURIComponent(agentId)}/history`);
    if (status !== 200) return { received: 0, events: [] as string[], replyAfterLast: false, statusPolls: 0, workflowIds: [] as string[] };
    const messages = body.messages ?? [];
    let last = -1;
    const events: string[] = [];
    const workflowIds = new Set<string>();
    messages.forEach((message, index) => {
      if (message.role !== "user" || message.metadata?.kind !== "workflow") return;
      events.push(String(message.metadata.event ?? ""));
      if (message.metadata.workflowId) workflowIds.add(message.metadata.workflowId);
      last = index;
    });
    const spoke = (message: { content?: unknown }) => Array.isArray(message.content) && message.content.some((part: { type?: string; text?: string }) => part?.type === "text" && (part.text ?? "").trim().length > 0);
    const replyAfterLast = last >= 0 && messages.slice(last + 1).some(message => message.role === "assistant" && spoke(message));
    const statusPolls = messages.filter(message => message.role === "assistant" && Array.isArray(message.content))
      .reduce((sum, message) => sum + (message.content as { type?: string; name?: string }[]).filter(part => part?.type === "toolCall" && part.name === "workflow_status").length, 0);
    return { received: events.length, events, replyAfterLast, statusPolls, workflowIds: [...workflowIds] };
  }
  /**
   * Which workflow API this runtime has: the designed public one (`/v1/workflows`), the TEST_MODE operator hook the
   * internal WorkflowObject ships with before the public route (#806: `/__test/workflows/:name`, a local Workers
   * runtime and the operator token only), or none.
   */
  async workflowApi(prefer: "auto" | WorkflowApiKind = "auto"): Promise<WorkflowApiKind | null> {
    // The public collection takes POST only (GET answers 405) and 403 WORKFLOWS_OFF for a tenant without workflows.
    if (prefer !== "test-hook") { const { status } = await this.api("/v1/workflows"); if (status === 200 || status === 405) return "public"; }
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
  /** Aborts a workflow that has not ended (an ended one is left alone: aborting it is a 409 the runtime logs). */
  async abortWorkflow(kind: WorkflowApiKind, id: string) {
    const { status, body } = await this.api(this.workflowPath(kind, id));
    if (status === 200 && ["completed", "failed", "aborted", "budget_exhausted"].includes(body.status)) return { status: 200, body };
    return this.api(this.workflowPath(kind, id, "abort"), { method: "POST", body: {} });
  }

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
    const cost: CostBreakdown = { totalUsd: 0, byType: {}, outputByType: {}, byModel: {}, byClass: {}, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cacheShare: 0, responses: 0 };
    for (const group of groups) {
      const usd = Number(group.cost ?? 0), model = String(group.model ?? "unknown");
      const type: AgentType = group.definition ? types[String(group.definition)] ?? "other" : "orchestrator";
      cost.totalUsd += usd;
      cost.byType[type] = (cost.byType[type] ?? 0) + usd;
      cost.outputByType[type] = (cost.outputByType[type] ?? 0) + Number(group.output ?? 0);
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
    const cost: CostBreakdown = { totalUsd: Number(workflow.spent?.usd ?? 0), byType: {}, outputByType: {}, byModel: {}, byClass: {}, responses: 0,
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
      execute: () => run(`${go}; go build ./... >/tmp/build.log 2>&1; code=$?; head -c 8000 /tmp/build.log; echo "go build exit: $code"; go vet ./... >/tmp/vet.log 2>&1; code=$?; head -c 4000 /tmp/vet.log; echo "go vet exit: $code"`) }),
    go_decode: tool({ description: "Build cmd/toml-decoder from /workspace/go and run it on the TOML given, answering its stdout, stderr and exit code: for checking the port on examples you write.",
      input: schema.Object({ toml: schema.String({ description: "TOML to decode" }) }, { additionalProperties: false }),
      execute: ({ toml }) => run(`${go}; if ! go build -o /tmp/decoder ./cmd/toml-decoder >/tmp/build.log 2>&1; then head -c 6000 /tmp/build.log; echo "go build failed"; exit 0; fi; printf '%s' "$TOML_INPUT" | /tmp/decoder; echo "decoder exit: $?"`, { TOML_INPUT: toml }) }),
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
    schema: 1, label: options.label, split: options.split, ...(options.guidance ? { guidance: options.guidance.name } : {}), task: task.id, taskVersion: task.version, tier: task.tier, mode: options.mode, workerClass: options.workerClass, classes: options.classes,
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
  const failures: RunFailure[] = [];
  const workflowIds = new Set<string>();
  const spendBefore = options.mode === "workflow" ? await runtime.tenantSpend() : undefined;
  const agent = await runtime.client.createAgent({
    // Dry mode's stand-in build tools; workflow mode has the real job().
    tools: options.mode === "dry" ? jobTools(runtime, task, volumeId, log, jobs) : {},
    name: `wf-eval ${task.id}`, model: options.classes.orchestrator, systemPrompt: (options.mode === "dry" && task.jobs?.length ? ORCHESTRATOR.replace("You cannot run commands.", "You cannot run commands except through the build tools you are given.") : ORCHESTRATOR) + (options.split === "required" ? SPLIT_REQUIRED : "") + (options.guidance ? `\n\n${options.guidance.text.trim()}` : ""), ttlSeconds: 86_400,
    mounts: [{ volumeId, path: "/workspace", mode: "rw" }], spendLimit: { usd: options.budgetUsd }, subagents: true,
    delegate: { agents: Object.entries(types.keys).map(([name, definition]) => ({ name, definition })), maxParallel: 8, maxDepth: 1 },
    onEvent(event: AgentEvent) {
      if (event.type === "tool_execution_start") { toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1; log({ call: event.toolName, args: JSON.stringify(event.args).slice(0, 4000) }); }
      else if (event.type === "tool_execution_end") {
        const text = JSON.stringify(event.result);
        log({ result: event.toolName, isError: event.isError, text: text.slice(0, 2000) });
        // workflow_start answers the id; from code mode it is inside codemode's result.
        if (event.toolName === "workflow_start" || (event.toolName === "codemode" && text.includes("wf_"))) for (const match of text.matchAll(/\bwf_[A-Za-z0-9_-]{6,}/g)) workflowIds.add(match[0]);
        if (event.isError && /fallback chain|exhausted|overloaded|rate limit|internal|timed out|5\d\d\b/i.test(text)) failures.push({ source: `tool ${event.toolName}`, message: text.slice(0, 500) });
      }
      else if (event.type === "subagent_start") { delegateCalls++; log({ subagentStart: event.agentId, name: event.name, depth: event.depth }); }
      else if (event.type === "subagent_end") { log({ subagentEnd: event.agentId, status: event.status, error: event.error }); if (event.status === "failed" && event.error) failures.push({ source: `sub-agent ${event.name ?? event.agentId}`, message: event.error }); }
      else if (event.type === "auto_retry_start") { log({ retry: event.attempt, error: event.errorMessage }); failures.push({ source: "model retry (orchestrator)", message: event.errorMessage, recovered: true }); }
      else if (event.type === "message_end" && event.message?.role === "assistant" && (event.message as { stopReason?: string }).stopReason === "error") failures.push({ source: "model (orchestrator)", message: String((event.message as { errorMessage?: string }).errorMessage ?? JSON.stringify(event.failure ?? "error")) });
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
    // Workflow mode: the agent is told which volume its /workspace is, which agent({ repo }) and job({ at }) take. Model-facing.
    const prompt = options.mode === "workflow" ? `${task.prompt}${task.workflowNote ? ` ${task.workflowNote}` : ""}\n\nYour /workspace is volume ${volumeId}.` : `${task.prompt}${task.dryNote ? ` ${task.dryNote}` : ""}`;
    const result = await agent.prompt(prompt, { timeoutMs: Math.max(60_000, deadline - Date.now()) });
    reply = result.reply;
    // toolCalls includes code mode's inner calls, which the event stream does not show as tool calls.
    const calls: { tool: string; innerCallId?: string }[] = result.toolCalls ?? [];
    delegateCalls = Math.max(delegateCalls, calls.filter(call => call.tool === "delegate").length);
    for (const call of calls) if (call.innerCallId) toolCalls[`codemode:${call.tool}`] = (toolCalls[`codemode:${call.tool}`] ?? 0) + 1;
    if (result.error) { runError = result.error; runStatus = result.stopped === "spend_limit" ? "budget" : "failed"; if (result.stopped !== "spend_limit") failures.push({ source: "orchestrator run", message: result.error }); }
    else if (result.stopped === "spend_limit") runStatus = "budget";
  } catch (error) {
    runError = (error as Error).message;
    runStatus = Date.now() >= deadline || /timed? ?out/i.test(runError) ? "timeout" : "failed";
    await agent.abort({ children: "abort" }).catch(() => {});
  } finally { clearInterval(watchdog); }
  if (stopped) runStatus = stopped;

  // workflow mode: what the agent started, run to its end, then the agent's own turns on the notifications.
  let workflowStats: ReturnType<Runtime["workflowStats"]> | undefined;
  let notified: Awaited<ReturnType<Runtime["notifications"]>> | undefined;
  if (options.mode === "workflow") {
    // The ids: workflow_start's answers, and the notifications' (a code mode script can start one and print nothing).
    await runtime.waitIdle(agent.id, Math.min(deadline, Date.now() + 120_000));
    for (const id of (await runtime.notifications(agent.id)).workflowIds) workflowIds.add(id);
    const seen = new Set<string>();
    for (let pass = 0; pass < 5 && [...workflowIds].some(id => !seen.has(id)); pass++) {
      for (const id of [...workflowIds].filter(id => !seen.has(id))) {
        seen.add(id);
        cleanups.push(() => runtime.abortWorkflow("public", id));
        const ended = await runtime.waitWorkflow("public", id, deadline);
        const items = await runtime.workflowItems("public", id);
        const stats = runtime.workflowStats(items, ended, types.ids);
        log({ workflow: ended });
        for (const item of items) if (["failed", "refused"].includes(item.status) && item.reason) failures.push({ source: `workflow ${item.kind}`, message: String(item.reason).slice(0, 500) });
        if (ended.fault || ended.error) failures.push({ source: "workflow", message: String(ended.fault?.message ?? ended.error).slice(0, 500) });
        workflowStats = workflowStats ? { ...stats, effects: { ...stats.effects, children: stats.effects.children + workflowStats.effects.children, effects: (stats.effects.effects ?? 0) + (workflowStats.effects.effects ?? 0), jobs: (stats.effects.jobs ?? 0) + (workflowStats.effects.jobs ?? 0), failedChildren: stats.effects.failedChildren + workflowStats.effects.failedChildren }, retries: workflowStats.retries + stats.retries, conflicts: workflowStats.conflicts + stats.conflicts, cost: mergeCost(workflowStats.cost, stats.cost) } : stats;
        if (ended.status === "budget_exhausted") runStatus = "budget"; else if (ended.stalled) runStatus = "timeout";
      }
      // The owner's turns on the notifications may start more.
      if (!await runtime.waitIdle(agent.id, Math.min(deadline, Date.now() + 600_000))) failures.push({ source: "harness", message: "the owner was still busy 10 minutes after its workflows ended" });
      for (const id of (await runtime.notifications(agent.id)).workflowIds) workflowIds.add(id);
    }
    notified = await runtime.notifications(agent.id);
    // Polls: workflow_status calls, direct or from code mode.
    notified.statusPolls = Math.max(notified.statusPolls, (toolCalls.workflow_status ?? 0) + (toolCalls["codemode:workflow_status"] ?? 0));
    for (const event of notified.events) if (!["completed", "phase", "paused"].includes(event)) failures.push({ source: "workflow notification", message: `event ${event}` });
  }

  const children = await runtime.children(agent.id);
  const own = await runtime.usage(agent.id, types.ids);
  // Workflow mode: the total is the tenant's spend across the run. Since #846 a workflow's children roll up into its
  // owner, as inline children with no definition, so by type: the owner's own usage (no rollup) is the orchestrator's,
  // the ledger's items give the workflow children's types, and what is left is delegate children (by definition).
  let cost = own;
  if (workflowStats) {
    const alone = await runtime.usage(agent.id, types.ids, false);
    const ledgerUsd = Object.values(workflowStats.cost.byType).reduce((sum, usd) => sum + (usd ?? 0), 0);
    const delegated: CostBreakdown["byType"] = {};
    for (const [type, usd] of Object.entries(own.byType) as [AgentType, number][]) if (type !== "orchestrator") delegated[type] = usd;
    const byType: CostBreakdown["byType"] = { orchestrator: alone.totalUsd };
    for (const source of [delegated, workflowStats.cost.byType]) for (const [type, usd] of Object.entries(source) as [AgentType, number][]) byType[type] = (byType[type] ?? 0) + usd;
    const merged = withTotal(mergeCost(own, workflowStats.cost), spendBefore!, await runtime.tenantSpend());
    cost = { ...merged, byType, outputByType: own.outputByType };
    log({ costSplit: { owner: alone.totalUsd, ledger: ledgerUsd, rollup: own.totalUsd, tenant: merged.totalUsd } });
  }
  return {
    ...base, agentId: agent.id, status: runStatus, error: runError, reply, wallMs: Date.now() - started, volumeId, cleanup,
    cost, effects: workflowStats ? { ...workflowStats.effects, children: workflowStats.effects.children + children.children, grandchildren: children.grandchildren, jobs: (workflowStats.effects.jobs ?? 0) + jobs.count } : { ...children, ...(jobs.count ? { jobs: jobs.count } : {}) },
    conflicts: children.conflicts + (workflowStats?.conflicts ?? 0), retries: workflowStats ? workflowStats.retries : null,
    choice: { delegated: children.children > 0 || delegateCalls > 0, delegateCalls: Math.max(delegateCalls, children.children), workflowStarted: workflowIds.size > 0 || !!toolCalls.workflow_start, workflowIds: [...workflowIds], toolCalls,
      ...(workflowStats ? { workflowAgents: workflowStats.effects.children, workflowJobs: workflowStats.effects.jobs ?? 0 } : {}),
      jobRuns: (toolCalls.job_run ?? 0) + (toolCalls["codemode:job_run"] ?? 0) },
    failures, ...(notified ? { notifications: notified } : {}),
  };
}

/** A cost breakdown whose total, tokens and model split are the tenant's spend across the run (by served model). */
function withTotal(cost: CostBreakdown, before: Awaited<ReturnType<Runtime["tenantSpend"]>>, after: Awaited<ReturnType<Runtime["tenantSpend"]>>): CostBreakdown {
  type Totals = { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; responses: number };
  const delta: Record<string, Totals> = Object.fromEntries(Object.entries(after).map(([model, now]): [string, Totals] => {
    const was = before[model] ?? { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, responses: 0 };
    return [model, { cost: now.cost - was.cost, input: now.input - was.input, output: now.output - was.output, cacheRead: now.cacheRead - was.cacheRead, cacheWrite: now.cacheWrite - was.cacheWrite, responses: now.responses - was.responses }];
  }).filter(([, value]) => value.cost > 1e-9));
  const sum = (key: keyof Totals) => Object.values(delta).reduce((total, value) => total + value[key], 0);
  const tokens = { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite") };
  const inputs = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const byModel = Object.fromEntries(Object.entries(delta).map(([model, value]) => [model, value.cost]));
  const byClass: CostBreakdown["byClass"] = {};
  for (const [model, usd] of Object.entries(byModel)) byClass[classOf(model)] = (byClass[classOf(model)] ?? 0) + usd;
  return { ...cost, totalUsd: sum("cost"), byModel, byClass, tokens, cacheShare: inputs ? +(tokens.cacheRead / inputs).toFixed(4) : 0, responses: sum("responses") };
}

/** The orchestrator's own usage (rollup) plus a workflow's ledger. If the runtime ever rolls workflow children up under their starting agent, this double counts: check against `GET /v1/usage` when PR 7 lands. */
function mergeCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
  const add = <K extends string>(x: Partial<Record<K, number>>, y: Partial<Record<K, number>>) => { const out = { ...x }; for (const [key, value] of Object.entries(y) as [K, number][]) out[key] = (out[key] ?? 0) + value; return out; };
  const tokens = { input: a.tokens.input + b.tokens.input, output: a.tokens.output + b.tokens.output, cacheRead: a.tokens.cacheRead + b.tokens.cacheRead, cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite };
  const inputs = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return { totalUsd: a.totalUsd + b.totalUsd, byType: add(a.byType, b.byType), outputByType: add(a.outputByType, b.outputByType), byModel: add(a.byModel, b.byModel) as Record<string, number>, byClass: add(a.byClass, b.byClass), tokens, cacheShare: inputs ? +(tokens.cacheRead / inputs).toFixed(4) : 0, responses: a.responses + b.responses };
}
