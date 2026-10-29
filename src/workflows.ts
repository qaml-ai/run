import { randomUUID } from "node:crypto";
import { CodeGate, executeCode } from "./codemode.ts";
import { SANDBOX_LIMITS } from "./limits.ts";
import { HttpError } from "./http.ts";
import type { ToolDefinition } from "./protocol.ts";
import { outputInput } from "./tool-policy.ts";
import { MULTI_AGENT_LIMITS, targetsInput, type AgentTarget } from "./multi-agent.ts";
import type { ToolBridge } from "./protocol.ts";

/**
 * Dynamic workflows: a JavaScript script an agent runs to coordinate sub-agents, or an application sends as a
 * workflow of its own. The script is a coordinator, not a worker: its `agent()` calls start child agents exactly as the
 * `delegate` builtin does, and everything they answer stays in the script's variables. Only the script's return value
 * reaches the caller. See docs/guides/workflows.md.
 *
 * The script runs in the runtime's sandbox (`v8-exec`, as js_exec does): a bare V8 isolate with no Node globals, no
 * filesystem and no network, killed at its deadline, on cancel, or when the session ends. Its `agent()` calls cross back
 * through one host tool, and the host starts and awaits the child agents under the session's own delegation, budget and
 * depth rules.
 */
export const WORKFLOW_LIMITS = Object.freeze({
  /** agent() calls one run may make by default, and the most a setting may allow. */
  agents: 32, agentsCeiling: 120,
  /** Agent calls of one run in flight at once by default (more queue in the script), and the most a setting may allow. */
  maxParallel: 4, parallelCeiling: 16,
  /** How deep a chain of agents goes by default (as delegate's), and the most a setting may allow. */
  maxDepth: 2, depthCeiling: 5,
  /** Script length, a task's length and the labels it gives. */
  scriptChars: 32_000, taskChars: 24_000, answerChars: 24_000, instructionsChars: 16_000, labelChars: 200, logLines: 100, logChars: 500, phases: 64,
  /** Items one parallel() or pipeline() call may take, by default and at most. */
  items: 512, itemsCeiling: 4096,
  /** How long a workflow may run before it is stopped: the script's own deadline, tool calls included. */
  timeMs: 600_000,
  /** Sandbox executions of workflows one node runs at once, and one tenant (they hold a sandbox for minutes, not seconds). */
  concurrent: 4, tenantConcurrent: 2,
  /** The workflow's return value, serialized, and the arguments it was given. */
  valueBytes: 64 * 1024, argsBytes: 64 * 1024,
});

/** What a workflow may coordinate: the agents the model may name, whether it may invent one, and how wide and deep. */
export interface WorkflowSettings {
  /** Agents the model may start (a definition: a new child each call) or message (an agent: its own history). */
  agents?: AgentTarget[];
  /** Whether the model may start a child with instructions of its own instead (its model is the parent's). */
  instructions?: boolean;
  maxAgents?: number;
  maxDepth?: number;
  maxParallel?: number;
}
/** The delegate limits a workflow's settings may not exceed: one chain, one set of rules. */
export const WORKFLOW_AGENT_LIMITS = Object.freeze({ parallel: MULTI_AGENT_LIMITS.maxParallel, parallelCeiling: MULTI_AGENT_LIMITS.parallelCeiling, depth: MULTI_AGENT_LIMITS.maxDepth, depthCeiling: MULTI_AGENT_LIMITS.depthCeiling });

/** Stream events of a workflow, sent with an agent's children's events to subscribers that ask for them (`?subagents=1`). */
export const WORKFLOW_EVENTS: readonly string[] = ["workflow_start", "workflow_progress", "workflow_end"];

const integer = (value: unknown, field: string, min: number, max: number) => {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < min || (value as number) > max)) throw new HttpError(400, `${field} is an integer from ${min} to ${max}`);
  return value as number | undefined;
};

/** `workflow` as an agent or a definition gives it. */
export function workflowInput(value: unknown): WorkflowSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "workflow is { agents?, instructions?, maxAgents?, maxDepth?, maxParallel? }");
  const { agents, instructions, maxAgents, maxDepth, maxParallel, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length) throw new HttpError(400, `Unknown workflow field: ${Object.keys(rest)[0]}`);
  if (instructions !== undefined && typeof instructions !== "boolean") throw new HttpError(400, "workflow.instructions is true or false");
  const settings: WorkflowSettings = {
    ...(agents !== undefined ? { agents: targetsInput(agents, "workflow.agents") } : {}), ...(instructions !== undefined ? { instructions } : {}),
    ...(maxAgents !== undefined ? { maxAgents: integer(maxAgents, "workflow.maxAgents", 1, WORKFLOW_LIMITS.agentsCeiling) } : {}),
    ...(maxDepth !== undefined ? { maxDepth: integer(maxDepth, "workflow.maxDepth", 1, WORKFLOW_LIMITS.depthCeiling) } : {}),
    ...(maxParallel !== undefined ? { maxParallel: integer(maxParallel, "workflow.maxParallel", 1, WORKFLOW_LIMITS.parallelCeiling) } : {}),
  };
  if (!settings.agents?.length && !settings.instructions) throw new HttpError(400, "workflow needs agents the script may coordinate, or instructions: true");
  return settings;
}

/** Check `workflow` against `builtins`: the settings go with the builtin, and the builtin needs them. Undefined: none given. */
export function workflowSettings(builtins: readonly string[] | undefined, value: unknown): WorkflowSettings | undefined {
  const workflow = value === undefined || value === null ? undefined : workflowInput(value);
  if (workflow && !builtins?.includes("workflow")) throw new HttpError(400, `workflow settings need the workflow builtin: add "workflow" to builtins`);
  if (!workflow && builtins?.includes("workflow")) throw new HttpError(400, "The workflow builtin needs workflow: { agents } (or instructions: true): who its scripts may coordinate");
  return workflow;
}

const listed = (targets: AgentTarget[], describe: (target: AgentTarget) => string | undefined) =>
  targets.map(target => `- ${target.name}${(target.description ?? describe(target)) ? `: ${target.description ?? describe(target)}` : ""}`).join("\n");

/** The agents a workflow's settings let a script coordinate. */
export const workflowTargets = (settings: WorkflowSettings): AgentTarget[] => settings.agents ?? [];

/** The script's API, as the model reads it: one tool call runs a whole plan. */
export function workflowTool(settings: WorkflowSettings, describe: (target: AgentTarget) => string | undefined): ToolDefinition {
  const agents = workflowTargets(settings);
  const cap = Math.min(settings.maxAgents ?? WORKFLOW_LIMITS.agents, WORKFLOW_LIMITS.agentsCeiling);
  return {
    name: "run_workflow", exposure: "direct", executionMode: "sequential",
    description: [
      "Run a JavaScript workflow: a script that coordinates many sub-agents and returns one value. Reach for it when a task needs more agents than you can coordinate turn by turn (a sweep over many files, a migration, research cross-checked across sources), and when the plan can be written as code.",
      "The script body is plain JavaScript with top-level `await`. Its API:",
      "- `await agent(prompt, { agent?, label?, phase?, schema? })` starts one sub-agent and resolves to its answer: text, or with `schema` (a JSON Schema for an object) its object. It resolves to `null` if the agent failed or was stopped.",
      "- `await parallel([agent(...), agent(...)])` runs calls at once and waits for all; a failure is `null` in place.",
      "- `await pipeline(items, item => agent(...))` runs the same call per item, several at a time; stages may be chained: `pipeline(items, stage1, stage2)`.",
      "- `phase(title)` groups the agents after it under a title in progress; `log(message)` adds a line.",
      "- `args` is the `args` you pass; `export const meta = { name, description }` names the workflow.",
      `Each agent sees only the prompt you give it, never this conversation; put in it everything the agent needs. A run makes at most ${cap} agent calls${settings.maxDepth ? `, and a chain of agents is at most ${Math.min(settings.maxDepth, WORKFLOW_LIMITS.depthCeiling)} deep` : ""}. Only the script's return value comes back to you: return what you need, not everything.`,
      agents.length ? `Agents the script may coordinate:\n${listed(agents, describe)}` : "",
      settings.instructions ? `${agents.length ? "Or give" : "Give"} \`instructions\` to start a sub-agent of your own design, with your model.` : "",
    ].filter(Boolean).join("\n\n"),
    parameters: { type: "object", additionalProperties: false, required: ["script"], properties: {
      script: { type: "string", minLength: 1, maxLength: WORKFLOW_LIMITS.scriptChars, description: "The workflow script: plain JavaScript with top-level await, using agent, parallel, pipeline, phase, log and args" },
      args: { type: "object", description: "What the script reads as `args`" },
    } },
  };
}

/** One agent a script asked for. */
export interface ScriptAgentRequest {
  prompt: string;
  agent?: string;
  instructions?: string;
  label?: string;
  phase?: string;
  /** The agent's answer shaped as this object JSON Schema (`outputInput`). */
  schema?: Record<string, unknown>;
}

/** What became of it: the answer, or why there is none (`null` in the script). */
export type ScriptAgentOutcome = { value?: unknown; text?: string; agentId?: string; requestId?: string } | { failed: true; error?: string };

export type ScriptRunOptions = {
  script: string;
  args?: unknown;
  signal?: AbortSignal;
  /** The tenant holding the sandbox slot, for the node's admission. */
  tenant?: string;
  maxAgents: number;
  items: number;
  timeMs: number;
  /** The time this run first began: the script's `Date.now()` is fixed to it, so a replay asks the same questions. */
  frozenNow?: number;
  /** A run's stable name (its call's idempotency key): seeds `Math.random`, so a replay asks the same questions. */
  seed?: string;
  /**
   * Wait for a sandbox slot. A workflow a run started directly takes one; one started inside a child agent does not, because
   * its parent already holds a slot and a child waiting on the gate its parent holds would deadlock. Nested workflows are
   * bounded instead by the agents that can be running (the supervisor's `maxAgents` per node) and by the chain's signed
   * agent budget, so the count of ungated sandboxes is bounded too.
   */
  waitForSlot?: boolean;
  /** At most this many agent calls run at once (the sandbox bounds concurrent tool calls; the rest queue in the script). */
  parallel?: number;
  /** One agent call, awaited: the host starts the child and waits for it, and answers what the script sees. */
  callAgent: (request: ScriptAgentRequest) => Promise<ScriptAgentOutcome>;
  onPhase?: (title: string) => void;
  onLog?: (message: string) => void;
};

export type ScriptRunResult = { status: "completed" | "failed" | "canceled"; value?: unknown; error?: string; agents: number };

/** Serialized bytes, so a value the model never reads does not become one it must. */
function serializedBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value ?? null), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

/** The one host tool a workflow script sees; its operations are the script's API. */
/** A 32-bit hash of a string, for the script's seeded `Math.random`. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const WORKFLOW_TOOL = {
  name: "workflow_agent", exposure: "direct" as const,
  description: "One agent call of a workflow script, or the value it returns.",
  parameters: { type: "object", additionalProperties: false, required: ["op"], properties: {
    op: { type: "string", enum: ["agent", "return"] }, prompt: { type: "string" },
    agent: { type: "string" }, instructions: { type: "string" }, label: { type: "string" }, phase: { type: "string" },
    schema: { type: "object" }, value: {},
  } },
};

/** Workflows' sandbox slots: a workflow holds one for minutes, so they are few, and shared fairly by tenant. */
const WORKFLOW_GATE = new CodeGate(WORKFLOW_LIMITS.concurrent);

/**
 * The script as the sandbox runs it: its API defined over the one host tool, `args` and `meta` as globals, and the body
 * with its `export const meta` made an assignment. Nothing here is a security boundary — the sandbox is — so it stays
 * small and readable.
 */
function scriptCode(script: string, args: unknown, items: number, parallel: number, mark: string, now: number, seed: number): string {
  const body = script.replace(/^(\s*)export\s+const\s+meta\s*=/m, "$1meta =");
  const prelude = `
var args = ${JSON.stringify(args ?? null)};
// A script's clock and randomness are fixed for its run (seeded from the run's id, and the time it first began): a script
// replayed on another node asks exactly the same questions, so its children are found rather than made again.
var __now = ${now};
Date.now = () => __now;
var __rng = ${seed};
Math.random = () => { __rng = (__rng + 0x6D2B79F5) >>> 0; var t = __rng; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
var meta = {};
var __wf = tools.workflow_agent;
var __mark = ${JSON.stringify(mark)};
var __cap = (n, what) => { if (n > ${items}) throw new Error(what + " takes at most ${items} items"); };
var __emit = message => console.log(__mark + JSON.stringify(message));
// At most ${parallel} agent calls in flight: the sandbox bounds concurrent tool calls, and a large fan-out must wait its
// turn rather than fail in the guest.
var __active = 0, __queue = [];
var __slot = () => new Promise(resolve => { if (__active < ${parallel}) { __active++; resolve(); } else __queue.push(resolve); });
var __free = () => { const next = __queue.shift(); if (next) next(); else __active--; };
var agent = async (prompt, options) => {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("agent(prompt, options?) needs a prompt string");
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) throw new Error("agent(prompt, options?) takes an options object");
  await __slot();
  try { return await __wf({ ...(options || {}), op: "agent", prompt }); } finally { __free(); }
};
var parallel = async tasks => {
  if (!Array.isArray(tasks)) throw new Error("parallel(tasks) takes an array of agent() calls");
  __cap(tasks.length, "parallel()");
  const settled = await Promise.allSettled(tasks);
  return settled.map(result => result.status === "fulfilled" ? result.value : null);
};
var pipeline = async (items, ...stages) => {
  if (!Array.isArray(items)) throw new Error("pipeline(items, ...stages) takes an array");
  __cap(items.length, "pipeline()");
  const steps = stages.filter(stage => typeof stage === "function");
  if (!steps.length) throw new Error("pipeline(items, ...stages) needs a stage function");
  const out = new Array(items.length);
  await Promise.all(items.map(async (item, index) => {
    let value = item;
    for (const step of steps) {
      try { value = await step(value, index); } catch { value = null; }
      if (value === null || value === undefined) break;
    }
    out[index] = value ?? null;
  }));
  return out;
};
var phase = title => __emit({ op: "phase", title: String(title) });
var log = message => __emit({ op: "log", message: String(message) });
`;
  // The body is a function of its own: its value comes back over the bridge, where the host checks its size, rather than
  // through the sandbox's output budget, which belongs to the script's console output.
  return `${prelude}\nvar __value = await (async () => {\n${body}\n})();\nawait __wf({ op: "return", value: __value === undefined ? null : __value });`
}

/**
 * Run a workflow script inside the sandbox, calling back for each agent call. Resolves when the script returns, fails,
 * runs out of time or is cancelled; the sandbox process is killed either way, so a script cannot outlive its run.
 */
export async function runWorkflowScript(options: ScriptRunOptions): Promise<ScriptRunResult> {
  const { script, args, signal, tenant, maxAgents, items, timeMs, parallel = WORKFLOW_LIMITS.maxParallel, frozenNow, callAgent, onPhase, onLog } = options;
  if (typeof script !== "string" || !script.trim()) return { status: "failed", error: "Give the workflow script", agents: 0 };
  if (script.length > WORKFLOW_LIMITS.scriptChars) return { status: "failed", error: `A workflow script is at most ${WORKFLOW_LIMITS.scriptChars} characters`, agents: 0 };
  if (args !== undefined && serializedBytes(args) > WORKFLOW_LIMITS.argsBytes) return { status: "failed", error: `A workflow's args are at most ${WORKFLOW_LIMITS.argsBytes} bytes`, agents: 0 };
  // Not a security line (the sandbox has no module loader): a plain script whose work belongs in an agent's task.
  if (/\bimport\s*\(/.test(script)) return { status: "failed", error: "A workflow script cannot import modules: put library work in an agent's task", agents: 0 };
  if (items < 1 || items > WORKFLOW_LIMITS.itemsCeiling) throw new HttpError(400, `items is 1 to ${WORKFLOW_LIMITS.itemsCeiling}`);

  let agents = 0;
  let lines = 0;
  let phases = 0;
  let returned: { value: unknown } | undefined;
  const mark = randomUUID();
  // Stable across attempts of the same run, unlike the marker: the script's dice are its run's, not its attempt's.
  const seed = fnv1a(options.seed ?? mark);
  // The sandbox counts every call's arguments and result against one transfer budget (8 MB). Stay inside it in bytes,
  // with a reserve for the script's return value, so a large fan-out refuses a call it cannot afford instead of turning
  // every later call into a silent null.
  const RESERVE = 512 * 1024;
  const TRANSFER = SANDBOX_LIMITS.workflowToolBytes - RESERVE;
  let transferred = 0;
  const refuse = (message: string): never => {
    refusal = message;
    stopping.abort(new Error(message));
    throw new Error(message);
  };
  /** Why the runtime stopped the script itself (a cap), kept past the sandbox's own abort message. */
  let refusal: string | undefined;
  const stopping = new AbortController();
  const stopped = signal ? AbortSignal.any([signal, stopping.signal]) : stopping.signal;
  const bridge: ToolBridge = {
    definitions: [WORKFLOW_TOOL as never],
    call: async (name, rawArgs) => {
      if (name !== WORKFLOW_TOOL.name) throw new Error(`Unknown tool ${name}`);
      const request = rawArgs as unknown as (ScriptAgentRequest & { op?: string }) | { op?: string; value?: unknown };
      if (!request || typeof request !== "object") throw new Error("Unknown workflow operation");
      if (request.op === "return") {
        if (returned) throw new Error("A workflow returns once");
        const value = (request as { value?: unknown }).value ?? null;
        if (serializedBytes(value) > WORKFLOW_LIMITS.valueBytes) {
          refusal = `The workflow's return value is larger than ${WORKFLOW_LIMITS.valueBytes} bytes; return a summary instead of the whole result`;
          stopping.abort(new Error(refusal));
          throw new Error(refusal);
        }
        returned = { value };
        return null;
      }
      if (request.op !== "agent") throw new Error("Unknown workflow operation");
      const call = request as ScriptAgentRequest;
      if (typeof call.prompt !== "string" || !call.prompt.trim()) throw new Error("agent(prompt, options?) needs a prompt string");
      if (call.prompt.length > WORKFLOW_LIMITS.taskChars) throw new Error(`A task is at most ${WORKFLOW_LIMITS.taskChars} characters`);
      if (call.instructions !== undefined && (typeof call.instructions !== "string" || call.instructions.length > WORKFLOW_LIMITS.instructionsChars)) throw new Error(`instructions are at most ${WORKFLOW_LIMITS.instructionsChars} characters`);
      if (call.label !== undefined && typeof call.label !== "string") throw new Error("agent label is a string");
      if (agents >= maxAgents) {
        refusal = `A workflow makes at most ${maxAgents} agent calls`;
        stopping.abort(new Error(refusal));
        throw new Error(refusal);
      }
      const sent = serializedBytes({ op: "agent", ...call });
      if (transferred + sent + RESERVE > TRANSFER) refuse(`This workflow has used the sandbox's ${Math.round(TRANSFER / 1024 / 1024)} MB transfer budget: use fewer or smaller agent calls`);
      transferred += sent;
      agents++;
      const outcome = await callAgent({ ...call, ...(call.label !== undefined ? { label: call.label.slice(0, WORKFLOW_LIMITS.labelChars) } : {}) });
      if ((outcome as { failed?: boolean }).failed) return null;
      let answer = (outcome as { value?: unknown }).value ?? null;
      // The sandbox has one transfer budget for prompts and answers, counted in bytes. Text over the answer size is cut
      // where the script can see it was, at a UTF-8 boundary; an object (a schema answer) would lose its shape if cut, so
      // the call fails instead.
      if (typeof answer === "string" && Buffer.byteLength(answer, "utf8") > WORKFLOW_LIMITS.answerChars) {
        const cut = Buffer.from(answer, "utf8").subarray(0, WORKFLOW_LIMITS.answerChars).toString("utf8");
        answer = `${cut}\n\n[answer cut at ${WORKFLOW_LIMITS.answerChars} bytes]`;
      }
      const received = serializedBytes(answer);
      if (answer !== null && typeof answer === "object" && received > WORKFLOW_LIMITS.answerChars) {
        refuse(`An agent answered more than ${WORKFLOW_LIMITS.answerChars} bytes of JSON; ask it for less`);
      }
      if (transferred + received + RESERVE > TRANSFER) refuse(`This workflow has used the sandbox's ${Math.round(TRANSFER / 1024 / 1024)} MB transfer budget: use fewer or smaller agent calls`);
      transferred += received;
      return answer;
    },
  };

  try {
    const result = await executeCode({
      code: scriptCode(script, args, items, Math.min(WORKFLOW_LIMITS.parallelCeiling, Math.max(1, parallel)), mark, frozenNow ?? Date.now(), seed), bridge, signal: stopped, workflow: true, timeoutMs: timeMs,
      maxOutputCharacters: 128_000,
      ...(options.waitForSlot === false ? {} : { admit: (signal: AbortSignal) => WORKFLOW_GATE.acquire(tenant ?? "__node__", WORKFLOW_LIMITS.tenantConcurrent, signal) }),
      onEvent: event => {
        const text = (event as { type?: string; text?: string } | undefined);
        if (text?.type !== "output" || typeof text.text !== "string") return;
        if (!text.text.startsWith(mark)) return;
        let message: { op?: string; title?: unknown; message?: unknown };
        try { message = JSON.parse(text.text.slice(mark.length)); } catch { return; }
        if (message.op === "phase") {
          if (++phases > WORKFLOW_LIMITS.phases) { refusal = `A workflow may open at most ${WORKFLOW_LIMITS.phases} phases`; stopping.abort(new Error(refusal)); return; }
          if (typeof message.title === "string") onPhase?.(message.title.slice(0, WORKFLOW_LIMITS.labelChars));
          return;
        }
        if (message.op === "log") {
          if (++lines > WORKFLOW_LIMITS.logLines) { refusal = `A workflow may log at most ${WORKFLOW_LIMITS.logLines} lines`; stopping.abort(new Error(refusal)); return; }
          if (typeof message.message === "string") onLog?.(message.message.slice(0, WORKFLOW_LIMITS.logChars));
        }
      },
    });
    if (!returned) return { status: "failed", error: "The workflow did not return a value", agents };
    return { status: "completed", value: returned.value, agents };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (refusal) return { status: "failed", error: refusal, agents };
    // The run was stopped (an abort, or the session ending): not the script's failure.
    if (signal?.aborted) return { status: "canceled", error: "The workflow was stopped", agents };
    if (/transfer limit exceeded/i.test(message)) {
      return { status: "failed", error: "This workflow has used the sandbox's transfer budget: use fewer or smaller agent calls", agents };
    }
    if (/Sandbox bridge string exceeds size limit/.test(message)) {
      return { status: "failed", error: `The workflow's return value is larger than the sandbox carries in one message; return a summary under ${WORKFLOW_LIMITS.valueBytes} bytes`, agents };
    }
    if (/argument.*(limit|large)|arguments? size/i.test(message) && /workflow_agent/.test(message)) {
      return { status: "failed", error: `A workflow's calls are bounded by the sandbox: keep each task under ${WORKFLOW_LIMITS.taskChars} characters and its return value under ${WORKFLOW_LIMITS.valueBytes} bytes`, agents };
    }
    if (/^Codemode timed out|^Codemode aborted/.test(message)) {
      return { status: "failed", error: `The workflow did not finish within ${Math.round(timeMs / 1000)}s and was stopped`, agents };
    }
    return { status: "failed", error: message, agents };
  }
}

/** `outputInput` for a script's schema, as the tool gives it: an object JSON Schema. */
export const workflowSchema = (value: unknown) => outputInput({ schema: value }).schema;

