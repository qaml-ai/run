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

/** The most a workflow an agent starts may spend, unless its configuration's `workflows.maxBudgetUsd` says otherwise. */
export const DEFAULT_MAX_BUDGET_USD = 100;
/** The longest one `workflow_status` call waits for a change. */
export const STATUS_WAIT_SECONDS = 120;
const SETTLED = new Set(["completed", "failed", "aborted", "paused", "budget_exhausted"]);

/** The builtin's description of when to write a workflow (the design's agreed text). */
export const WORKFLOW_START_DESCRIPTION =
  "Start a workflow: a JavaScript script that runs sub-agents (agent(prompt, { key, type, class, output })), waits on them (parallel(items, fn)), and returns a result. " +
  "Write a workflow when a task is many independent or repeated units of work (per file, per table, per source), needs more than a few sub-agents at once, must keep running after your turn ends, or needs a person's approval or a budget along the way; use `delegate` for a few sub-agents whose answers you need in this turn. " +
  "A workflow outlives your turn and reports back as it goes; you own it: you can edit its script, answer its gates and stop it. " +
  "Inside parallel(), give every agent() a key. Types: worker (does one task), critic (finds problems; needs output), lead (plans, judges, writes the final answer). The script reads `args`. " +
  "agent(prompt, { repo: volumeId }) gives the agent its own copy of that volume at /repo and answers { text, fork }; commit(result.fork) puts its edits on the volume, or answers { committed: false, conflicts } when the volume changed under them. " +
  "job({ command, timeoutSeconds, at: volumeId, outputs }) runs one shell command on a copy of the volume in a container of its own and answers its exit code and output.";

export interface WorkflowToolsHost {
  env: WorkflowEnv;
  tenant: string;
  agentId: string;
  bucket?: string;
  /** What the agent may still spend (USD), Infinity without a spend limit. */
  remaining(): Promise<number>;
  maxBudgetUsd?: number;
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
  });
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: Record<string, any>, callId: string) => Promise<unknown>) =>
    defineTool({ name, description, parameters: { type: "object", properties, required, additionalProperties: false } as never, structuredOutputSchema: {}, replay: "safe",
      execute: async (args: Record<string, unknown>, api) => text(await run(args, api.callId)) });

  return [
    tool("workflow_start", WORKFLOW_START_DESCRIPTION, {
      script: { type: "string", description: `The workflow's JavaScript: its body runs as an async function (await and return at the top level), at most ${WORKFLOW_SCRIPT_CHARS} characters` },
      args: { description: "JSON the script reads as `args`" },
      budgetUsd: { type: "number", description: "The most the workflow may spend in USD; it pauses when that is spent" },
      name: { type: "string", description: "A short name for it" },
      concurrency: { type: "integer", description: "Sub-agents at once, 1 to 64 (default 8)" },
      classes: { type: "object", description: "Pin a type's model class for the whole workflow, e.g. { \"worker\": \"strong\" }" },
    }, ["script", "budgetUsd"], async (args, callId) => {
      const cap = Math.min(host.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD, await host.remaining());
      if (typeof args.budgetUsd === "number" && args.budgetUsd > cap) throw new WorkflowInputError(`A budget above $${cap.toFixed(2)} is more than you may give a workflow: ask the person you work for to start it, or use a smaller budget`);
      const input = startInput({ script: args.script, budget: { usd: args.budgetUsd }, ...(args.args !== undefined ? { args: args.args } : {}), ...(args.name !== undefined ? { name: args.name } : {}), ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}), ...(args.classes !== undefined ? { classes: args.classes } : {}) });
      // Keyed by the call: a replay of this call (after a restart) finds the same workflow.
      const started = await startWorkflow(host.env, host.tenant, input, { owner: agentOwner(host.agentId), ...(host.bucket ? { bucket: host.bucket } : {}), idempotencyKey: `agent:${host.agentId}:${callId}` });
      return brief(started.id, started);
    }),
    tool("workflow_status", "A workflow's status, counts, spend and, once it ends, its result. With waitSeconds, waits until it ends, pauses or that time passes.", {
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
    tool("workflow_items", "A workflow's effects (its agents, gates and timers): their keys, status and results, to read samples or find failures.", {
      workflowId: id, status: { type: "string", description: "Only effects in this status (pending, done, failed, refused)" }, limit: { type: "integer", description: "At most this many (default 50)" },
    }, ["workflowId"], async args => (await own(args.workflowId)).items({ ...(args.status ? { status: args.status } : {}), limit: Math.min(200, Number(args.limit ?? 50)) })),
    tool("workflow_edit", "Replace a workflow's script. Effects whose keys and arguments are unchanged keep their results; new or changed ones run. reason is required and kept with the revision.", {
      workflowId: id, script: { type: "string", description: "The new script" }, reason: { type: "string", description: "Why it changed" },
      confirm: { type: "boolean", description: "true to go ahead when the edit reruns many finished effects" },
    }, ["workflowId", "script", "reason"], async args => {
      const stub = await own(args.workflowId);
      if (typeof args.script !== "string" || !args.script.trim() || args.script.length > WORKFLOW_SCRIPT_CHARS) throw new WorkflowInputError("script is the new JavaScript");
      if (typeof args.reason !== "string" || !args.reason.trim()) throw new WorkflowInputError("reason says why the script changed");
      const edited = await stub.edit({ code: args.script, reason: args.reason, ...(args.confirm ? { rerunConfirmPercent: 100 } : {}) });
      return { ...brief(args.workflowId, await stub.view() as Record<string, any>), revision: edited.revision };
    }),
    tool("workflow_pause", "Pause a workflow: nothing new starts. With stopChildren, its running sub-agents stop too.", {
      workflowId: id, stopChildren: { type: "boolean", description: "Stop its running sub-agents now" },
    }, ["workflowId"], async args => { const stub = await own(args.workflowId); await stub.pause(args.stopChildren ? { children: "abort" } : {}); return brief(args.workflowId, await stub.view() as Record<string, any>); }),
    tool("workflow_resume", "Resume a paused workflow. rerun names effect keys to run again.", {
      workflowId: id, rerun: { type: "array", items: { type: "string" }, description: "Effect keys to run again" },
    }, ["workflowId"], async args => { const stub = await own(args.workflowId); await stub.resume(Array.isArray(args.rerun) ? { rerun: args.rerun } : {}); return brief(args.workflowId, await stub.view() as Record<string, any>); }),
    tool("workflow_abort", "Stop a workflow for good: its running sub-agents stop and nothing new starts.", { workflowId: id }, ["workflowId"],
      async args => { const stub = await own(args.workflowId); await stub.abort(); return brief(args.workflowId, await stub.view() as Record<string, any>); }),
    tool("workflow_budget", "Change a workflow's budget (USD). A workflow paused for its budget resumes with workflow_resume.", {
      workflowId: id, usd: { type: "number", description: "Its new budget in USD" },
    }, ["workflowId", "usd"], async args => {
      const stub = await own(args.workflowId);
      const cap = Math.min(host.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD, await host.remaining());
      if (typeof args.usd !== "number" || !Number.isFinite(args.usd) || args.usd <= 0) throw new WorkflowInputError("usd is a positive number of USD");
      if (args.usd > cap) throw new WorkflowInputError(`A budget above $${cap.toFixed(2)} is more than you may give a workflow: ask the person you work for`);
      await stub.setBudget(args.usd);
      return brief(args.workflowId, await stub.view() as Record<string, any>);
    }),
  ];
}
