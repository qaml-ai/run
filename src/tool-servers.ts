import { createHash } from "node:crypto";
import type { ToolDefinition } from "./protocol.ts";
import type { McpResult } from "./mcp-results.ts";
import { compiles, validateDefinitions } from "./tool-policy.ts";
import { CATALOG_LIMITS } from "./limits.ts";
import { validFileRef } from "./files.ts";

/**
 * A tool call as a server gets it; `toolCallId` is the model's id for the call (for a call from
 * js_exec, the js_exec call's, and `innerCallId` this call's within it), `run` the id of the
 * run it is made in, `origin` where the turn came from (a channel and its sender), and `actor` who
 * the application said is acting in it: set by the runtime, never by the model, so tools can authorize.
 * `onProgress` hears the server's progress notifications for the call.
 */
export type ToolCall = {
  name: string; args: Record<string, unknown>; signal: AbortSignal; toolCallId?: string; innerCallId?: string; messageIndex?: number; run?: string; origin?: Record<string, unknown>; actor?: string;
  /** The same for every attempt of this call (a retry, a call run again after a person answered): a tool dedupes its effect by it. */
  idempotencyKey?: string;
  onProgress?: (progress: Progress) => void;
  /** A call run again after a person answered (inputs.ts): proof of their approval, and the answers to the tool's own requests. */
  approval?: { input: string; by: Record<string, unknown>; at: number }; inputResponses?: Record<string, unknown>; requestState?: string;
  /** The agent has someone to ask: the call may answer MCP's `input_required` with elicitations. */
  elicit?: boolean;
};
/**
 * A call's idempotency key: the agent, the history index of the message that made the call, the model's id for it,
 * and its place in js_exec's code, hashed. The index matters: providers may number calls per response (call_0...).
 */
export function toolCallKey(agent: string, messageIndex: number | undefined, toolCallId: string, innerCallId?: string) {
  return createHash("sha256").update(`${agent}:${messageIndex ?? ""}:${toolCallId}:${innerCallId ?? ""}`).digest("hex").slice(0, 32);
}

/** What a tool server is told about a call in its `_meta`: the call's ids and idempotency key, where its turn came from and who acts in it. */
export function callMeta({ toolCallId, innerCallId, idempotencyKey, origin, actor }: Pick<ToolCall, "toolCallId" | "innerCallId" | "idempotencyKey" | "origin" | "actor">) {
  return {
    ...(toolCallId ? { "agent-runtime/toolCallId": toolCallId } : {}), ...(innerCallId ? { "agent-runtime/innerCallId": innerCallId } : {}),
    ...(idempotencyKey ? { "agent-runtime/idempotencyKey": idempotencyKey } : {}),
    ...(origin ? { "agent-runtime/origin": origin } : {}), ...(actor ? { "agent-runtime/actor": actor } : {}),
  };
}
/** Tool calls' deadlines: how long a call may go without an answer (each progress notification restarts it), and in all. */
export const TOOL_DEADLINES = Object.freeze({ attachedMs: 15_000, remoteMs: 60_000, minMs: 1_000, maxTotalMs: 1_200_000 });

/**
 * Why a tool call did not complete, as a run's outcome lists it (`toolErrors`): `timeout` (no answer by its deadline),
 * `connection_lost` (the connection it was sent on closed), both with `outcomeUnknown`; `not_connected` (no application
 * attached to answer it: it did not run); `source_unavailable` (its server could not be reached, listed or authenticated
 * with); `failed` (anything else that kept it from running or answering).
 */
export type ToolErrorCode = "timeout" | "connection_lost" | "not_connected" | "source_unavailable" | "failed";
export type ToolError = { tool: string; toolCallId?: string; innerCallId?: string; code: ToolErrorCode; outcomeUnknown?: true; message: string };
/**
 * A tool call a run made, as its outcome lists it (`toolCalls`): which tool, and whether it answered (`ok`) or why not:
 * a `ToolErrorCode`, `tool_error` (it answered with an error), `input_required` (it waits on a person) or `aborted`.
 * Its arguments and result are in history, not here.
 */
export type ToolCallCode = ToolErrorCode | "tool_error" | "input_required" | "aborted";
export type RunToolCall = { tool: string; toolCallId?: string; innerCallId?: string; ok: boolean; code?: ToolCallCode };
export class ToolFailure extends Error {
  readonly code: ToolErrorCode;
  readonly outcomeUnknown: boolean;
  constructor(code: ToolErrorCode, message: string, outcomeUnknown = false) { super(message); this.code = code; this.outcomeUnknown = outcomeUnknown; }
}
/** A call that timed out after being sent: whatever it did may or may not have happened. */
export function timedOut(ms: number) {
  return new ToolFailure("timeout", `No answer within ${ms} ms, its deadline (progress notifications extend it, up to ${TOOL_DEADLINES.maxTotalMs / 60_000} minutes in all). Its outcome is unknown: it may or may not have taken effect.`, true);
}
/** A tool's own deadline, from its `_meta["agent-runtime/timeoutMs"]`, if it gives a valid one. */
export function declaredTimeout(meta: Record<string, unknown> | undefined): number | undefined {
  const value = meta?.["agent-runtime/timeoutMs"];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < TOOL_DEADLINES.minMs || (value as number) > TOOL_DEADLINES.maxTotalMs) throw new Error(`agent-runtime/timeoutMs must be an integer from ${TOOL_DEADLINES.minMs} to ${TOOL_DEADLINES.maxTotalMs}`);
  return value as number;
}

/** An MCP `notifications/progress`: `progress` rises, `total` if known, `message` for people. */
export type Progress = { progress: number; total?: number; message?: string };

/**
 * The one interface every source of an agent's tools answers through, shaped like MCP's
 * tools/list and tools/call: the runtime's file tools and built-ins, a channel's
 * send_message, a definition's remote MCP servers, and the application's attached server.
 */
export interface ToolServer {
  tools(): ToolDefinition[] | Promise<ToolDefinition[]>;
  call(call: ToolCall): Promise<McpResult>;
  /**
   * What each of its sources offers, for callers to see (GET /v1/agents/:id): from what is already
   * known, unless `refresh` lists remote sources now. Without it, the server shows as one source.
   */
  sources?(options: { refresh?: boolean }): Promise<ToolSourceView[]>;
  /** Its results may carry file references (files.ts): only the runtime's own file tools, never a remote or application server. */
  returnsFiles?: boolean;
}

/** One source of an agent's tools and what it offers, as callers see it. */
export interface ToolSourceView {
  kind: "channel" | "application" | "files" | "builtin" | "mcp" | "openapi";
  name: string;
  /** listed: its tools are known; unlisted: an MCP server this node has not listed yet; error: listing it failed. */
  status: "listed" | "unlisted" | "error";
  error?: string;
  /** When an MCP server was last listed (or its listing failed). */
  listedAt?: number;
  /** The application source: whether the application is connected to answer its tools. */
  connected?: boolean;
  url?: string;
  exposure?: ToolDefinition["exposure"];
  tools: ToolDefinition[];
}

/** A plain value as an MCP result: its JSON as text, and as structured content when it is an object. */
export function jsonResult(value: unknown): McpResult {
  const structured = !!value && typeof value === "object" && !Array.isArray(value);
  return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }], ...(structured ? { structuredContent: value } : {}) };
}

/** A server for tools the runtime answers with plain values. */
export function valueServer(tools: ToolDefinition[], run: (call: ToolCall) => Promise<unknown>): ToolServer {
  return { tools: () => tools, call: async call => jsonResult(await run(call)) };
}

/** The runtime's file tools: a value with a `file` reference (an image or PDF `read` shows) keeps it as a block of its own. */
export function fileServer(tools: ToolDefinition[], run: (call: ToolCall) => Promise<unknown>): ToolServer {
  return {
    tools: () => tools, returnsFiles: true,
    call: async call => {
      const value = await run(call) as { file?: unknown } | undefined;
      if (!validFileRef(value?.file)) return jsonResult(value);
      const { file, ...rest } = value;
      return { content: [{ type: "text", text: JSON.stringify(rest) }, file], structuredContent: rest };
    },
  };
}

const BUDGET = { count: CATALOG_LIMITS.tools, bytes: CATALOG_LIMITS.bytes };
/** A source with at most this many tools offers them to the model directly as well as from js_exec. */
export const SMALL_SOURCE = 10;

/**
 * A source's tools with its default exposure where they set none: a few tools are declared
 * to the model directly as well (a call costs one step, not a discovery in js_exec first);
 * many are reached from js_exec only, so they do not crowd the model's context.
 */
export function defaultExposure(tools: ToolDefinition[], exposure?: ToolDefinition["exposure"]): ToolDefinition[] {
  const chosen = exposure ?? (tools.length <= SMALL_SOURCE ? "both" : "codemode");
  return tools.map(tool => tool.exposure ? tool : { ...tool, exposure: chosen });
}

/**
 * The catalog's rules, applied to tools in order of precedence: a name an earlier tool has is
 * left out, as is a tool that is invalid or past the catalog's limits. `visit` sees every tool,
 * with the reason it is left out, if it is.
 */
function select(lists: ToolDefinition[][], visit: (list: number, tool: ToolDefinition, excluded?: string) => void) {
  const names = new Set<string>();
  let bytes = 0, direct = 0;
  lists.forEach((list, index) => {
    for (const listed of list) {
      const tool: ToolDefinition = { ...listed, resultFormat: "content" };
      const size = Buffer.byteLength(JSON.stringify(tool)) + 1;
      const excluded = names.has(tool.name) ? "an earlier source has a tool of this name"
        : names.size >= BUDGET.count ? `past the catalog's limit of ${BUDGET.count} tools`
        : bytes + size > BUDGET.bytes ? `past the catalog's limit of ${BUDGET.bytes / 1024} KiB`
        : !valid(tool) ? "its name or input schema is not valid" : undefined;
      if (!excluded) { names.add(tool.name); bytes += size; }
      // Past the model's budget of direct tools, tools offered both ways are reached from js_exec
      // only, earlier servers keeping theirs: many small sources must not crowd the model's context.
      if (!excluded && (tool.exposure === "direct" || tool.exposure === "both")) {
        if (direct < CATALOG_LIMITS.direct || tool.exposure === "direct") direct++;
        else tool.exposure = "codemode";
      }
      visit(index, tool, excluded);
    }
  });
}
function valid(tool: ToolDefinition) {
  try { validateDefinitions([tool]); } catch { return false; }
  return compiles(tool.parameters);
}

/**
 * An agent's tools from its servers in order of precedence (see `select`). Every tool answers
 * with an MCP result; `route` sends each call to the server that listed it.
 */
export async function compose(servers: ToolServer[]): Promise<{ tools: ToolDefinition[]; route: Map<string, ToolServer> }> {
  const lists = await Promise.all(servers.map(server => server.tools()));
  const tools: ToolDefinition[] = [];
  const route = new Map<string, ToolServer>();
  select(lists, (index, tool, excluded) => {
    if (excluded) return;
    route.set(tool.name, servers[index]);
    tools.push(tool);
  });
  return { tools, route };
}

/**
 * Sources as callers see them: each tool marked with why the model does not get it, if it
 * does not, and its input schema left out unless `schemas`.
 */
export function describeSources(sources: ToolSourceView[], schemas = false) {
  const views = sources.map(source => ({ ...source, tools: [] as (Omit<ToolDefinition, "parameters" | "resultFormat"> & { parameters?: Record<string, unknown>; excluded?: string })[] }));
  select(sources.map(source => source.tools), (index, { resultFormat: _format, parameters, ...tool }, excluded) => {
    views[index].tools.push({ ...tool, ...(schemas ? { parameters } : {}), ...(excluded ? { excluded } : {}) });
  });
  return views;
}
