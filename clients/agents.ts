/**
 * The SDK's simple interface: keyed agents you upsert and run.
 *
 *   const agents = new Agents({ apiKey: process.env.CAMELAI_API_KEY });
 *   const agent = await agents.upsert("support-triage", { model: "anthropic/claude-sonnet-5", instructions: "…" });
 *   const run = await agent.run("Summarize ticket 123");
 *   console.log(run.text);
 *   await agents.close();
 *
 * It is built on the lower-level `AgentRuntime` and `AgentClient`, which stay available (`agents.runtime`, `agent.client`).
 */
import {
  AgentClient, AgentError, AgentRuntime, RunError, toolServer,
  type AgentFiles, type AgentInput, type AgentHistory, type AgentOptions, type Attachment, type CreateAgentOptions, type HistoryPage, type InputAnswer,
  type Mount, type RunResult, type RunUsage, type RuntimeOptions, type Sender, type SessionCredentials, type ToolServer, type Tools, type AgentFile,
} from "./typescript.ts";
import type { AgentEvent, ImageContent, ThinkingLevel } from "./types.ts";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] || undefined;

export interface AgentsOptions {
  /** Your API key (the console's). Default: the CAMELAI_API_KEY environment variable. */
  apiKey?: string;
  /** The runtime's origin. Default: CAMELAI_BASE_URL, else https://agents.camelai.dev. */
  url?: string;
  fetch?: typeof globalThis.fetch;
  /** Where each agent's event cursor is kept. Default: memory (nothing is written to disk). */
  journalStore?: RuntimeOptions["journalStore"];
  /** Opens a local file to attach by its path; the Node entry sets it. */
  openFile?: RuntimeOptions["openFile"];
  pollMs?: number;
}

/** An agent's configuration: what `upsert` makes it, or changes it to. */
export interface AgentConfig {
  /** A model from the catalog (GET /v1/models) as "provider/model-id", e.g. "anthropic/claude-sonnet-5". */
  model?: string;
  /** The system prompt. */
  instructions?: string;
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
  thinkingLevel?: ThinkingLevel;
  /** Who the agent acts for (a user id in your app): `identity.subject` in its tool calls. Set when it is made. */
  subject?: string;
  /** Claims your tools need (org, workspace…): `identity.context` in its tool calls. Set when it is made. */
  context?: Record<string, unknown>;
  keyScope?: string;
  /** The most it may spend on model calls from now on (USD). */
  spendLimit?: { usd: number };
  modelHeaders?: Record<string, string>;
  mounts?: Mount[];
  name?: string;
  /** Every event, for display; see `AgentOptions.onEvent`. Runs apart from the connection, in order. */
  onEvent?: (event: AgentEvent, runId?: string) => unknown | Promise<unknown>;
  /** Answer human input as it is asked (return an answer), or later with `run.inputs[i].answer()`. */
  onInput?: AgentOptions["onInput"];
  onError?: (error: Error) => void;
  onConnection?: (connected: boolean) => void;
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
export interface Run {
  id: string;
  status: "completed" | "input_required" | "failed";
  /** The final reply's text; "" when it said nothing (or failed first). */
  text: string;
  /** What it waits on, when `input_required`. */
  inputs: RunInput[];
  error: RunFailure | null;
  /** What its model calls used, where the runtime reports it; else null. */
  usage: RunUsage | null;
  /** Files it wrote (download them with `agent.files`). */
  files: AgentFile[];
  /** The runtime's result as sent. */
  raw: RunResult | null;
}

/** An answer's value: approval or url: true (yes/done) or false; question: the label chosen (or labels, or your own words), or a map of question to answer; form: its fields. */
export type InputValue = boolean | string | string[] | Record<string, unknown>;
export interface AnswerOptions {
  /** Who answers (your user id): checked against who may, when the input names its audience. */
  from?: string | Sender;
  /** Throw a RunError if the resumed run fails (default true). */
  throwOnError?: boolean;
  signal?: AbortSignal;
}
/** Human input a run waits on, with the means to answer it. Answering resolves with the resumed run. */
export interface RunInput extends Omit<AgentInput, "answer"> {
  answer(value: InputValue, options?: AnswerOptions): Promise<Run>;
  decline(options?: AnswerOptions): Promise<Run>;
}

export interface RunOptions {
  /** Who sent it (your user id, or a Sender): the model sees who, and tools get it as `identity.user`. */
  user?: string | Sender;
  files?: Attachment[];
  images?: ImageContent[];
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
}

/** What `agent.stream()` yields. `raw` is the event it came from. */
export type StreamPart =
  /** Reply text as the model writes it; successive messages are separated by a blank line. */
  | { type: "text"; text: string; raw: AgentEvent }
  | { type: "tool_call"; id: string; name: string; arguments: unknown; raw: AgentEvent }
  /** `output`: the result's text. */
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean; raw: AgentEvent }
  | { type: "input_required"; input: RunInput; raw: AgentEvent }
  /** Always last: the run as it ended. */
  | { type: "done"; run: Run };

/** `for await (const part of agent.stream(text))`; `result()` is the run, as `done` has it. */
export interface RunStream extends AsyncIterable<StreamPart> {
  readonly id: string;
  result(): Promise<Run>;
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
    if (!this.runtime.options.apiKey) throw new AgentError("Set apiKey (or the CAMELAI_API_KEY environment variable): create a key in the console at https://agents.camelai.dev");
    const options = createOptions(config);
    const { session } = await this.runtime.upsertAgent(key, options);
    return this.connect(session, config, options);
  }

  /** An agent you hold the credentials of (`agent.session` from another process, say). */
  async agent(session: SessionCredentials, config: Pick<AgentConfig, "tools" | "mcp" | "onEvent" | "onInput" | "onError" | "onConnection"> = {}): Promise<Agent> {
    return this.connect(session, config, createOptions(config));
  }

  private async connect(session: SessionCredentials, config: AgentConfig, options: AgentOptions) {
    const attach = !!config.mcp || Object.keys(config.tools ?? {}).length > 0;
    const client = await this.runtime.connectAgent(session, { ...options, attach });
    const agent = new Agent(client, () => this.open.delete(agent));
    this.open.add(agent);
    return agent;
  }

  /** Close every agent's connection (their runs go on in the runtime). */
  async close() { await Promise.all([...this.open].map(agent => agent.close())); }
  async [Symbol.asyncDispose]() { await this.close(); }
}

function createOptions(config: AgentConfig): CreateAgentOptions {
  const { instructions, onEvent, ...rest } = config;
  return {
    ...rest, ...(instructions !== undefined ? { systemPrompt: instructions } : {}),
    ...(onEvent ? { onEvent: (event: AgentEvent, requestId?: string) => onEvent(event, requestId) } : {}),
  };
}

export class Agent {
  /** The agent's id (client_…): safe to log and to store. */
  readonly id: string;
  /** The lower-level client: requests, schedules, execute, and everything else. */
  readonly client: AgentClient;
  private readonly closed: () => void;
  constructor(client: AgentClient, closed: () => void = () => {}) { this.client = client; this.id = client.id; this.closed = closed; }

  /** The agent's id and token (the token is secret, and left out of logs and JSON). */
  get session(): SessionCredentials { return this.client.session; }
  /** The agent's files: list, download, upload and link. */
  get files(): AgentFiles { return this.client.files; }

  /**
   * Send a message and wait for the run it starts: its reply, or the input it waits on. There is no
   * timeout (runs can take minutes, or wait on people for days); `signal` stops the wait. A failed run
   * throws a RunError (with the run) unless `throwOnError: false`.
   */
  async run(text: string, options: RunOptions = {}): Promise<Run> {
    const id = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    return this.settle(id, this.client.prompt(text, promptOptions(id, options)), options.throwOnError);
  }

  /**
   * Send a message and read the run as it happens: its text as it is written, tool calls and results,
   * the input it waits on, and last, `done` with the run. Breaking off stops the reading, not the run.
   */
  stream(text: string, options: RunOptions = {}): RunStream {
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
        case "tool_execution_start": push({ type: "tool_call", id: event.toolCallId, name: event.toolName, arguments: event.args, raw: event }); break;
        case "tool_execution_end": push({ type: "tool_result", id: event.toolCallId, name: event.toolName, output: textOf(event.result), isError: event.isError, raw: event }); break;
        case "input_required": push({ type: "input_required", input: this.input(event.input), raw: event }); break;
      }
    });
    const result = this.settle(id, this.client.prompt(text, promptOptions(id, options)), false).then(run => {
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
  private async settle(id: string, pending: Promise<RunResult>, throwOnError = true): Promise<Run> {
    let run: Run;
    try { run = this.toRun(id, await pending); }
    catch (error) {
      // A run that ended in an error settles with it; anything else (a refused request, a closed client) is not a run.
      if (!(error instanceof AgentError) || error.status !== 0 || error.requestId !== id || /^Client closed/.test(error.message)) throw error;
      run = { id, status: "failed", text: "", inputs: [], usage: null, files: [], raw: null, error: { code: error.code ?? "runtime_error", message: error.message, ...(error.uncertain ? { uncertain: true } : {}) } };
    }
    if (run.error && throwOnError) throw new RunError(run);
    return run;
  }

  private toRun(id: string, result: RunResult | undefined): Run {
    const raw = result ?? null;
    const error: RunFailure | null = raw?.error ? { code: raw.code ?? "model_error", message: raw.error }
      : raw?.stopped === "spend_limit" ? { code: "spend_limit", message: "The agent reached its spend limit; raise it (configure spendLimit) to go on" } : null;
    return {
      id, status: error ? "failed" : raw?.stopped === "input_required" ? "input_required" : "completed",
      text: raw?.reply ?? "", inputs: (raw?.inputs ?? []).map(input => this.input(input)), error,
      usage: raw?.usage ?? null, files: raw?.files ?? [], raw,
    };
  }

  /** An input, with the means to answer it. */
  private input(input: AgentInput): RunInput {
    const respond = async (answer: InputAnswer, options: AnswerOptions): Promise<Run> => {
      if (input.responders.audience?.length && !answer.from) throw new AgentError(`Say who answers (from): only ${input.responders.audience.join(", ")} may answer this`);
      const { request } = await this.client.answer(input.id, answer);
      if (request) return this.settle(request.id, this.client.waitForRequest(request.id, { ...(options.signal ? { signal: options.signal } : {}) }), options.throwOnError);
      // Other inputs of the run still wait: it resumes once they are answered too.
      const pending = (await this.client.inputs("pending")).filter(other => other.requestId === input.requestId);
      return { id: input.requestId, status: "input_required", text: "", inputs: pending.map(other => this.input(other)), error: null, usage: null, files: [], raw: null };
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
  history(): Promise<AgentHistory> { return this.client.history(); }
  historyPage(options: { before?: number; limit?: number } = {}): Promise<HistoryPage> { return this.client.historyPage(options); }
  /** Add a message to the running turn (it fails if none runs: use `run`). */
  steer(text: string, options: Pick<RunOptions, "user" | "files" | "metadata"> = {}) { return this.client.steer(text, messageOptions(options)); }
  /** A message for the agent once its running turn ends (or now, if none runs). */
  followUp(text: string, options: Pick<RunOptions, "user" | "files" | "metadata"> = {}) { return this.client.followUp(text, messageOptions(options)); }
  /** Change its model, instructions, thinking level or tools between runs. */
  configure(config: Pick<AgentConfig, "model" | "instructions" | "thinkingLevel" | "tools" | "mcp">) {
    const { instructions, ...rest } = config;
    return this.client.configure({ ...rest, ...(instructions !== undefined ? { systemPrompt: instructions } : {}) });
  }
  /** Stop the running turn. */
  abort() { return this.client.abort(); }
  /** Delete the agent, its history and its files, for good. */
  async delete() { try { await this.client.destroy(); } finally { this.closed(); } }
  /** Close this process's connection to it (its runs go on in the runtime). */
  async close() { try { await this.client.close(); } finally { this.closed(); } }
  async [Symbol.asyncDispose]() { await this.close(); }
  toJSON() { return { id: this.id }; }
  [INSPECT]() { return `Agent { id: '${this.id}' }`; }
}

function messageOptions(options: Pick<RunOptions, "user" | "files" | "metadata">) {
  return { ...(options.user ? { from: senderOf(options.user) } : {}), ...(options.files ? { files: options.files } : {}), ...(options.metadata ? { metadata: options.metadata } : {}) };
}
function promptOptions(id: string, options: RunOptions) {
  return {
    ...messageOptions(options), idempotencyKey: id, ...(options.images ? { images: options.images } : {}),
    ...(options.signal ? { signal: options.signal } : {}), ...(options.whileRunning ? { whileRunning: options.whileRunning } : {}),
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
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AgentError("Answer a form with its fields, as an object");
      return { action: "accept", content: value };
  }
}



