import { createHash } from "node:crypto";
import { HttpError } from "./http.ts";
import type { ToolDefinition } from "./protocol.ts";

/**
 * Sub-agents: the `delegate` built-in, answered by the runtime's sessions (client-sessions.ts) rather than a tool source,
 * starts a child agent on a task and returns its answer. The `agents` built-in starts children in the background instead
 * (spawn_agent, wait_agent, list_agents): each one's ending reaches its parent as a notification. Both need an allowlist
 * of targets (`delegate`), beside `builtins` on an agent or a definition.
 */
export const MULTI_AGENT_LIMITS = Object.freeze({
  /** How deep delegation goes by default (a child's child is depth 2), and the most a setting may allow. */
  maxDepth: 2, depthCeiling: 5,
  /** Delegate calls of one run in flight at once by default (more wait their turn), and the most a setting may allow. */
  maxParallel: 4, parallelCeiling: 16,
  /** Targets in one allowlist. */
  targets: 32,
  /** How long a child the runtime makes lives: a scratch agent's day. */
  childTtlSeconds: 86_400,
  /** A task's and inline instructions' length. */
  taskChars: 100_000, instructionsChars: 32_000, descriptionChars: 1_000,
  /** How long wait_agent waits by default, and at most. */
  waitMs: 5 * 60_000, maxWaitMs: 10 * 60_000,
  /** How often nodes sweep for children whose ending was not delivered (AGENT_CHILD_SWEEP_MS). */
  sweepMs: 15_000,
  /** Turns notifications (and agent messages) may start per chain root and hour (AGENT_WAKES_PER_HOUR). */
  wakesPerHour: 100,
  /** send_message calls of one run (the next PR's builtin). */
  messagesPerRun: 20,
  /** The most of a child's answer its notification carries. */
  noticeChars: 100_000,
});

/** A delegate target: a definition (by id or key) or an existing agent (by key), named for the model. */
export type AgentTarget = { name: string; definition?: string; agent?: string; description?: string };
export interface DelegateSettings {
  /** Agents the model may start (a definition: a new child each call) or message (an agent: its own history). */
  agents?: AgentTarget[];
  /** Whether the model may start a child with instructions of its own instead (its model is the parent's). */
  instructions?: boolean;
  maxDepth?: number;
  maxParallel?: number;
}

/** Stream events of an agent's children, sent only to subscribers that ask for them (`?subagents=1`). */
export const SUBAGENT_EVENTS: readonly string[] = ["subagent_start", "subagent_event", "subagent_end"];
/**
 * What a child's run carries in its prompt's metadata: who started it, and where it is in the chain. Where it is counts
 * only with `signature`, the runtime's MAC over it for that agent and run (ClientSessions' `delegation`): a caller's
 * prompt may carry the same keys, and its run starts a chain of its own.
 */
export const PARENT_KEYS = { agent: "parentAgentId", run: "parentRunId", toolCall: "parentToolCallId", depth: "delegationDepth", maxDepth: "delegationMaxDepth", chain: "delegationChain", signature: "delegationSignature" } as const;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** A definition id, or a definition's or agent's key. */
const KEY = /^[A-Za-z0-9_-]{1,80}$/;
const integer = (value: unknown, field: string, min: number, max: number) => {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < min || (value as number) > max)) throw new HttpError(400, `${field} is an integer from ${min} to ${max}`);
  return value as number | undefined;
};

/** One allowlist: definition keys or ids as strings, or `{ name?, definition | agent, description? }`. */
function targetsInput(value: unknown, field: string): AgentTarget[] {
  const shape = `${field} is a list of definition keys or ids, or { name?, definition | agent, description? }`;
  if (!Array.isArray(value) || value.length > MULTI_AGENT_LIMITS.targets) throw new HttpError(400, `${shape}, at most ${MULTI_AGENT_LIMITS.targets}`);
  const targets = value.map((entry): AgentTarget => {
    const given = typeof entry === "string" ? { definition: entry } : entry;
    if (!given || typeof given !== "object" || Array.isArray(given)) throw new HttpError(400, shape);
    const { name, definition, agent, description, ...rest } = given as Record<string, unknown>;
    const ref = definition ?? agent;
    if (Object.keys(rest).length || (definition !== undefined) === (agent !== undefined) || typeof ref !== "string" || !KEY.test(ref)) throw new HttpError(400, shape);
    const shown = name ?? ref;
    if (typeof shown !== "string" || !NAME.test(shown)) throw new HttpError(400, `${field}: a name is 1 to 64 letters, digits, _ and -`);
    if (description !== undefined && (typeof description !== "string" || !description.trim() || description.length > MULTI_AGENT_LIMITS.descriptionChars)) throw new HttpError(400, `${field}: a description is 1 to ${MULTI_AGENT_LIMITS.descriptionChars} characters`);
    return { name: shown, ...(definition !== undefined ? { definition: definition as string } : { agent: agent as string }), ...(description !== undefined ? { description: (description as string).trim() } : {}) };
  });
  const names = targets.map(target => target.name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw new HttpError(400, `${field} names ${twice} twice`);
  return targets;
}

/** `delegate` as an agent or a definition gives it. */
export function delegateInput(value: unknown): DelegateSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "delegate is { agents?, instructions?, maxDepth?, maxParallel? }");
  const { agents, instructions, maxDepth, maxParallel, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) throw new HttpError(400, `Unknown delegate field: ${Object.keys(rest)[0]}`);
  if (instructions !== undefined && typeof instructions !== "boolean") throw new HttpError(400, "delegate.instructions is true or false");
  const settings: DelegateSettings = {
    ...(agents !== undefined ? { agents: targetsInput(agents, "delegate.agents") } : {}), ...(instructions !== undefined ? { instructions } : {}),
    ...(maxDepth !== undefined ? { maxDepth: integer(maxDepth, "delegate.maxDepth", 1, MULTI_AGENT_LIMITS.depthCeiling) } : {}),
    ...(maxParallel !== undefined ? { maxParallel: integer(maxParallel, "delegate.maxParallel", 1, MULTI_AGENT_LIMITS.parallelCeiling) } : {}),
  };
  if (!settings.agents?.length && !settings.instructions) throw new HttpError(400, "delegate needs agents to delegate to, or instructions: true");
  return settings;
}

/** The builtins that start children, which `delegate` settings go with. */
export const MULTI_AGENT_BUILTINS = ["delegate", "agents"] as const;
export const startsChildren = (builtins: readonly string[] | undefined) => !!builtins?.some(name => (MULTI_AGENT_BUILTINS as readonly string[]).includes(name));

/**
 * Check `delegate` against `builtins`: the settings go with the delegate or agents builtin, and each needs them (whom
 * its children may be, how deep and how many at once). Undefined: none given.
 */
export function delegateSettings(builtins: readonly string[] | undefined, value: unknown): DelegateSettings | undefined {
  const delegate = value === undefined || value === null ? undefined : delegateInput(value);
  if (delegate && !startsChildren(builtins)) throw new HttpError(400, `delegate settings need the delegate or agents builtin: add "delegate" or "agents" to builtins`);
  const builtin = builtins?.find(name => (MULTI_AGENT_BUILTINS as readonly string[]).includes(name));
  if (!delegate && builtin) throw new HttpError(400, `The ${builtin} builtin needs delegate: { agents } (or instructions: true): which agents it may start`);
  return delegate;
}

/** A definition's id from a target's reference: an id as given, a key as the definition upsert by that key made it. */
export function definitionId(tenant: string, ref: string) {
  return /^def_[a-f0-9]{20}$/.test(ref) ? ref : `def_${createHash("sha256").update(`${tenant}:${ref}`).digest("hex").slice(0, 20)}`;
}

const listed = (targets: AgentTarget[], describe: (target: AgentTarget) => string | undefined) =>
  targets.map(target => `- ${target.name}${(target.description ?? describe(target)) ? `: ${target.description ?? describe(target)}` : ""}`).join("\n");

const targetProperties = (settings: DelegateSettings, what: string) => {
  const agents = settings.agents ?? [];
  return {
    ...(agents.length ? { agent: { type: "string", enum: agents.map(target => target.name), description: `Which agent to ${what}` } } : {}),
    ...(settings.instructions ? { instructions: { type: "string", minLength: 1, maxLength: MULTI_AGENT_LIMITS.instructionsChars, description: `A system prompt for a new sub-agent${agents.length ? ", instead of naming an agent" : ""}: who it is and how it should work` } } : {}),
    task: { type: "string", minLength: 1, maxLength: MULTI_AGENT_LIMITS.taskChars, description: "The task, with everything the sub-agent needs to know: it sees none of this conversation" },
    output: { type: "object", description: "A JSON Schema for an object, if you want the answer in that shape (type: \"object\")" },
  };
};

/** The delegate tool as the model sees it: its targets by name, with what each is for (`describe`: a definition's own description). */
export function delegateTool(settings: DelegateSettings, describe: (target: AgentTarget) => string | undefined): ToolDefinition {
  const agents = settings.agents ?? [];
  const properties = targetProperties(settings, "delegate to");
  return {
    name: "delegate", exposure: "direct", executionMode: "parallel",
    description: [
      "Hand a task to a sub-agent and wait for its answer: its final text, or with `output`, an object in that schema. The sub-agent works on its own (its own tools and history), sees only the task you give it, and its answer comes back as this call's result. Call delegate several times in one response to run tasks in parallel.",
      agents.length ? `Agents you can delegate to:\n${listed(agents, describe)}` : "",
      settings.instructions ? `${agents.length ? "Or give" : "Give"} instructions to start a sub-agent of your own design, with your model.` : "",
    ].filter(Boolean).join("\n\n"),
    parameters: { type: "object", additionalProperties: false, required: ["task", ...(agents.length && !settings.instructions ? ["agent"] : [])], properties },
  };
}

/** The `agents` builtin's tools as the model sees them: spawn_agent (with its targets, as delegate's), wait_agent and list_agents. */
export function agentsTools(settings: DelegateSettings, describe: (target: AgentTarget) => string | undefined): ToolDefinition[] {
  const agents = settings.agents ?? [];
  const minutes = (ms: number) => `${ms / 60_000} minutes`;
  return [{
    name: "spawn_agent", exposure: "direct", executionMode: "parallel",
    description: [
      "Start a sub-agent on a task in the background, and go on at once: this returns its agentId and name, not its answer. When it finishes (or fails, or waits on a person), its answer arrives as a message of its own, an <agent_notification> block; you need not poll for it. Use wait_agent to wait for it now instead. The sub-agent works on its own (its own tools and history) and sees only the task you give it.",
      agents.length ? `Agents you can start:\n${listed(agents, describe)}` : "",
      settings.instructions ? `${agents.length ? "Or give" : "Give"} instructions to start a sub-agent of your own design, with your model.` : "",
    ].filter(Boolean).join("\n\n"),
    parameters: { type: "object", additionalProperties: false, required: ["task", ...(agents.length && !settings.instructions ? ["agent"] : [])], properties: {
      ...targetProperties(settings, "start"),
      name: { type: "string", pattern: NAME.source, description: "Your handle for it, unique among your running sub-agents (default: the agent's name and a number)" },
    } },
  }, {
    name: "wait_agent", exposure: "direct",
    description: `Wait until one of your running sub-agents finishes (by default any of them; or those named), or until timeoutMs passes (default ${minutes(MULTI_AGENT_LIMITS.waitMs)}, at most ${minutes(MULTI_AGENT_LIMITS.maxWaitMs)}). Returns each one's status, with the answer of any that finished: those answers do not arrive again as notifications.`,
    parameters: { type: "object", additionalProperties: false, properties: {
      agents: { type: "array", items: { type: "string" }, maxItems: MULTI_AGENT_LIMITS.parallelCeiling, description: "Names or agentIds of the sub-agents to wait for (default: all running ones)" },
      timeoutMs: { type: "integer", minimum: 1_000, maximum: MULTI_AGENT_LIMITS.maxWaitMs },
    } },
  }, {
    name: "list_agents", exposure: "direct",
    description: "List the sub-agents you started with spawn_agent: each one's agentId, name, status (running, completed, failed, aborted or input_required), startedAt and endedAt (ms since the epoch).",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  }];
}

/** How a child's run ended, as its parent hears it. */
export type ChildStatus = "completed" | "failed" | "aborted" | "input_required";
/** A child's ended run (a request record as callers see it): its status, error and result. */
type Ended = { status?: string; error?: string; outcome?: { result?: unknown; error?: string } };
export function childStatus(record: Ended): ChildStatus {
  if ((record.outcome?.result as { code?: string } | undefined)?.code === "aborted") return "aborted";
  return record.status === "completed" || record.status === "input_required" ? record.status : "failed";
}

/** Who sent a notification: the child, by its id and its name in its parent's eyes. */
export type AgentSource = { kind: "agent"; agentId: string; name: string };
/**
 * A child's ending as its parent's prompt params: its answer as the message's text (rendered for the model in an
 * <agent_notification> block, sender.ts), and the runtime's `notice` (only the runtime sends one): who sent it, its
 * metadata, the chain's root (for the wake cap) and what the child spent (charged to the parent when it lands).
 * Built once and stored, so every delivery sends the same request.
 */
export function childNotice(child: { agentId: string; name: string; root: string }, record: Ended) {
  const status = childStatus(record);
  const result = (record.outcome?.result ?? {}) as { reply?: string; output?: unknown; inputs?: { id: string }[]; usage?: { costUsd?: number; subagentCostUsd?: number } | null };
  const error = record.error ?? record.outcome?.error;
  const parts = [
    result.output !== undefined ? JSON.stringify(result.output) : result.reply ?? "",
    status === "input_required" ? `Waiting for a person's input (${(result.inputs ?? []).map(input => input.id).join(", ") || "none listed"}).` : "",
    error && status !== "input_required" ? `Error: ${error}` : "",
  ].filter(Boolean);
  const whole = parts.join("\n\n") || "(no answer)";
  const text = whole.length > MULTI_AGENT_LIMITS.noticeChars ? `${whole.slice(0, MULTI_AGENT_LIMITS.noticeChars)}… (cut at ${MULTI_AGENT_LIMITS.noticeChars} characters; read the rest in the agent's history)` : whole;
  const costUsd = (result.usage?.costUsd ?? 0) + (result.usage?.subagentCostUsd ?? 0);
  const source: AgentSource = { kind: "agent", agentId: child.agentId, name: child.name };
  return {
    text,
    notice: {
      source, root: child.root, costUsd,
      metadata: {
        agentId: child.agentId, name: child.name, status, ...(result.output !== undefined ? { output: result.output } : {}), ...(error ? { error } : {}),
        ...(result.inputs?.length ? { inputs: result.inputs.map(input => input.id) } : {}), usage: result.usage ?? null,
      },
    },
  };
}
export type ChildNotice = ReturnType<typeof childNotice>;
