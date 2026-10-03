import { createHash } from "node:crypto";
import { HttpError } from "./http.ts";
import type { ToolDefinition } from "./protocol.ts";

/**
 * Sub-agents: the `delegate` built-in, answered by the runtime's sessions (client-sessions.ts) rather than a tool source,
 * starts a child agent on a task and returns its answer. It needs its builtin enabled and an allowlist of targets
 * (`delegate`), beside `builtins` on an agent or a definition.
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
/** What a child's run carries in its prompt's metadata: who started it, and where it is in the chain. */
export const PARENT_KEYS = { agent: "parentAgentId", run: "parentRunId", toolCall: "parentToolCallId", depth: "delegationDepth", maxDepth: "delegationMaxDepth", chain: "delegationChain" } as const;

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

/** Check `delegate` against `builtins`: the settings go with the builtin, and the builtin needs them. Undefined: none given. */
export function delegateSettings(builtins: readonly string[] | undefined, value: unknown): DelegateSettings | undefined {
  const delegate = value === undefined || value === null ? undefined : delegateInput(value);
  if (delegate && !builtins?.includes("delegate")) throw new HttpError(400, `delegate settings need the delegate builtin: add "delegate" to builtins`);
  if (!delegate && builtins?.includes("delegate")) throw new HttpError(400, "The delegate builtin needs delegate: { agents } (or instructions: true): who it may delegate to");
  return delegate;
}

/** A definition's id from a target's reference: an id as given, a key as the definition upsert by that key made it. */
export function definitionId(tenant: string, ref: string) {
  return /^def_[a-f0-9]{20}$/.test(ref) ? ref : `def_${createHash("sha256").update(`${tenant}:${ref}`).digest("hex").slice(0, 20)}`;
}

const listed = (targets: AgentTarget[], describe: (target: AgentTarget) => string | undefined) =>
  targets.map(target => `- ${target.name}${(target.description ?? describe(target)) ? `: ${target.description ?? describe(target)}` : ""}`).join("\n");

/** The delegate tool as the model sees it: its targets by name, with what each is for (`describe`: a definition's own description). */
export function delegateTool(settings: DelegateSettings, describe: (target: AgentTarget) => string | undefined): ToolDefinition {
  const agents = settings.agents ?? [];
  const properties: Record<string, unknown> = {
    ...(agents.length ? { agent: { type: "string", enum: agents.map(target => target.name), description: "Which agent to delegate to" } } : {}),
    ...(settings.instructions ? { instructions: { type: "string", minLength: 1, maxLength: MULTI_AGENT_LIMITS.instructionsChars, description: `A system prompt for a new sub-agent${agents.length ? ", instead of naming an agent" : ""}: who it is and how it should work` } } : {}),
    task: { type: "string", minLength: 1, maxLength: MULTI_AGENT_LIMITS.taskChars, description: "The task, with everything the sub-agent needs to know: it sees none of this conversation" },
    output: { type: "object", description: "A JSON Schema for an object, if you want the answer in that shape (type: \"object\")" },
  };
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
