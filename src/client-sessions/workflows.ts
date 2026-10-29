import { createHash } from "node:crypto";
import { jsonResult, type ToolCall, type ToolServer, type ToolSourceView } from "../tool-servers.ts";
import type { Sources } from "../tool-sources.ts";
import type { McpResult } from "../mcp-results.ts";
import { errorText } from "../protocol.ts";
import type { DelegateSettings } from "../multi-agent.ts";
import { runWorkflowScript, WORKFLOW_LIMITS, workflowTool, type ScriptAgentRequest, type ScriptAgentOutcome, type WorkflowSettings } from "../workflows.ts";
import type { ChildrenContext } from "./children.ts";
import * as delegation from "./delegation.ts";
import { runningRun, type Session } from "./state.ts";

/**
 * The workflow tool of an agent whose sources enable it (workflows.ts), answered here rather than by a tool source: a
 * workflow's `agent()` call is a delegate call of its own — the same child, keys, budget, spend and cancellation — and the
 * script's value is what the tool answers. The script runs in the sandbox (`executeCode({ workflow: true })`).
 */
export function workflowServer(ctx: ChildrenContext, session: Session, sources: Sources | undefined): ToolServer | undefined {
  const settings = sources?.builtins?.includes("workflow") ? sources.workflow : undefined;
  if (!settings) return undefined;
  const delegate = delegationSettings(settings);
  const tools = async () => [workflowTool(settings, await delegation.targetDescriptions(ctx, session.header.tenant, delegate.agents ?? []))];
  return {
    tools,
    sources: async () => (await tools()).map((tool): ToolSourceView => ({ kind: "builtin", name: tool.name, status: "listed", tools: [tool] })),
    call: async call => {
      if (call.name === "run_workflow") return runWorkflow(ctx, session, settings, delegate, call);
      throw new Error(`Unknown tool ${call.name}`);
    },
  };
}

/** What a workflow's children are: delegate settings, as its own give them. */
function delegationSettings(settings: WorkflowSettings): DelegateSettings {
  return {
    ...(settings.agents !== undefined ? { agents: settings.agents } : {}), ...(settings.instructions !== undefined ? { instructions: settings.instructions } : {}),
    ...(settings.maxDepth !== undefined ? { maxDepth: settings.maxDepth } : {}), ...(settings.maxParallel !== undefined ? { maxParallel: settings.maxParallel } : {}),
  };
}

/**
 * A run_workflow call: the script runs in the sandbox, and each `agent()` it makes is a delegate call, so its child is an
 * ordinary child of this run (linked, budgeted, cancelled with it). The script's return value is the call's result; the
 * agents' own text stays in the script.
 */
async function runWorkflow(ctx: ChildrenContext, session: Session, settings: WorkflowSettings, delegate: DelegateSettings, call: ToolCall): Promise<McpResult> {
  const { header } = session;
  const tenant = header.tenant;
  const run = runningRun(session);
  if (!run || !call.toolCallId || call.innerCallId || !call.idempotencyKey) throw new Error("run_workflow is called directly, not from js_exec");
  if (!ctx.options.createAgent || !ctx.options.submit) throw new Error("Workflows are not enabled on this runtime");
  const { script, args } = call.args as { script?: unknown; args?: unknown };
  if (typeof script !== "string" || !script.trim()) throw new Error("Give the workflow script");
  if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) throw new Error("A workflow's args are an object");
  // Where this run is in its chain: a workflow's children are one step further, and may not go past the chain's depth.
  const place = delegation.childPlace(ctx, session, run, delegate, "Workflows");
  const toolCallId = call.toolCallId;
  const budget = Math.min(settings.maxAgents ?? WORKFLOW_LIMITS.agents, WORKFLOW_LIMITS.agentsCeiling);
  const at = { toolCallId };
  const children: { index: number; label?: string; agent?: string; phase?: string; status: "completed" | "failed"; error?: string; agentId?: string; requestId?: string }[] = [];
  const calls = { count: 0 };
  // What each ask has come up to so far, for this call: children are numbered by what they were asked, never by arrival
  // order, and a replay on this node starts from zero again, so it finds the children the first attempt made.
  const asked = new Map<string, number>();
  // Children still in flight when the script stops (its end, an early return, a failure, its deadline) are stopped with it.
  const stopping = new AbortController();
  const signal = AbortSignal.any([call.signal, stopping.signal]);
  ctx.publish(session, { type: "event", requestId: run.id, event: { type: "workflow_start", ...at } });

  const agentCall = async (request: ScriptAgentRequest): Promise<ScriptAgentOutcome> => {
    // A child is named by what it was asked and how many times that ask came up, never by arrival order: a script
    // replayed after its node was lost finds the same child for the same call, whichever call reached the host first.
    const digest = createHash("sha256").update(JSON.stringify({ prompt: request.prompt, agent: request.agent ?? null, instructions: request.instructions ?? null, schema: request.schema ?? null })).digest("hex").slice(0, 16);
    const occurrence = asked.get(digest) ?? 0;
    asked.set(digest, occurrence + 1);
    const index = calls.count++;
    const synthetic: ToolCall = {
      name: "delegate", toolCallId, idempotencyKey: `${call.idempotencyKey}-${digest}-${occurrence}`, signal,
      args: {
        ...(request.agent !== undefined ? { agent: request.agent } : {}), ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
        task: request.prompt, ...(request.schema !== undefined ? { output: request.schema } : {}),
      },
    };
    let outcome: ScriptAgentOutcome;
    try {
      const result = await delegation.delegate(ctx, session, delegate, synthetic);
      // `delegate` records its child under the tool call id; a workflow makes many under one call, and the last must not
      // stand for the call in the run's outcome.
      session.children?.delete(toolCallId);
      const value = (result.structuredContent ?? {}) as { agentId?: string; requestId?: string; status?: string; text?: string; output?: unknown; error?: string };
      const completed = value.status === "completed";
      outcome = completed
        ? { value: value.output !== undefined ? value.output : (value.text ?? null), ...(value.agentId ? { agentId: value.agentId } : {}), ...(value.requestId ? { requestId: value.requestId } : {}) }
        : { failed: true, error: value.error ?? `the agent did not complete (${value.status ?? "failed"})` };
      children.push({ index, ...(request.label !== undefined ? { label: request.label } : {}), ...(request.agent !== undefined ? { agent: request.agent } : {}), ...(request.phase !== undefined ? { phase: request.phase } : {}),
        status: completed ? "completed" : "failed", ...(value.error ? { error: value.error } : {}), ...(value.agentId ? { agentId: value.agentId } : {}), ...(value.requestId ? { requestId: value.requestId } : {}) });
    } catch (error) {
      session.children?.delete(toolCallId);
      // Whatever kept the call from starting (a busy-agent cap, a chain limit): the script sees null, and the caller's
      // list still says the call was made and why it failed.
      outcome = { failed: true, error: errorText(error) };
      children.push({ index, ...(request.label !== undefined ? { label: request.label } : {}), ...(request.agent !== undefined ? { agent: request.agent } : {}), status: "failed", error: errorText(error) });
    }
    return outcome;
  };

  let outcome;
  try {
    outcome = await runWorkflowScript({
      script, args, signal, tenant, waitForSlot: place.depth === 1,
      // The clock a replay sees, and the dice it rolls, are this run's: its request's start and its call's id.
      frozenNow: run.startedAt, seed: call.idempotencyKey,
      maxAgents: budget, items: WORKFLOW_LIMITS.items, timeMs: WORKFLOW_LIMITS.timeMs,
      parallel: Math.min(settings.maxParallel ?? WORKFLOW_LIMITS.maxParallel, WORKFLOW_LIMITS.parallelCeiling),
      onPhase: title => ctx.publish(session, { type: "event", requestId: run.id, event: { type: "workflow_progress", ...at, phase: title } }),
      onLog: message => ctx.publish(session, { type: "event", requestId: run.id, event: { type: "workflow_progress", ...at, log: message } }),
      callAgent: agentCall,
    });
  } finally {
    // Stop waiting in this attempt. Host cancellation also means a drain or lost ownership: leave those children
    // for the next owner to collect. An explicit user abort already stops them through ClientSessions.stop.
    // Only a script that ends here (return, error or deadline) owns cleanup of the children it left running.
    stopping.abort();
    if (!call.signal.aborted) await delegation.stopDelegates(ctx, session, { run: run.id, toolCallId });
  }

  const status = outcome.status;
  ctx.publish(session, { type: "event", requestId: run.id, event: { type: "workflow_end", ...at, status, ...(outcome.error ? { error: outcome.error } : {}), agents: outcome.agents } });
  const value = { status, agents: [...children].sort((a, b) => a.index - b.index), ...(outcome.value !== undefined ? { value: outcome.value } : {}), ...(outcome.error ? { error: outcome.error } : {}) };
  return { ...jsonResult(value), ...(status === "completed" ? {} : { isError: true }) };
}
