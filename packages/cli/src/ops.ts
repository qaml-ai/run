import { Api, ApiError, enc } from "./api.ts";
import type { Manifest } from "./manifest.ts";

/**
 * What the CLI and the MCP server both do, over the REST API. Each returns plain JSON: the CLI prints it (or a
 * table of it), and the MCP server hands it to the model as is.
 */

export interface DeployResult {
  key: string; id: string; name: string; revision: number;
  /** created: a new definition; updated: a new revision; unchanged: the manifest matched what was deployed. */
  status: "created" | "updated" | "unchanged" | "planned";
  toolSources?: unknown[];
  applied?: { agent: string; requestId: string; status: string; error?: string }[];
  /** reconfigured: an agent that existed takes the manifest's changes to it between its turns. */
  agents: { key: string; id?: string; status: "ready" | "failed" | "planned"; reconfigured?: true; error?: string }[];
}

/** Deploy manifests: upsert each definition by its key, apply it to live agents if asked, and make its keyed agents. */
export async function deploy(api: Api, manifests: Manifest[], options: { apply?: boolean; dryRun?: boolean } = {}): Promise<DeployResult[]> {
  const results: DeployResult[] = [];
  for (const manifest of manifests) {
    const id = await api.definitionId(manifest.key);
    const before = await api.get(`/v1/definitions/${id}`).catch(error => { if (error instanceof ApiError && error.status === 404) return undefined; throw error; });
    if (options.dryRun) {
      results.push({ key: manifest.key, id, name: String(manifest.definition.name), revision: before?.revision ?? 0, status: "planned", agents: manifest.agents.map(agent => ({ key: agent.key, status: "planned" })) });
      continue;
    }
    const saved = await api.call("POST", "/v1/definitions", manifest.definition, { "Idempotency-Key": manifest.key });
    const result: DeployResult = {
      key: manifest.key, id: saved.id, name: saved.name, revision: saved.revision,
      status: !before ? "created" : before.revision === saved.revision ? "unchanged" : "updated",
      ...(saved.toolSources ? { toolSources: saved.toolSources } : {}),
      agents: [],
    };
    if (options.apply && result.status !== "created") result.applied = (await api.call("PATCH", `/v1/definitions/${saved.id}`, { apply: "all" })).applied ?? [];
    for (const { key, ...config } of manifest.agents) {
      try {
        const agent = await api.call("POST", "/v1/agents", { definition: saved.id, ...config }, { "Idempotency-Key": key });
        result.agents.push({ key, id: agent.id, status: "ready", ...(agent.reconfigured ? { reconfigured: true as const } : {}) });
      } catch (error) {
        result.agents.push({ key, status: "failed", error: (error as Error).message });
      }
    }
    results.push(result);
  }
  return results;
}

/** The definition a manifest would send, with credentials hidden, for a dry run. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(token|apiKey|secret|password)$/i.test(key) || (key === "headers" && item && typeof item === "object") ? redactAll(item) : redact(item)]));
  }
  return value;
}
const redactAll = (value: unknown): unknown => value && typeof value === "object" ? Object.fromEntries(Object.keys(value).map(key => [key, "***"])) : "***";

export interface RunSummary {
  agent: string; requestId: string;
  /** running: it has not ended yet (poll it with `camelrun runs get`, or the get_run tool). */
  status: "running" | "completed" | "input_required" | "failed";
  text?: string;
  error?: { code: string; message: string };
  inputs?: { id: string; kind: string; message?: string; detail?: unknown }[];
  toolErrors?: unknown[];
  files?: unknown[];
  usage?: unknown;
}

/** A request record as a run: what it said, what it waits on, or why it failed. */
export function summarize(agent: string, record: any): RunSummary {
  const base = { agent, requestId: record.id };
  if (record.state !== "completed") return { ...base, status: "running" };
  const outcome = record.outcome ?? {};
  const result = outcome.result ?? {};
  const failure = outcome.error ? { code: outcome.uncertain ? "uncertain" : "runtime_error", message: outcome.error }
    : result.error ? { code: result.code ?? "model_error", message: result.error }
    : result.stopped === "spend_limit" ? { code: "spend_limit", message: "The agent reached its spend limit; raise it to go on" } : undefined;
  const status = failure ? "failed" : result.stopped === "input_required" ? "input_required" : "completed";
  return {
    ...base, status,
    ...(typeof result.reply === "string" ? { text: result.reply } : {}),
    ...(failure ? { error: failure } : {}),
    ...(result.inputs?.length ? { inputs: result.inputs.map((input: any) => ({ id: input.id, kind: input.kind, ...(input.message ? { message: input.message } : {}), detail: input.detail })) } : {}),
    ...(result.toolErrors?.length ? { toolErrors: result.toolErrors } : {}),
    ...(result.files?.length ? { files: result.files } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
  };
}

/** Wait up to `seconds` for a request to end; a run still going then comes back `running`. */
export async function waitFor(api: Api, agentId: string, requestId: string, seconds: number, signal?: AbortSignal): Promise<RunSummary> {
  const deadline = Date.now() + seconds * 1000;
  for (let delay = 250; ; delay = Math.min(delay * 1.5, 2000)) {
    const record = await api.get(`/v1/agents/${enc(agentId)}/requests/${enc(requestId)}`);
    if (record.state === "completed" || Date.now() + delay > deadline || signal?.aborted) return summarize(agentId, record);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/** Send an agent a message and wait up to `wait` seconds for its run. `requestId` makes a retry the same run. */
export async function run(api: Api, agent: string, text: string, options: { wait?: number; requestId?: string; from?: string; steer?: boolean; allowDisconnected?: boolean; signal?: AbortSignal } = {}) {
  const id = await api.agentId(agent);
  const record = await api.call("POST", `/v1/agents/${enc(id)}/prompt`, {
    text, requestId: options.requestId ?? `cli_${globalThis.crypto.randomUUID()}`, ...(options.allowDisconnected ? { allowDisconnected: true } : {}),
    ...(options.from ? { from: { id: options.from } } : {}), ...(options.steer ? { whileRunning: "steer" } : {}),
  });
  return options.wait === 0 ? summarize(id, record) : waitFor(api, id, record.id, options.wait ?? Infinity, options.signal);
}

/** Answer an input the way the SDK does: true/false for an approval, text or { question: answer } for questions, fields for a form. */
export async function answer(api: Api, agent: string, inputId: string, value: unknown, options: { from?: string; wait?: number } = {}) {
  const id = await api.agentId(agent);
  const inputs: any[] = await api.get(`/v1/agents/${enc(id)}/inputs`);
  const input = inputs.find(item => item.id === inputId);
  if (!input) throw new ApiError(404, `No input ${inputId} on ${agent}`);
  const body = { ...answerFor(input, value), ...(options.from ? { from: { id: options.from } } : {}) };
  const answered = await api.call("POST", `/v1/agents/${enc(id)}/inputs/${enc(inputId)}`, body);
  if (!answered.request) return { agent: id, input: inputId, status: "answered", note: "Other inputs of this run still wait; it resumes once they are answered" };
  return options.wait === 0 ? summarize(id, answered.request) : waitFor(api, id, answered.request.id, options.wait ?? Infinity);
}

function answerFor(input: any, value: unknown) {
  if (value === "decline" || (value === false && input.kind !== "approval" && input.kind !== "url")) return { action: "decline" };
  switch (input.kind) {
    case "approval": case "url":
      if (typeof value !== "boolean") throw new Error(`Answer ${input.kind === "approval" ? "an approval" : "a url step"} with true or false`);
      return { action: value ? "accept" : "decline" };
    case "question": {
      const questions: { question: string }[] = input.detail?.questions ?? [];
      if (typeof value === "string" || Array.isArray(value)) {
        if (questions.length !== 1) throw new Error(`This input asks ${questions.length} questions: answer with {"<question>": "<answer>"} for each`);
        return { action: "accept", content: { answers: { [questions[0].question]: value } } };
      }
      return { action: "accept", content: { answers: value } };
    }
    default: return { action: "accept", content: value };
  }
}

/** An agent's recent messages, flattened to role and text (tool calls by name), oldest first. */
export async function history(api: Api, agent: string, limit = 20) {
  const id = await api.agentId(agent);
  const page = await api.get(`/v1/agents/${enc(id)}/history?limit=${Math.max(1, Math.min(500, limit))}`);
  return { agent: id, total: page.total, messages: page.entries.map((entry: any) => ({ index: entry.index, ...flatten(entry.message) })) };
}

function flatten(message: any) {
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
  const text = content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
  const calls = content.filter((part: any) => part.type === "toolCall").map((part: any) => ({ name: part.name, arguments: part.arguments }));
  return {
    role: message.role,
    ...(message.toolName ? { tool: message.toolName } : {}),
    ...(message.from ? { from: message.from.id } : {}),
    ...(text ? { text: message.role === "toolResult" && text.length > 2000 ? `${text.slice(0, 2000)}…` : text } : {}),
    ...(calls.length ? { toolCalls: calls } : {}),
    ...(message.isError ? { isError: true } : {}),
    ...(message.errorMessage ? { error: message.errorMessage } : {}),
  };
}

/** An agent for `key` made (or found) outside a manifest: from a definition, or with its own model and prompt. */
export async function upsertAgent(api: Api, key: string, config: { definition?: string; model?: string; systemPrompt?: string; systemPromptAppend?: string; name?: string; builtins?: string[]; subject?: string; ttlSeconds?: number | null }) {
  const { definition, ...rest } = config;
  const body = { ...(definition ? { definition: await api.definitionId(definition) } : {}), ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) };
  const created = await api.call("POST", "/v1/agents", body, { "Idempotency-Key": key });
  return { key, id: created.id, expiresAt: created.expiresAt, ...(created.reconfigured ? { reconfigured: true } : {}) };
}

/** Change one agent's model, prompt or thinking level between its runs, and wait up to `wait` seconds for it to land. */
export async function configure(api: Api, agent: string, changes: Record<string, unknown>, wait = 30) {
  const id = await api.agentId(agent);
  const record = await api.call("PATCH", `/v1/agents/${enc(id)}/configuration`, { requestId: `cli_${globalThis.crypto.randomUUID()}`, ...changes });
  return waitFor(api, id, record.id, wait);
}
