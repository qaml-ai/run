// The `workflows` builtin (docs/design/swarm-workflows.md, "An agent writes and steers one"): on for an agent with
// `delegate` settings, off with `workflows: false`. The agent that starts a workflow owns it (`owner = { kind:
// "agent", id }`) and is the only agent its tools reach. Its budget may not exceed the least of the agent's remaining
// spend limit and its `maxBudgetUsd` (default $100); above that a person starts it through the API.
//
// MODEL-FACING: every description and parameter description below is shown to the model.
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { agentOwner } from "../../../shared/owner.ts";
import { startInput, startWorkflow, ownWorkflow, WorkflowInputError, WORKFLOW_SCRIPT_CHARS, type WorkflowStub } from "./workflow-routes.ts";
import type { WorkflowEnv } from "./workflow-object.ts";
import { shortFault } from "./workflow-endings.ts";

/** The most a workflow an agent starts may spend, unless its configuration's `workflows.maxBudgetUsd` says otherwise. */
export const DEFAULT_MAX_BUDGET_USD = 100;
/** The longest one `workflow_status` call waits for a change. */
export const STATUS_WAIT_SECONDS = 120;
const SETTLED = new Set(["completed", "failed", "aborted", "paused", "budget_exhausted"]);

/**
 * The builtin's description. When to write a workflow is the wording the choice eval chose (evals/workflows, #847):
 * concrete triggers and "you plan, agents do the units" took should-split prompts from 1 of 6 to 6 of 6 with no false
 * splits. The job_run sentence is there only where the agent has job_run (agent-jobs.ts).
 */
export function workflowStartDescription(jobRun: boolean) {
  return "Start a workflow: a JavaScript script that runs sub-agents (agent(prompt, { key, type, class, output })), waits on them (parallel(items, fn)), and returns a result. " +
  "Write a workflow when a task covers more than about 10 files, tables, documents or sources, or is a port, migration, audit or research sweep: list its units, give each to its own agent(), and keep yourself to planning, checking and reporting. " +
  "When the units edit files, pass repo: your volume and commit() each fork. Do not do the units yourself. " +
  (jobRun ? "Run a single command with job_run, not a workflow. " : "") +
  "Use delegate for a few sub-agents whose answers you need in this turn. " +
  "A workflow outlives your turn: when it ends or stops for its budget you get a <workflow_notification> message, which only the runtime writes, so you need not poll it. You own it: you can edit its script and stop it. " +
  "Inside parallel(), give every agent() a key. Types: worker (does one task), critic (reviews another agent's work and reports problems; requires an `output` schema), lead (plans, judges, writes the final answer). The script reads `args`. " +
  "agent(prompt, { repo: volumeId }) gives the agent its own copy of that volume at /repo and answers { text, fork }; commit(result.fork) puts its edits on the volume, or answers { committed: false, conflicts } when the volume changed under them. " +
  "job({ command, timeoutSeconds, at: volumeId, outputs }) runs one shell command on a copy of the volume in a container of its own and answers its exit code and output. " +
  "gate({ question, options, recommended, reason, key }) asks a person in the inbox and waits for the answer (the chosen label, their own words, or null if declined); unanswered after expiresInSeconds (default 7 days), the workflow pauses, unless onExpire: \"recommended\" takes the recommended answer.";
}
/**
 * What a stopped or failed workflow's owner can do next, as workflow_status shows it (the notification says it too).
 * MODEL-FACING.
 */
export function workflowNext(view: { status?: string; fault?: unknown }): string | undefined {
  if (view.status === "budget_exhausted") return "Its budget is spent: raise it with workflow_budget.";
  if (view.fault) return "To change it, abort it and start a new workflow: finished results are reused.";
  return undefined;
}
/** The description where the agent has no job_run. */
export const WORKFLOW_START_DESCRIPTION = workflowStartDescription(false);

export interface WorkflowToolsHost {
  env: WorkflowEnv;
  tenant: string;
  agentId: string;
  bucket?: string;
  /** The agent's runtime origin: its workflows' children are configured with it. */
  runtimeOrigin?: string;
  /** What the agent may still spend (USD), Infinity without a spend limit. */
  remaining(): Promise<number>;
  maxBudgetUsd?: number;
  /** The agent also has job_run: workflow_start says to use it for a single command. */
  jobRun?: boolean;
  /**
   * The agent's children table (delegation.ts): a workflow it starts is a background child of its, whose endings come
   * as a child's. `register` writes its row before the workflow is made; `reopen` opens its next attempt once it goes
   * on after a budget or payer stop; `forget` ends a row whose workflow was refused.
   */
  children?: {
    register(workflow: { id: string; name: string; callId: string }, api: unknown): Promise<unknown>;
    reopen(workflowId: string): Promise<unknown>;
    forget(workflowId: string): Promise<unknown>;
  };
}

const text = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], structuredOutput: value as never });
const id = { type: "string", description: "The workflow's id (wf_...), as workflow_start returned it" } as const;

export function workflowTools(host: WorkflowToolsHost): ToolRegistration[] {
  /** One of this agent's own workflows, or a refusal: another agent's or tenant's is not found. */
  const own = async (workflowId: unknown): Promise<WorkflowStub> => {
    if (typeof workflowId !== "string") throw new WorkflowInputError("workflowId is the id workflow_start returned");
    const stub = await ownWorkflow(host.env, host.tenant, workflowId);
    const owner = stub ? (await stub.view()).owner as { kind?: string; id?: string } | undefined : undefined;
    if (!stub || owner?.kind !== "agent" || owner.id !== host.agentId) throw new WorkflowInputError(`You have no workflow ${workflowId}`);
    return stub;
  };
  const brief = (workflowId: string, view: Record<string, any>) => ({
    workflowId, status: view.status, ...(view.pauseReason ? { pauseReason: view.pauseReason } : {}), phase: view.phase, revision: view.revision,
    counts: view.counts, spent: view.spent?.usd, budget: view.budget?.usd, ...(view.result !== undefined ? { result: view.result } : {}), ...(view.error ? { error: view.error } : {}),
    ...(view.fault ? { fault: shortFault(view.fault) } : {}), ...(workflowNext(view) ? { next: workflowNext(view) } : {}),
  });
  /** After workflow_budget or workflow_resume: a workflow going on after a stop is running again in the owner's list. */
  const reopened = async (workflowId: string, view: Record<string, any>) => {
    if (view.status === "running" || view.status === "waiting") await host.children?.reopen(workflowId);
    return view;
  };
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: Record<string, any>, callId: string, api: unknown) => Promise<unknown>) =>
    defineTool({ name, description, parameters: { type: "object", properties, required, additionalProperties: false } as never, structuredOutputSchema: {}, replay: "safe",
      execute: async (args: Record<string, unknown>, api) => text(await run(args, api.callId, api)) });

  return [
    tool("workflow_start", workflowStartDescription(!!host.jobRun), {
      script: { type: "string", description: `The workflow's JavaScript: its body runs as an async function (await and return at the top level), at most ${WORKFLOW_SCRIPT_CHARS} characters` },
      args: { description: "JSON the script reads as `args`" },
      budgetUsd: { type: "number", description: "The most the workflow may spend in USD; it pauses when that is spent" },
      name: { type: "string", description: "A short name for it" },
      concurrency: { type: "integer", description: "Sub-agents at once, 1 to 64 (default 8)" },
      classes: { type: "object", description: "Pin a type's model class for the whole workflow, e.g. { \"worker\": \"strong\" }" },
    }, ["script", "budgetUsd"], async (args, callId, api) => {
      const cap = Math.min(host.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD, await host.remaining());
      if (typeof args.budgetUsd === "number" && args.budgetUsd > cap) throw new WorkflowInputError(`A budget above $${cap.toFixed(2)} is more than you may give a workflow: ask the person you work for to start it, or use a smaller budget`);
      const input = startInput({ script: args.script, budget: { usd: args.budgetUsd }, ...(args.args !== undefined ? { args: args.args } : {}), ...(args.name !== undefined ? { name: args.name } : {}), ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}), ...(args.classes !== undefined ? { classes: args.classes } : {}) });
      // Keyed by the call: a replay of this call (after a restart) finds the same workflow.
      let registered: string | undefined;
      const beforeCreate = host.children ? async (workflowId: string) => {
        registered = workflowId;
        await host.children!.register({ id: workflowId, name: typeof args.name === "string" && args.name ? args.name : workflowId, callId }, api);
      } : undefined;
      let started;
      try {
        started = await startWorkflow(host.env, host.tenant, input, { owner: agentOwner(host.agentId), ...(host.bucket ? { bucket: host.bucket } : {}), ...(host.runtimeOrigin ? { runtimeOrigin: host.runtimeOrigin } : {}), idempotencyKey: `agent:${host.agentId}:${callId}`, ...(beforeCreate ? { beforeCreate } : {}) });
      } catch (error) {
        // No workflow was made (refused, or its start failed before it existed): its row ends now. One that cannot be
        // looked up stays running; interrupt_agent ends it once the workflow is known not to exist.
        if (registered) {
          const made = await ownWorkflow(host.env, host.tenant, registered).then(stub => !!stub, () => undefined);
          if (made === false) await host.children!.forget(registered).catch(() => {});
        }
        throw error;
      }
      return brief(started.id, started);
    }),
    tool("workflow_status", "A workflow's status, counts, spend and, once it ends, its result. With waitSeconds, waits until it ends, pauses or that time passes. You need not call this to wait: a <workflow_notification> tells you when a workflow finishes or stops, so end your turn instead.", {
      workflowId: id, waitSeconds: { type: "integer", description: `Wait up to this long (at most ${STATUS_WAIT_SECONDS}) for it to end or pause` },
    }, ["workflowId"], async args => {
      const stub = await own(args.workflowId);
      const deadline = Date.now() + Math.min(STATUS_WAIT_SECONDS, Math.max(0, Number(args.waitSeconds ?? 0))) * 1000;
      let view = await stub.view() as Record<string, any>;
      while (!SETTLED.has(view.status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        view = await stub.view() as Record<string, any>;
      }
      return brief(args.workflowId, view);
    }),
    tool("workflow_items", "A workflow's effects (its agents, gates, timers, jobs, commits and pushes): their keys, status and results, to read samples or find failures.", {
      workflowId: id, status: { type: "string", description: "Only effects in this status (pending, done, failed, refused)" }, limit: { type: "integer", description: "At most this many (default 50)" },
    }, ["workflowId"], async args => (await own(args.workflowId)).items({ ...(args.status ? { status: args.status } : {}), limit: Math.min(200, Number(args.limit ?? 50)) })),
    tool("workflow_edit", "Replace a workflow's script. Effects whose keys and arguments are unchanged keep their results; new or changed ones run. reason is required and kept with the revision.", {
      workflowId: id, script: { type: "string", description: "The new script" }, reason: { type: "string", description: "Why it changed" },
      confirm: { type: "boolean", description: "true to go ahead when the edit reruns many finished effects" },
    }, ["workflowId", "script", "reason"], async args => {
      const stub = await own(args.workflowId);
      if (typeof args.script !== "string" || !args.script.trim() || args.script.length > WORKFLOW_SCRIPT_CHARS) throw new WorkflowInputError("script is the new JavaScript");
      if (typeof args.reason !== "string" || !args.reason.trim()) throw new WorkflowInputError("reason says why the script changed");
      const edited = await stub.edit({ code: args.script, reason: args.reason, ...(args.confirm === true ? { confirm: true } : {}) });
      return { ...brief(args.workflowId, await stub.view() as Record<string, any>), revision: edited.revision };
    }),
    tool("workflow_pause", "Pause a workflow: nothing new starts. With stopChildren, its running sub-agents stop too.", {
      workflowId: id, stopChildren: { type: "boolean", description: "Stop its running sub-agents now" },
    }, ["workflowId"], async args => { const stub = await own(args.workflowId); await stub.pause(args.stopChildren ? { children: "abort" } : {}); return brief(args.workflowId, await stub.view() as Record<string, any>); }),
    tool("workflow_resume", "Resume a paused workflow. rerun names effect keys to run again.", {
      workflowId: id, rerun: { type: "array", items: { type: "string" }, description: "Effect keys to run again" },
    }, ["workflowId"], async args => { const stub = await own(args.workflowId); await stub.resume(Array.isArray(args.rerun) ? { rerun: args.rerun } : {}); return brief(args.workflowId, await reopened(args.workflowId, await stub.view() as Record<string, any>)); }),
    tool("workflow_abort", "Stop a workflow for good: its running sub-agents stop and nothing new starts.", { workflowId: id }, ["workflowId"],
      async args => { const stub = await own(args.workflowId); await stub.abort(); return brief(args.workflowId, await stub.view() as Record<string, any>); }),
    tool("workflow_budget", "Change a workflow's budget (USD). A workflow stopped for its budget runs again by itself once the new budget is above what it has spent.", {
      workflowId: id, usd: { type: "number", description: "Its new budget in USD" },
    }, ["workflowId", "usd"], async args => {
      const stub = await own(args.workflowId);
      const cap = Math.min(host.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD, await host.remaining());
      if (typeof args.usd !== "number" || !Number.isFinite(args.usd) || args.usd <= 0) throw new WorkflowInputError("usd is a positive number of USD");
      if (args.usd > cap) throw new WorkflowInputError(`A budget above $${cap.toFixed(2)} is more than you may give a workflow: ask the person you work for`);
      await stub.setBudget(args.usd);
      return brief(args.workflowId, await reopened(args.workflowId, await stub.view() as Record<string, any>));
    }),
  ];
}
