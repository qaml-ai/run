/**
 * The SDK's simple interface: keyed agents you upsert and run.
 *
 *   const agents = new Agents({ apiKey: process.env.CAMELAI_API_KEY });
 *   const agent = await agents.upsert("support-triage", { instructions: "…" });
 *   const run = await agent.run("Summarize ticket 123");
 *   console.log(run.text);
 *   await agents.close();
 *
 * It is built on the lower-level `AgentRuntime` and `AgentClient`, which stay available (`agents.runtime`, `agent.client`).
 */
import {
  AgentClient, AgentError, AgentRuntime, RunError, toolServer,
  type AgentFiles, type Builtin, type DelegateSettings, type RecordedMessage, type AgentInput, type AgentOptions, type Attachment, type CreateAgentOptions, type HistoryPage, type InputAnswer,
  type ForkedFrom, type ForkOptions, type Mount, type RunResult, type RunUsage, type RuntimeOptions, type Sender, type SessionCredentials, type ToolError, type RunToolCall, type ToolServer, type Tools, type AgentFile, type SteerReceipt,
} from "./typescript.ts";
import type { AgentEvent, ThinkingLevel } from "./types.ts";
import type { Static, TSchema } from "typebox";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;

export interface AgentsOptions {
  /** Your API key (the console's). Default: the CAMELAI_API_KEY environment variable. */
  apiKey?: string;
  /** The runtime's origin. Default: CAMELAI_BASE_URL, else https://run.camelai.com. */
  url?: string;
  fetch?: typeof globalThis.fetch;
  /** Opens a local file to attach by its path; the Node entry sets it. */
  openFile?: RuntimeOptions["openFile"];
  pollMs?: number;
}

/** An agent's configuration: what `upsert` makes it, or changes it to. */
export interface AgentConfig {
  /** A model from the catalog (GET /v1/models) as "provider/model-id", e.g. "anthropic/claude-sonnet-5-5". */
  model?: string;
  /** The system prompt. */
  instructions?: string;
  /** Text the model reads after the instructions (a definition's, say), e.g. per-conversation context. */
  instructionsAppend?: string;
  /** false: no file tools (read, write, edit, ls, glob, grep), for an application with file tools of its own. */
  fileTools?: boolean;
  /**
   * Tools that run in this process (`tool({...})`). An agent with them is attached to this process: it
   * answers the agent's tool calls, one process at a time. Serverless or several processes: serve
   * tools over HTTP (`serveTools`) and name them in a definition instead.
   */
  tools?: Tools;
  /** Or an MCP server of your own, attached the same way (`fromMcpServer`). */
  mcp?: ToolServer;
  /** A definition (reusable configuration with tool sources: MCP servers, OpenAPI specs, built-ins) to make it from. */
  definition?: string;
  /** Tools the runtime answers itself (web_fetch, web_search, schedule, ask_user, delegate), without a definition. */
  builtins?: Builtin[];
  /**
   * Sub-agents: who the agent may hand tasks to (definitions, or agents by key), with `delegate` as its tool. Without a definition;
   * the delegate builtin comes with it. See the multi-agent guide.
   */
  delegate?: DelegateSettings;
  /** Also receive its sub-agents' progress as events (subagent_start, subagent_event, subagent_end), in `onEvent` and `stream()`. */
  subagents?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Who the agent acts for (a user id in your app): `identity.subject` in its tool calls. Set when it is made. */
  subject?: string;
  /** Claims your tools need (org, workspace…): `identity.context` in its tool calls. Set when it is made. */
  context?: Record<string, unknown>;
  keyScope?: string;
  /** The most it may spend on model calls from now on (USD). */
  spendLimit?: { usd: number };
  /** The most one run may take: model responses, and seconds (within the runtime's 1,000 and 2 hours by default); and how long a model request may go quiet before it fails as stalled and is retried: before its first token (default 120 s, 300 for a reasoning model thinking high or more) and between events (default 45 s). */
  runLimits?: { maxResponses?: number; maxSeconds?: number; firstTokenSeconds?: number; idleSeconds?: number };
  modelHeaders?: Record<string, string>;
  mounts?: Mount[];
  name?: string;
  /** Every event, for display; see `AgentOptions.onEvent`. Runs apart from the connection, in order. */
  onEvent?: (event: AgentEvent, runId?: string) => unknown | Promise<unknown>;
  /** Answer human input as it is asked (return an answer), or later with `run.inputs[i].answer()`. */
  onInput?: AgentOptions["onInput"];
  onError?: (error: Error) => void;
  onConnection?: (connected: boolean) => void;
  /** Replace the process that serves this agent's tools now, instead of failing with APPLICATION_CONNECTED. */
  takeover?: boolean;
  /**
   * Serve `tools` from this process (default: true when there are any). false declares them, as the agent's
   * configuration, but leaves serving them to another process: to run the agent from a second process.
   */
  attach?: boolean;
}

/** A failure, as a run reports it. `code` is stable; `message` is for people. */
export interface RunFailure {
  /** e.g. model_error, spend_limit, runtime_error, or the runtime's own (APPLICATION_NOT_CONNECTED…). */
  code: string;
  message: string;
  /** The runtime could not tell whether the run's work took effect (a restart cut it short). */
  uncertain?: boolean;
}

/**
 * A run of the agent: one message and everything the agent did about it.
 * `completed`: it answered (`text`). `input_required`: it waits on people (`inputs`); answer them to resume it.
 * `failed`: see `error` (and, unless `throwOnError: false`, the RunError thrown).
 */
export interface Run<T = unknown> {
  id: string;
  status: "completed" | "input_required" | "failed";
  /** The final reply's text; "" when it said nothing (or failed first). */
  text: string;
  /** A run with `output`: the answer, which fits its schema (parsed by it, for a zod or other Standard Schema). */
  output?: T;
  /** What it waits on, when `input_required`. */
  inputs: RunInput<T>[];
  error: RunFailure | null;
  /** What its model calls used, where the runtime reports it; else null. */
  usage: RunUsage | null;
  /** Files it wrote (download them with `agent.files`). */
  files: AgentFile[];
  /**
   * Tool calls that did not complete (the model was told, and carried on): check these where a tool's side
   * effect matters. `not_connected`: no process served the agent's tools, so the call did not run.
   */
  toolErrors: ToolError[];
  /** The tool calls it made (the first 100), those from js_exec's code included: ids and `ok` or an error `code`; arguments and results are in history. */
  toolCalls: RunToolCall[];
  /** Tool sources (MCP servers, OpenAPI specs) that could not be reached, so the model went without their tools. */
  sourceErrors: { kind: string; source: string; message: string }[];
  /** The runtime's result as sent. */
  raw: RunResult | null;
}

/** An answer's value: approval or url: true (yes/done) or false; question: the label chosen (or labels, or your own words), or a map of question to answer; form: its fields (a confirmation, a form without fields: true or false). */
export type InputValue = boolean | string | string[] | Record<string, unknown>;
export interface AnswerOptions {
  /** Who answers (your user id): checked against who may, when the input names its audience. */
  from?: string | Sender;
  /** Throw a RunError if the resumed run fails (default true). */
  throwOnError?: boolean;
  signal?: AbortSignal;
}
/** Human input a run waits on, with the means to answer it. Answering resolves with the resumed run. */
export interface RunInput<T = unknown> extends Omit<AgentInput, "answer"> {
  answer(value: InputValue, options?: AnswerOptions): Promise<Run<T>>;
  decline(options?: AnswerOptions): Promise<Run<T>>;
}

/**
 * A Standard Schema (zod 4.2+, Valibot, ArkType) that also says its JSON Schema (Standard JSON Schema):
 * what `output` takes besides a TypeBox schema (`schema.Object(…)`) or a plain JSON Schema.
 */
export interface StandardOutputSchema<T = unknown> {
  readonly "~standard": {
    readonly validate: (value: unknown) => StandardResult<T> | Promise<StandardResult<T>>;
    readonly jsonSchema?: { readonly input: (options: { target: string }) => Record<string, unknown> };
    readonly types?: { readonly output: T };
  };
}
type StandardResult<T> = { readonly value: T; readonly issues?: undefined } | { readonly issues: readonly { readonly message: string; readonly path?: readonly unknown[] }[] };
/** A schema for a run's structured output: a JSON Schema for an object, as TypeBox, zod or plain JSON. */
export type OutputSchema = StandardOutputSchema<any> | TSchema | Record<string, unknown>;
/** The value a run's `output` schema gives. */
export type OutputOf<S> = S extends { readonly "~standard": { readonly types?: { readonly output: infer T } } } ? T : S extends TSchema ? Static<S> : unknown;

export interface RunOptions {
  /** Who sent it (your user id, or a Sender): the model sees who, and tools get it as `identity.user`. */
  user?: string | Sender;
  files?: Attachment[];
  /** Your own key-value data about the message; the model never sees it. */
  metadata?: Record<string, string>;
  /** The run's id: sending the same key again returns the same run, never a second one. */
  idempotencyKey?: string;
  /** Stop waiting (the run goes on; `agent.abort()` stops it). There is no timeout otherwise. */
  signal?: AbortSignal;
  /** Resolve with a failed run instead of throwing RunError. Default true: failures throw. */
  throwOnError?: boolean;
  /** While a turn runs, "queue" (default) runs after it; "steer" hands the message to it. */
  whileRunning?: "queue" | "steer";
  /**
   * Run even when no process serves the agent's tools (calls to them then fail as not_connected). Without
   * it, such a run is refused with an AgentError, code APPLICATION_NOT_CONNECTED.
   */
  allowDisconnected?: boolean;
  /** This run's own budget (USD): it ends before its next model request once it has spent this. The agent's spendLimit is unchanged. */
  spendLimit?: { usd: number };
  /**
   * Structured output: a schema for an object (zod, TypeBox or JSON Schema). The agent ends the run with an answer
   * that fits it, as `run.output`; a run that ends without one fails (code output_missing). Not with whileRunning: "steer".
   */
  output?: OutputSchema;
  /**
   * A W3C trace context (`00-<trace-id>-<span-id>-<flags>`) to continue: when the tenant exports telemetry
   * (`agents.runtime.telemetry.set`), the run's spans join this trace under that span. Not part of the run's idempotency.
   */
  traceparent?: string;
}

/** What `agent.stream()` yields. `raw` is the event it came from. */
export type StreamPart =
  /** Reply text as the model writes it; successive messages are separated by a blank line. */
  | { type: "text"; text: string; raw: AgentEvent }
  /** `tool` and `toolCallId` are as `run.toolCalls` names them; `name` and `id` are the same values. */
  | { type: "tool_call"; id: string; toolCallId: string; name: string; tool: string; arguments: unknown; raw: AgentEvent }
  /** `output`: the result's text. */
  | { type: "tool_result"; id: string; toolCallId: string; name: string; tool: string; output: string; isError: boolean; raw: AgentEvent }
  | { type: "input_required"; input: RunInput; raw: AgentEvent }
  /** With `subagents: true`: a delegate call's child agent started on its task, and ended. */
  | { type: "subagent_start"; toolCallId: string; agentId: string; name: string; raw: AgentEvent }
  | { type: "subagent_end"; toolCallId: string; agentId: string; status: "completed" | "input_required" | "failed"; raw: AgentEvent }
  /** Always last: the run as it ended. */
  | { type: "done"; run: Run };

/** `for await (const part of agent.stream(text))`; `result()` is the run, as `done` has it. */
export interface RunStream<T = unknown> extends AsyncIterable<StreamPart> {
  readonly id: string;
  result(): Promise<Run<T>>;
}

/** What the runtime is sent for an output schema: its JSON Schema (a Standard Schema's input side, the model's to write). */
function outputRequest(schema: OutputSchema): { schema: Record<string, unknown> } {
  const standard = (schema as StandardOutputSchema)["~standard"];
  if (!standard) return { schema: schema as Record<string, unknown> };
  if (!standard.jsonSchema) throw new AgentError("This schema cannot say its JSON Schema (Standard JSON Schema: zod 4.2+, or an adapter); pass a JSON Schema or a TypeBox schema instead");
  return { schema: standard.jsonSchema.input({ target: "draft-2020-12" }) };
}

const senderOf = (user: string | Sender) => typeof user === "string" ? { id: user } : user;
const textOf = (value: unknown): string => {
  const content = (value as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return typeof value === "string" ? value : JSON.stringify(value ?? null);
  return content.flatMap(part => part && typeof part === "object" && typeof part.text === "string" ? [part.text] : []).join("\n");
};

export class Agents {
  /** The lower-level client: definitions, volumes, mounts, inbox. */
  readonly runtime: AgentRuntime;
  private readonly open = new Set<Agent>();
  constructor(options: AgentsOptions = {}) {
    const apiKey = options.apiKey ?? env("CAMELAI_API_KEY") ?? env("AGENT_RUNTIME_TOKEN");
    this.runtime = new AgentRuntime({
      ...options, url: options.url ?? env("CAMELAI_BASE_URL") ?? env("AGENT_URL"), ...(apiKey ? { apiKey } : {}),
    });
  }

  /**
   * The agent for `key` (your name for it: "support-triage", or "user-123"), made now if there is none,
   * and set to `config` if it differs. The same key is the same agent, with its history and files, for
   * as long as you keep it (until `agent.delete()`); any number of processes may upsert it.
   */
  async upsert(key: string, config: AgentConfig = {}): Promise<Agent> {
    if (!this.runtime.options.apiKey) throw new AgentError("No API key: set CAMELAI_API_KEY (or pass apiKey). Create one at https://run.camelai.com/console/tokens. Coding agents: read https://run.camelai.com/SKILL.md");
    const options = createOptions(config);
    const { session } = await this.runtime.upsertAgent(key, options);
    // The upsert declared these tools already (between the agent's turns, if it runs).
    return this.connect(session, config, { ...options, syncTools: false });
  }

  /**
   * The existing agent with this key (or id), without changing it: `upsert` sets an agent to the config it is given,
   * `get` takes it as it is. Throws an AgentError with status 404 when there is none. Pass `tools` to serve them too.
   */
  async get(keyOrId: string, config: Pick<AgentConfig, "tools" | "mcp" | "onEvent" | "onInput" | "onError" | "onConnection" | "takeover" | "attach"> = {}): Promise<Agent> {
    if (!this.runtime.options.apiKey) throw new AgentError("No API key: set CAMELAI_API_KEY (or pass apiKey). Create one at https://run.camelai.com/console/tokens. Coding agents: read https://run.camelai.com/SKILL.md");
    return this.agent(await this.runtime.agentCredentials(keyOrId), config);
  }

  /**
   * A new agent forked from `agentId` (see `agent.fork`): its configuration, a copy of its history and a fork of its
   * workspace, each its own from then on. Pass `tools` to serve them, as for `get`.
   */
  async fork(agentId: string, options: ForkOptions & Pick<AgentConfig, "tools" | "mcp" | "onEvent" | "onInput" | "onError" | "onConnection" | "takeover" | "attach"> = {}): Promise<Agent> {
    const { key, name, atMessage, ttlSeconds, subject, context, instructionsAppend, modelHeaders, ...config } = options;
    const { session, forkedFrom } = await this.runtime.forkAgent(agentId, { key, name, atMessage, ttlSeconds, subject, context, instructionsAppend, modelHeaders });
    const agent = await this.agent(session, config);
    agent.forkedFrom = forkedFrom;
    return agent;
  }

  /** An agent you hold the credentials of (`agent.session` from another process, say). */
  async agent(session: SessionCredentials, config: Pick<AgentConfig, "tools" | "mcp" | "onEvent" | "onInput" | "onError" | "onConnection" | "takeover" | "attach"> = {}): Promise<Agent> {
    return this.connect(session, config, createOptions(config));
  }

  private async connect(session: SessionCredentials, config: AgentConfig, options: AgentOptions) {
    const attach = config.attach ?? (!!config.mcp || Object.keys(config.tools ?? {}).length > 0);
    const client = await this.runtime.connectAgent(session, { ...options, attach });
    const agent = new Agent(client, () => this.open.delete(agent), this);
    this.open.add(agent);
    return agent;
  }

  /**
   * Close every agent's connection (their runs go on in the runtime). Tool calls running finish first, for up to
   * `drainMs` (default 25 s), and new ones go elsewhere: call it on SIGTERM so a deploy loses no call.
   */
  async close(options: { drainMs?: number } = {}) { await Promise.all([...this.open].map(agent => agent.close(options))); }
  async [Symbol.asyncDispose]() { await this.close(); }
}

function createOptions(config: AgentConfig): CreateAgentOptions {
  const { instructions, instructionsAppend, onEvent, ...rest } = config;
  return {
    ...rest, ...(instructions !== undefined ? { systemPrompt: instructions } : {}), ...(instructionsAppend !== undefined ? { systemPromptAppend: instructionsAppend } : {}),
    ...(onEvent ? { onEvent: (event: AgentEvent, requestId?: string) => onEvent(event, requestId) } : {}),
  };
}

export class Agent {
  /** The agent's id (client_…): safe to log and to store. */
  readonly id: string;
  /** The lower-level client: requests, schedules, execute, and everything else. */
  readonly client: AgentClient;
  /** For an agent `fork` made: the agent and message it was forked from (GET /v1/agents/{id} has it for any fork). */
  forkedFrom?: ForkedFrom;
  private readonly closed: () => void;
  private readonly agents?: Agents;
  constructor(client: AgentClient, closed: () => void = () => {}, agents?: Agents) { this.client = client; this.id = client.id; this.closed = closed; this.agents = agents; }

  /** The agent's id and token (the token is secret, and left out of logs and JSON). */
  get session(): SessionCredentials { return this.client.session; }
  /** The agent's files: list, download, upload and link. */
  get files(): AgentFiles { return this.client.files; }

  /**
   * Send a message and wait for the run it starts: its reply, or the input it waits on. There is no
   * timeout (runs can take minutes, or wait on people for days); `signal` stops the wait. A failed run
   * throws a RunError (with the run) unless `throwOnError: false`.
   */
  async run<S extends OutputSchema = never>(text: string, options: RunOptions & { output?: S } = {}): Promise<Run<OutputOf<S>>> {
    const id = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    return this.settle(id, this.client.prompt(text, promptOptions(id, options)), options.throwOnError, options.output);
  }

  /**
   * Send a message and read the run as it happens: its text as it is written, tool calls and results,
   * the input it waits on, and last, `done` with the run. Breaking off stops the reading, not the run.
   */
  stream<S extends OutputSchema = never>(text: string, options: RunOptions & { output?: S } = {}): RunStream<OutputOf<S>> {
    const id = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    const parts: StreamPart[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: unknown;
    const push = (part: StreamPart) => { parts.push(part); wake?.(); };
    // Text of successive assistant messages, separated so it reads as prose.
    let spoke = false, fresh = false;
    const unlisten = this.client.listen((event, requestId) => {
      if (requestId !== id) return;
      switch (event.type) {
        case "message_start": if (event.message.role === "assistant") fresh = true; break;
        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (delta.type !== "text_delta" || !delta.delta) break;
          push({ type: "text", text: (fresh && spoke ? "\n\n" : "") + delta.delta, raw: event });
          spoke = true; fresh = false;
          break;
        }
        case "tool_execution_start": push({ type: "tool_call", id: event.toolCallId, toolCallId: event.toolCallId, name: event.toolName, tool: event.toolName, arguments: event.args, raw: event }); break;
        case "tool_execution_end": push({ type: "tool_result", id: event.toolCallId, toolCallId: event.toolCallId, name: event.toolName, tool: event.toolName, output: textOf(event.result), isError: event.isError, raw: event }); break;
        case "input_required": push({ type: "input_required", input: this.input(event.input), raw: event }); break;
        case "subagent_start": push({ type: "subagent_start", toolCallId: event.toolCallId, agentId: event.agentId, name: event.name, raw: event }); break;
        case "subagent_end": push({ type: "subagent_end", toolCallId: event.toolCallId, agentId: event.agentId, status: event.status, raw: event }); break;
      }
    });
    const result = this.settle<OutputOf<S>>(id, this.client.prompt(text, promptOptions(id, options)), false, options.output).then(run => {
      push({ type: "done", run });
      if (run.error && options.throwOnError !== false) failure = new RunError(run);
      return run;
    }, error => { failure = error; throw error; }).finally(() => { ended = true; unlisten(); wake?.(); });
    result.catch(() => {});
    return {
      id,
      result: async () => {
        const run = await result;
        if (run.error && options.throwOnError !== false) throw new RunError(run);
        return run;
      },
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            if (parts.length) { yield parts.shift()!; continue; }
            if (ended) break;
            await new Promise<void>(resolve => { wake = resolve; });
            wake = undefined;
          }
          if (failure) throw failure;
        } finally { if (!ended) unlisten(); }
      },
    };
  }

  /** A run's outcome, however it ended, as a Run: thrown if it failed, unless `throwOnError` is false. */
  private async settle<T>(id: string, pending: Promise<RunResult>, throwOnError = true, schema?: OutputSchema): Promise<Run<T>> {
    let run: Run<T>;
    try { run = await this.toRun<T>(id, await pending, schema); }
    catch (error) {
      // A run that ended in an error settles with it; anything else (a refused request, a closed client) is not a run.
      if (!(error instanceof AgentError) || error.status !== 0 || error.requestId !== id || /^Client closed/.test(error.message)) throw error;
      run = { id, status: "failed", text: "", inputs: [], usage: null, files: [], toolErrors: [], toolCalls: [], sourceErrors: [], raw: null, error: { code: error.code ?? "runtime_error", message: error.message, ...(error.uncertain ? { uncertain: true } : {}) } };
    }
    if (run.error && throwOnError) throw new RunError(run);
    return run;
  }

  private async toRun<T>(id: string, result: RunResult | undefined, schema?: OutputSchema): Promise<Run<T>> {
    const raw = result ?? null;
    let error: RunFailure | null = raw?.error ? { code: raw.code ?? "model_error", message: raw.error }
      : raw?.stopped === "spend_limit" ? { code: "spend_limit", message: "The agent reached its spend limit; raise it (configure spendLimit) to go on" }
      : raw?.stopped === "turn_limit" ? { code: "turn_limit", message: "The run reached its limit of model responses or time; send another message to continue" } : null;
    // The runtime checked the output against the JSON Schema; a Standard Schema parses it too (refinements, transforms).
    let output = raw?.output as T | undefined;
    const standard = (schema as StandardOutputSchema<T> | undefined)?.["~standard"];
    if (standard && output !== undefined && !error) {
      const parsed = await standard.validate(output);
      if (parsed.issues) error = { code: "output_invalid", message: `The output does not fit its schema: ${parsed.issues.map(issue => `${issue.path?.length ? `${issue.path.map(key => typeof key === "object" && key ? (key as { key: unknown }).key : key).join(".")}: ` : ""}${issue.message}`).join("; ")}` };
      else output = parsed.value;
    }
    // A runtime from before structured output ignores the schema and answers in text.
    if (schema && raw && output === undefined && !error && !raw.stopped) error = { code: "output_missing", message: "The run ended without an output: this runtime may not support structured output (output); upgrade it" };
    return {
      id, status: error ? "failed" : raw?.stopped === "input_required" ? "input_required" : "completed",
      text: raw?.reply ?? "", ...(output !== undefined ? { output } : {}), inputs: (raw?.inputs ?? []).map(input => this.input<T>(input, schema)), error,
      usage: raw?.usage ?? null, files: raw?.files ?? [], toolErrors: raw?.toolErrors ?? [], toolCalls: raw?.toolCalls ?? [], sourceErrors: raw?.sourceErrors ?? [], raw,
    };
  }

  /** An input, with the means to answer it. */
  private input<T = unknown>(input: AgentInput, schema?: OutputSchema): RunInput<T> {
    const respond = async (answer: InputAnswer, options: AnswerOptions): Promise<Run<T>> => {
      if (input.responders.audience?.length && !answer.from) throw new AgentError(`Say who answers (from): only ${input.responders.audience.join(", ")} may answer this`);
      const { request } = await this.client.answer(input.id, answer);
      if (request) return this.settle<T>(request.id, this.client.waitForRequest(request.id, { ...(options.signal ? { signal: options.signal } : {}) }), options.throwOnError, schema);
      // Other inputs of the run still wait: it resumes once they are answered too.
      const pending = (await this.client.inputs("pending")).filter(other => other.requestId === input.requestId);
      return { id: input.requestId, status: "input_required", text: "", inputs: pending.map(other => this.input<T>(other, schema)), error: null, usage: null, files: [], toolErrors: [], toolCalls: [], sourceErrors: [], raw: null };
    };
    return {
      ...input,
      answer: (value, options = {}) => respond({ ...answerFor(input, value), ...(options.from ? { from: senderOf(options.from) } : {}) }, options),
      decline: (options = {}) => respond({ action: "decline", ...(options.from ? { from: senderOf(options.from) } : {}) }, options),
    };
  }

  /** Inputs waiting on people, across the agent's runs. */
  async pendingInputs(): Promise<RunInput[]> { return (await this.client.inputs("pending")).map(input => this.input(input)); }
  /** The agent's whole history (`historyPage` reads a page at a time). */
  /** Its whole history: every message, oldest first (`historyPage` reads a page at a time). */
  async history(): Promise<RecordedMessage[]> { return (await this.client.history()).messages; }
  historyPage(options: { before?: number; limit?: number } = {}): Promise<HistoryPage> { return this.client.historyPage(options); }
  /**
   * A message for the running turn, which reads it after its current step and answers with it in mind; with no turn
   * running, it starts one. Resolves as soon as the runtime has it, with a receipt: `accepted` (the turn reads it next),
   * `taken` (it has, in the turn `steeredInto`) or `queued` (it runs as a turn of its own, `id`). A turn that never ends
   * takes any number of steers. `wait: true` waits for the run that took it instead, as `run(text, { whileRunning: "steer" })`.
   */
  steer(text: string, options?: Omit<RunOptions, "whileRunning" | "output" | "spendLimit" | "throwOnError"> & { wait?: false }): Promise<SteerReceipt>;
  steer(text: string, options: Omit<RunOptions, "whileRunning"> & { wait: true }): Promise<Run>;
  steer(text: string, options: Omit<RunOptions, "whileRunning"> & { wait?: boolean } = {}): Promise<SteerReceipt | Run> {
    const { wait, ...rest } = options;
    if (wait) return this.run(text, { ...rest, whileRunning: "steer" });
    const { whileRunning: _whileRunning, spendLimit: _spendLimit, output: _output, ...message } = promptOptions(rest.idempotencyKey ?? globalThis.crypto.randomUUID(), rest);
    return this.client.steerMessage(text, message);
  }
  /** Change its model, instructions, thinking level or tools between runs. */
  configure(config: Pick<AgentConfig, "model" | "instructions" | "thinkingLevel" | "tools" | "mcp">) {
    const { instructions, ...rest } = config;
    return this.client.configure({ ...rest, ...(instructions !== undefined ? { systemPrompt: instructions } : {}) });
  }
  /**
   * Stop the agent: its running turn, and the runs queued behind it (each fails with code `cancelled`), so nothing runs
   * after the stop. `queued: "keep"` stops the running turn only.
   */
  abort(options: { queued?: "cancel" | "keep" } = {}) { return this.client.abort(options); }
  /**
   * A new agent with this one's configuration, a copy of its history and a fork of its workspace, each its own from
   * then on: try another direction without losing this one. By default the history ends with the last turn that ended
   * (never mid-turn); `atMessage` ends it at a history index or a request's turn. The same `key` returns the same fork.
   */
  fork(options: ForkOptions & Pick<AgentConfig, "tools" | "mcp" | "onEvent" | "onInput" | "onError" | "onConnection" | "takeover" | "attach"> = {}): Promise<Agent> {
    if (!this.agents) throw new AgentError("fork needs the Agents this agent came from (agents.upsert, get or agent)");
    return this.agents.fork(this.id, options);
  }
  /** Wake the agent later with a message (`text`), or run `code`; `everySeconds` (at least 60) repeats it. */
  schedule(input: Parameters<AgentClient["schedule"]>[0]) { return this.client.schedule(input); }
  schedules() { return this.client.schedules(); }
  unschedule(id: string) { return this.client.unschedule(id); }
  /** Delete the agent, its history and its files, for good. */
  async delete() { try { await this.client.destroy(); } finally { this.closed(); } }
  /** Close this process's connection to it (its runs go on in the runtime), finishing its tool calls first (see Agents.close). */
  async close(options: { drainMs?: number } = {}) { try { await this.client.close(options); } finally { this.closed(); } }
  async [Symbol.asyncDispose]() { await this.close(); }
  toJSON() { return { id: this.id }; }
  [INSPECT]() { return `Agent { id: '${this.id}' }`; }
}

function messageOptions(options: Pick<RunOptions, "user" | "files" | "metadata">) {
  return { ...(options.user ? { from: senderOf(options.user) } : {}), ...(options.files ? { files: options.files } : {}), ...(options.metadata ? { metadata: options.metadata } : {}) };
}
function promptOptions(id: string, options: RunOptions) {
  return {
    ...messageOptions(options), idempotencyKey: id,
    ...(options.signal ? { signal: options.signal } : {}), ...(options.whileRunning ? { whileRunning: options.whileRunning } : {}),
    ...(options.allowDisconnected ? { allowDisconnected: true } : {}), ...(options.spendLimit ? { spendLimit: options.spendLimit } : {}),
    ...(options.output ? { output: outputRequest(options.output) } : {}), ...(options.traceparent ? { traceparent: options.traceparent } : {}),
  };
}

/** An answer for `input` from a plain value (see InputValue). */
function answerFor(input: AgentInput, value: InputValue): InputAnswer {
  switch (input.kind) {
    case "approval": case "url":
      if (typeof value !== "boolean") throw new AgentError(`Answer ${input.kind === "approval" ? "an approval" : "a url step"} with true or false`);
      return { action: value ? "accept" : "decline" };
    case "question": {
      const questions = (input.detail.questions ?? []) as { question: string }[];
      if (typeof value === "string" || Array.isArray(value)) {
        if (questions.length !== 1) throw new AgentError(`This input asks ${questions.length} questions: answer with { "<question>": "<answer>" } for each`);
        return { action: "accept", content: { answers: { [questions[0].question]: value } } };
      }
      if (typeof value !== "object" || value === null) throw new AgentError("Answer a question with the label chosen, or a map of question to answer");
      return { action: "accept", content: { answers: value } };
    }
    case "form":
      // A confirmation (context.confirm) is a form without fields: true or false answers it.
      if (typeof value === "boolean") {
        if (value && Object.keys((input.detail.requestedSchema as { properties?: object } | undefined)?.properties ?? {}).length) throw new AgentError("This form has fields: answer with them, as an object");
        return value ? { action: "accept", content: {} } : { action: "decline" };
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AgentError("Answer a form with its fields, as an object");
      return { action: "accept", content: value };
  }
}



