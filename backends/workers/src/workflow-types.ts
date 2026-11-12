// Agent types and model classes for a workflow's children (docs/design/swarm-workflows.md, "Agent types and model
// classes"). A type is what the runtime lets a child do; a class is how hard it may think. `agent(prompt, { type,
// class })` picks them; a workflow's `classes` pins a type's class for the whole workflow.
import { SUBAGENT_PROMPT } from "./multi-agent-policy.ts";

export type AgentType = "worker" | "critic" | "lead";
export type ModelClass = "fast" | "strong" | "max";
export const AGENT_TYPES: readonly AgentType[] = ["worker", "critic", "lead"];
export const MODEL_CLASSES: readonly ModelClass[] = ["fast", "strong", "max"];

/**
 * The built-in definitions of the three types that work inside a workflow (the fourth, the orchestrator, is the agent
 * that owns it). Model-facing: each prompt is shown to the child as its system prompt, after the sub-agent prompt.
 */
export const TYPE_DEFINITIONS: Record<AgentType, { systemPrompt: string; defaultClass: ModelClass; builtins?: string[]; delegate?: Record<string, unknown>; outputRequired?: boolean }> = {
  worker: {
    systemPrompt: `${SUBAGENT_PROMPT}\n\nYou are a worker in a workflow: do the one task you were given, completely, and answer with its result. Do not start sub-agents.`,
    defaultClass: "fast",
  },
  critic: {
    systemPrompt: `${SUBAGENT_PROMPT}\n\nYou are a critic in a workflow: find what is wrong with the work you were given. Do not fix it yourself. Answer in the schema you were given, with each problem specific enough to act on.`,
    defaultClass: "strong",
    outputRequired: true,
  },
  lead: {
    systemPrompt: `${SUBAGENT_PROMPT}\n\nYou are a lead in a workflow: plan, decide and judge. Turn goals into concrete work, resolve conflicting results, and write final answers. You may start sub-agents for parts of your task.`,
    defaultClass: "strong",
    builtins: ["delegate"],
    delegate: { instructions: true },
  },
};

/** A class's model: operator-set (`AGENT_WORKFLOW_CLASS_MODELS`, JSON `{ fast, strong, max }`), else `camelrun/<class>`. */
export function classModel(env: { AGENT_WORKFLOW_CLASS_MODELS?: string }, modelClass: ModelClass): string {
  if (env.AGENT_WORKFLOW_CLASS_MODELS) {
    const models = JSON.parse(env.AGENT_WORKFLOW_CLASS_MODELS) as Partial<Record<ModelClass, string>>;
    if (typeof models[modelClass] === "string") return models[modelClass]!;
  }
  return `camelrun/${modelClass}`;
}

export class AgentOptionsError extends Error {}

/**
 * The type and class one `agent()` call resolves to, or why it cannot run. A workflow's `classes` pins a type's class;
 * judgment (critic, lead) never goes to the fast class unless the call or the workflow says `allowFastJudgment`.
 */
export function resolveAgentOptions(args: { type?: unknown; class?: unknown; model?: unknown; output?: unknown; allowFastJudgment?: unknown },
  workflow: { classes?: Partial<Record<AgentType, ModelClass>>; allowFastJudgment?: boolean } = {}): { type?: AgentType; modelClass?: ModelClass } {
  if (args.type !== undefined && !AGENT_TYPES.includes(args.type as AgentType)) throw new AgentOptionsError(`type is one of ${AGENT_TYPES.join(", ")}`);
  if (args.class !== undefined && !MODEL_CLASSES.includes(args.class as ModelClass)) throw new AgentOptionsError(`class is one of ${MODEL_CLASSES.join(", ")}`);
  if (args.class !== undefined && args.model !== undefined) throw new AgentOptionsError("Give a class or a model, not both");
  const type = args.type as AgentType | undefined;
  if (type && TYPE_DEFINITIONS[type].outputRequired && args.output === undefined) throw new AgentOptionsError(`A ${type} answers in a schema: give it an output`);
  const modelClass = (args.class as ModelClass | undefined) ?? (type ? workflow.classes?.[type] ?? TYPE_DEFINITIONS[type].defaultClass : undefined);
  if (type && type !== "worker" && modelClass === "fast" && args.allowFastJudgment !== true && !workflow.allowFastJudgment)
    throw new AgentOptionsError(`A ${type} judges: it does not run on the fast class unless allowFastJudgment is set`);
  return { ...(type ? { type } : {}), ...(args.model === undefined && modelClass ? { modelClass } : {}) };
}

/** A workflow's `classes` pin, as a start gives it. */
export function classesInput(value: unknown): Partial<Record<AgentType, ModelClass>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new AgentOptionsError("classes maps a type (worker, critic, lead) to a class (fast, strong, max)");
  for (const [type, modelClass] of Object.entries(value)) {
    if (!AGENT_TYPES.includes(type as AgentType) || !MODEL_CLASSES.includes(modelClass as ModelClass)) throw new AgentOptionsError("classes maps a type (worker, critic, lead) to a class (fast, strong, max)");
  }
  return value as Partial<Record<AgentType, ModelClass>>;
}
