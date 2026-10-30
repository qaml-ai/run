import type { ToolDefinition } from "../protocol.ts";
import { errorText, scratchMount } from "../protocol.ts";
import type { ClientEvent } from "../../shared/client-protocol.ts";
import { HttpError } from "../http.ts";
import { savedContent, ToolFiles } from "../tool-files.ts";
import { TOOL_FILE_LIMITS } from "../limits.ts";
import { VolumeService } from "../volumes.ts";
import type { Sources } from "../tool-sources.ts";
import { contentResult, type McpResult } from "../mcp-results.ts";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { compose, toolCallKey, ToolFailure, type ToolCallCode, defaultExposure, describeSources, fileServer, type Progress, type ToolCall, type ToolServer, type ToolSourceView } from "../tool-servers.ts";
import { searchTools as searchCatalog, type SearchQuery } from "../tool-search.ts";
import { declaredType, FILE_LIMITS, safeName, validFileRef, type FileRef } from "../files.ts";
import { fileRef } from "../inspect.ts";
import { resolve as resolveMount, type ToolContext } from "../volume-tools.ts";
import { argumentsHash } from "../inputs.ts";
import { safeError } from "../metrics.ts";
import type { AgentSupervisor } from "../supervisor.ts";
import * as events from "./events.ts";
import * as spend from "./spend.ts";
import * as delegation from "./delegation.ts";
import * as childSessions from "./children.ts";
import * as workflows from "./workflows.ts";
import * as humanInput from "./inputs.ts";
import { type Session, type ClientSessionOptions, type AgentRef, type UsageRecord, RUN_METHODS, validId } from "./state.ts";

const mcpBudgets = new WeakMap<Session, { id?: string; left: number }>();

export type ToolsContext = {
  options: ClientSessionOptions;
  supervisor: AgentSupervisor;
  eventContext: events.EventContext;
  spendContext: spend.SpendContext;
  delegationContext: delegation.DelegationContext;
  childrenContext: childSessions.ChildrenContext;
  inputsContext: humanInput.InputContext;
  owns(id: string, tenant: string): Promise<boolean>;
  load(id: string): Promise<Session | undefined>;
  headerFor(id: string, tenant: string): Promise<Pick<Session, "header">>;
  writeHeader(session: Session): Promise<void>;
  publish(session: Session, data: ClientEvent): void;
  beforeEffect(session: Session): Promise<void>;
  leased(session: Session, signal?: AbortSignal): Promise<void>;
  endUserCharge(agent: string, usage: UsageRecord): void;
};

/** Files written in one run that its outcome lists. */
const OUTPUT_FILES = 100;
const OUTPUT_TOOL_CALLS = 100;

/**
 * The agent's tool servers in order of precedence: the runtime feature's (a channel's
 * send_message), the application's attached server, file tools over its mounts, then its
 * definition's built-ins, OpenAPI specs and remote MCP servers.
 */
async function toolServers(ctx: ToolsContext, session: Session, tools: ToolDefinition[], sources: Sources | undefined, fileTools: boolean | undefined, codeMode = session.header.config.codeMode): Promise<ToolServer[]> {
  const header = session.header;
  const tenant = header.tenant;
  const agent: AgentRef = { id: header.id, tenant, claim: session.claim };
  const feature = await ctx.options.hooks?.server?.(agent);
  session.channel = !!feature;
  const volumes = ctx.options.volumes;
  const view = (kind: ToolSourceView["kind"], server: ToolServer, extra: Partial<ToolSourceView> = {}): ToolServer =>
    ({ ...server, sources: async () => [{ kind, name: kind, status: "listed", ...extra, tools: await server.tools() }] });
  const multiAgent = childSessions.multiAgentServer(ctx.childrenContext, session, sources);
  const workflow = workflows.workflowServer(ctx.childrenContext, session, sources);
  const images = spend.imageServer(ctx.spendContext, session, sources);
  // Sources that give tools (`decide` alone is a setting).
  const sourced = !!sources && Object.keys(sources).some(key => key !== "decide");
  // An agent with no js_exec and no tools of its own gets no decide tool unless it asks for it (decide: true).
  const plain = codeMode === false && !tools.length && !feature && !multiAgent && !workflow && !images && !sourced;
  const decisions = spend.decisionServer(ctx.spendContext, session, sources, plain);
  const definition = header.definition;
  // An agent with no tools at all (no js_exec, file tools or tools of any source) has nothing to present a file from: no present_file either.
  const bare = codeMode === false && fileTools === false && !tools.length && !feature && !multiAgent && !workflow && !images && !sourced;
  return [
    ...feature ? [view("channel", feature)] : [],
    { tools: () => defaultExposure(tools), call: call => events.callAttached(ctx.eventContext, session, call), sources: async () => [{ kind: "application", name: "application", status: "listed", connected: !!session.attached?.open, tools: defaultExposure(tools) }] },
    ...volumes && header.mounts?.length && !bare ? [view("files", fileServer(volumes.definitions().filter(tool => fileTools !== false || tool.name === "present_file"), ({ name, args, signal }) => volumes.tool(toolContext(ctx, session), name, args, signal)))] : [],
    ...multiAgent ? [multiAgent] : [],
    ...workflow ? [workflow] : [],
    ...images ? [images] : [],
    ...decisions ? [decisions] : [],
    ...ctx.options.sources ? [ctx.options.sources.server({ tenant, agent: header.id, ...(definition ? { definition: definition.id } : {}), claim: session.claim, ...(header.identity ? { identity: header.identity } : {}), mounts: () => session.header.mounts ?? [], onWrite: toolContext(ctx, session).onWrite }, sources)] : [],
  ];
}

/**
 * What the agent's file tools act as: its tenant, mounts and current model. A run's writes and
 * presented files are collected for its outcome; a presented file is also an event on the
 * agent's stream, with a signed download link, as soon as it is presented.
 */
export function toolContext(ctx: ToolsContext, session: Session): ToolContext {
  const header = session.header;
  return {
    tenant: header.tenant, agent: header.id, mounts: header.mounts ?? [], model: () => session.header.config.model, seen: session.seen ??= new Map(),
    onWrite: file => {
      const files = session.outputs?.files;
      if (files && (files.has(file.path) || files.size < OUTPUT_FILES)) files.set(file.path, file);
    },
    onPresent: (file, volumePath) => {
      const outputs = session.outputs;
      if (!outputs) throw new Error("Files can be presented only during a run");
      if (outputs.presented.length >= FILE_LIMITS.attachments) throw new Error(`At most ${FILE_LIMITS.attachments} files can be presented in a run`);
      outputs.presented.push(file);
      const request = [...session.running.values()].find(record => RUN_METHODS.includes(record.method) && record.began);
      const link = ctx.options.links?.sign({ tenant: header.tenant, volume: file.volume, path: volumePath, method: "GET" });
      ctx.publish(session, { type: "event", requestId: request?.id ?? "", event: { type: "file_presented", file, ...(link ? { url: link.url, expiresAt: link.expiresAt } : {}) } });
    },
  };
}

/**
 * The agent's tools from its servers (see `toolServers`), or from the ones `next` gives it (a configuration it is about to
 * take). Records the route, and the servers for `toolSources`.
 */
export async function toolset(ctx: ToolsContext, session: Session, next: { tools?: ToolDefinition[]; sources?: Sources; fileTools?: boolean; codeMode?: boolean; warm?: boolean } = {}) {
  const { header } = session;
  const servers = await toolServers(ctx, session, next.tools ?? header.definitions, "sources" in next ? next.sources : header.sources, "fileTools" in next ? next.fileTools : header.config.fileTools, "codeMode" in next ? next.codeMode : header.config.codeMode);
  const { tools: definitions, route } = await compose(servers);
  session.route = route;
  session.servers = servers;
  // Sources that could not be listed (down, or refusing their credentials): the model has none of their tools, so each run's outcome says so.
  const views = (await Promise.all(servers.map(server => server.sources?.({ refresh: false }).catch(() => []) ?? []))).flat();
  // Served tools are MCP sources the runtime calls with its identity tokens.
  const served = new Set((("sources" in next ? next.sources : header.sources)?.mcpServers ?? []).filter(spec => spec.auth?.type === "runtime").map(spec => spec.name));
  session.toolSources = new Map(views.flatMap(view => view.tools.map(tool => [tool.name, view.kind === "application" ? "attached" : view.kind === "mcp" && served.has(view.name) ? "served" : view.kind] as const)));
  session.sourceErrors = views.flatMap(view => view.status === "error" ? [{ kind: view.kind, source: view.name, message: view.error ?? "Could not be listed" }] : []);
  session.searchable = definitions.filter(tool => tool.exposure !== "direct");
  // Rerankers that index the catalog (embeddings) start now, so the first search need not wait; the agent's tenant pays for it at cost.
  if (next.warm !== false) for (const stage of ctx.options.rerankers ?? []) stage.warm?.(session.searchable, usd => toolSearchUsage(ctx, session, usd, 0));
  return definitions;
}

/**
 * What each of a tenant's agent's tool sources offers, and which tools its model gets. A running
 * agent shows the lists its tools were built from; otherwise MCP servers show what this node last
 * listed, or `unlisted`. `refresh` lists every MCP server now, connecting to it: what the servers
 * offer at this moment, which a running agent takes at its next start or reconfiguration.
 */
export async function toolSources(ctx: ToolsContext, id: string, tenant: string, options: { refresh?: boolean; schemas?: boolean } = {}) {
  const session = (await ctx.owns(id, tenant)) ? await ctx.load(id) : undefined;
  if (!session) throw new HttpError(404, "Agent not found");
  const servers = ctx.supervisor.agents.has(id) && session.servers ? session.servers : await toolServers(ctx, session, session.header.definitions, session.header.sources, session.header.config.fileTools);
  const sources = (await Promise.all(servers.map(server => server.sources?.({ refresh: options.refresh }) ?? [])));
  return describeSources(sources.flat(), options.schemas);
}

/**
 * Answer one of the agent's tool calls through the server that lists it, once the run's start is
 * durable. A tool that asks for human input (MCP's `input_required`, or the runtime's approval
 * policy and ask_user in that form) suspends the call instead (`suspend`). In a `resume` run, a
 * call the person answered runs again with their answers, and only with the same arguments.
 */
export async function callTool(ctx: ToolsContext, session: Session, call: ToolCall) {
  let code: ToolCallCode | undefined;
  let answer: Awaited<ReturnType<typeof answerToolCall>> | undefined;
  try {
    answer = await answerToolCall(ctx, session, call);
    code = "inputRequired" in answer ? "input_required" : "isError" in answer && answer.isError ? "tool_error" : undefined;
    return answer;
  } catch (error) {
    code = call.signal.aborted ? "aborted" : error instanceof ToolFailure ? error.code : "failed";
    throw error;
  } finally {
    // Listed in the run's outcome (`toolCalls`), ids only: its arguments and result are in history.
    const calls = session.toolCalls ??= [];
    // A call that started a child (delegate, spawn_agent, a tool's spawn directive) names it.
    const child = call.toolCallId && !call.innerCallId ? session.children?.get(call.toolCallId)?.agent : undefined;
    if (calls.length < OUTPUT_TOOL_CALLS) calls.push({ tool: call.name, ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}), ...(call.innerCallId ? { innerCallId: call.innerCallId } : {}), ok: !code, ...(code ? { code } : {}), ...(child ? { agentId: child } : {}) });
  }
}

async function answerToolCall(ctx: ToolsContext, session: Session, call: ToolCall) {
  const server = session.route?.get(call.name);
  if (!server) throw new Error(`Unknown tool ${call.name}`);
  const request = [...session.running.values()].find(r => RUN_METHODS.includes(r.method) && r.began);
  const plan = call.toolCallId && !call.innerCallId ? session.retries?.get(call.toolCallId) : undefined;
  if (plan && plan.argumentsHash !== argumentsHash(call.name, call.args)) throw new Error("These are not the arguments the user answered for; the call did not run");
  const origin = await ctx.options.hooks?.origin?.({ id: session.header.id, tenant: session.header.tenant, claim: session.claim }, request?.id);
  const lineage = delegation.lineage(ctx.delegationContext, session, request);
  await ctx.beforeEffect(session);
  await ctx.leased(session, call.signal);
  // A server's progress reaches the event stream as an update of the model's tool call (js_exec's, for a call from code),
  // at most one per PROGRESS_MS: the latest of a burst is published at its window's end, and before the call's result.
  let progressed: (() => void) | undefined;
  const onProgress = call.toolCallId ? events.throttled(({ progress, total, message }: Progress) => ctx.publish(session, { type: "event", requestId: request?.id ?? "", event: {
    type: "tool_execution_update", toolCallId: call.toolCallId, toolName: call.innerCallId ? "js_exec" : call.name,
    partialResult: { content: [{ type: "text", text: message ?? `${progress}${total !== undefined ? `/${total}` : ""}` }], details: { type: "progress", tool: call.name, ...(call.innerCallId ? { innerCallId: call.innerCallId } : {}), progress, ...(total !== undefined ? { total } : {}), ...(message !== undefined ? { message } : {}) } },
  } }), flush => { progressed = flush; }) : undefined;
  let result: McpResult;
  try {
    result = await recordingFailures(session, call, () => server.call({
      ...call, ...(request ? { run: request.id } : {}), ...(origin ? { origin } : {}), ...(request?.actor ? { actor: request.actor } : {}), ...(onProgress ? { onProgress } : {}),
      ...(call.toolCallId ? { idempotencyKey: toolCallKey(session.header.id, call.messageIndex, call.toolCallId, call.innerCallId) } : {}),
      ...(plan?.approval ? { approval: { input: plan.approval.input, by: humanInput.approver(plan.approval.by), at: plan.approval.at } } : {}),
      ...(plan?.inputResponses ? { inputResponses: plan.inputResponses } : {}), ...(plan?.requestState !== undefined ? { requestState: plan.requestState } : {}),
      ...(humanInput.humanSurface(session) ? { elicit: true } : {}), ...(lineage ? { lineage } : {}),
    }));
  } catch (error) {
    progressed?.();
    // MCP's older form of a URL step (-32042): the user opens each URL, then the call is retried.
    const elicitations = error instanceof McpError && error.code === -32042 ? (error.data as { elicitations?: unknown[] } | undefined)?.elicitations : undefined;
    if (!Array.isArray(elicitations) || !elicitations.length) throw error;
    result = { resultType: "input_required", inputRequests: Object.fromEntries(elicitations.map((params, index) => [`url_${index}`, { method: "elicitation/create", params: { ...params as object, mode: "url" } }])) };
  }
  progressed?.();
  if (result.resultType === "input_required") return humanInput.suspend(ctx.inputsContext, session, call, request, result);
  // A trusted tool prepared a sub-agent: its directive replaces the result (`toolSpawn`).
  const directive = (result as { _meta?: Record<string, unknown> })._meta?.["camelrun/spawn"];
  if (directive !== undefined) return childSessions.toolSpawn(ctx.childrenContext, session, { ...call, ...(call.toolCallId ? { idempotencyKey: toolCallKey(session.header.id, call.messageIndex, call.toolCallId, call.innerCallId) } : {}) }, directive);
  if (!server.returnsFiles && ctx.options.volumes) {
    let budget = mcpBudgets.get(session);
    if (!budget || budget.id !== request?.id) { budget = { id: request?.id, left: TOOL_FILE_LIMITS.runBytes }; mcpBudgets.set(session, budget); }
    const context = toolContext(ctx, session);
    const files = new ToolFiles({ volumes: ctx.options.volumes, ...context, tool: call.name, run: budget });
    result = await savedContent(result, files);
  }
  const content = contentResult(result, server.returnsFiles);
  // The model learns who answered, and how long ago: it should check what may have changed meanwhile.
  if (plan) content.content.push({ type: "text", text: plan.note });
  // Its background children's progress since it last saw it rides on the model's next result (never a script's).
  const updates = call.innerCallId ? undefined : await childSessions.pendingUpdates(ctx.childrenContext, session).catch(error => {
    console.error(JSON.stringify({ type: "agent_updates_failed", agent: session.header.id, error: safeError(error) }));
    return undefined;
  });
  if (updates) (content.content as object[]).push(updates);
  return content;
}

/**
 * Run a tool call, recording in the run's outcome (`toolErrors`) why it did not complete, if it did not: so a
 * caller sees a call that timed out, found no application connected, or could not reach its server, and not only the model.
 */
async function recordingFailures<T>(session: Session, call: ToolCall, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (call.signal.aborted || (error instanceof McpError && error.code === -32042)) throw error;
    const failure = error instanceof ToolFailure ? error
      : error instanceof McpError && error.code === ErrorCode.RequestTimeout ? new ToolFailure("timeout", `${error.message}. Its outcome is unknown: it may or may not have taken effect.`, true)
      : error instanceof McpError && error.code === ErrorCode.ConnectionClosed ? new ToolFailure("connection_lost", events.CONNECTION_LOST, true)
      : /^Could not connect to MCP server|MCP server .* (?:failed|refused|answered)/.test(errorText(error)) ? new ToolFailure("source_unavailable", errorText(error))
      : new ToolFailure("failed", errorText(error));
    (session.toolErrors ??= []).push({ tool: call.name, ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}), ...(call.innerCallId ? { innerCallId: call.innerCallId } : {}),
      code: failure.code, ...(failure.outcomeUnknown ? { outcomeUnknown: true } : {}), message: failure.message });
    throw failure;
  }
}

/**
 * Replace a tenant's agent's mounts: they apply from its next tool call (see `remount`).
 */
export async function setMounts(ctx: ToolsContext, id: string, tenant: string, requested: unknown) {
  const session = (await ctx.owns(id, tenant)) ? await ctx.load(id) : undefined;
  if (!session) throw new HttpError(404, "Unknown agent");
  return remount(ctx, session, requested);
}

/**
 * Set an agent's mounts (`requested`, as given). They apply from the agent's next tool call (a call under way keeps
 * the mounts it began with), so a turn can swap a mount and go on working in it; the next run starts the agent again,
 * so its prompt describes them (`run`).
 */
export async function remount(ctx: ToolsContext, session: Session, requested: unknown) {
  if (!ctx.options.volumes) throw new HttpError(404, "Volumes are not enabled on this runtime");
  const { id, tenant } = session.header;
  const mounts = await ctx.options.volumes.mountsFor(tenant, id, requested ?? []);
  await ctx.options.volumes.watch(id, tenant, session.header.mounts ?? [], mounts, session.claim);
  session.header.mounts = mounts;
  await ctx.writeHeader(session);
  return mounts;
}

/**
 * Where a request's attachments go: `uploads/<request>/<name>` in the agent's workspace (`scratchMount`).
 * Requests have their own directories, so names only collide within one.
 */
function uploadTarget(ctx: ToolsContext, session: Pick<Session, "header">, requestId: string, name: string) {
  const mounts = session.header.mounts ?? [];
  const mount = scratchMount(VolumeService.markWorkspace(session.header.id, mounts));
  if (!ctx.options.volumes || !mount) throw new HttpError(400, "Attaching files needs a writable mount, like the default /workspace");
  if (!validId(requestId)) throw new HttpError(400, "Invalid request id");
  return resolveMount(mounts, `${mount.path}/uploads/${requestId}/${safeName(name)}`)!;
}

/** Save an attachment for request `requestId` ahead of it (the SDKs upload files this way, then reference them by path). */
export async function upload(ctx: ToolsContext, session: Pick<Session, "header">, requestId: string, name: string, source: Uint8Array | AsyncIterable<Uint8Array>, contentType?: string) {
  const target = uploadTarget(ctx, session, requestId, name);
  const { chunks: _chunks, path, ...entry } = await ctx.options.volumes!.put(session.header.tenant, target.mount.volumeId, target.path, source, { contentType, by: session.header.id });
  return { path: target.show(path), ...entry };
}

/** A signed link to a file in the agent's mounts (`POST /clients/:id/links`, `POST /v1/agents/:id/links`): as a volume link, by the agent's path. */
export function signLink(ctx: ToolsContext, session: Pick<Session, "header">, input: any) {
  const method = input?.method ?? "GET";
  if (method !== "GET" && method !== "PUT") throw new HttpError(400, "method must be GET or PUT");
  const target = mounted(ctx, session, input?.path, method === "PUT");
  if (!ctx.options.links) throw new HttpError(404, "Links are not enabled on this runtime");
  const contentType = input.contentType === undefined ? undefined : declaredType(input.contentType);
  if (input.contentType !== undefined && !contentType) throw new HttpError(400, "contentType must be a specific content type");
  const { tenant: _tenant, volume: _volume, path: _path, ...link } = ctx.options.links.sign({ tenant: session.header.tenant, volume: target.mount.volumeId, path: target.path, method, expiresIn: input.expiresIn, ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}), ...(contentType ? { contentType } : {}) });
  return { ...link, path: target.show(target.path) };
}

/** A tenant's signed link to a file of its agent's, as the agent would sign it (`POST /v1/agents/:id/links`). */
export async function agentLink(ctx: ToolsContext, id: string, tenant: string, input: unknown) {
  return signLink(ctx, await ctx.headerFor(id, tenant), input);
}

/** A path as the agent sees it, resolved to its mount (writable, for `write`). */
export function mounted(ctx: ToolsContext, session: Pick<Session, "header">, path: unknown, write = false) {
  if (!ctx.options.volumes) throw new HttpError(404, "Volumes are not enabled on this runtime");
  let target;
  try { target = resolveMount(session.header.mounts ?? [], path); } catch (error) { throw new HttpError(400, errorText(error)); }
  if (!target) throw new HttpError(400, "Name a path inside one of the agent's mounts");
  if (write && target.mount.mode !== "rw") throw new HttpError(403, `${target.mount.path} is mounted read-only`);
  return target;
}

/** `upload` for a tenant's agent (REST API, channels). */
export async function uploadFor(ctx: ToolsContext, id: string, tenant: string, requestId: string, name: string, source: AsyncIterable<Uint8Array>, contentType?: string) {
  return upload(ctx, await ctx.headerFor(id, tenant), requestId, name, source, contentType);
}

/** A file in a tenant's agent's mounts, as a reference (channels' send_message). */
export async function fileFor(ctx: ToolsContext, id: string, tenant: string, path: string) {
  return pathRef(ctx, await ctx.headerFor(id, tenant), path);
}

/** A signed download link to a file in a tenant's agent's mounts. */
export async function linkFor(ctx: ToolsContext, id: string, tenant: string, path: string, expiresIn?: number) {
  const session = await ctx.headerFor(id, tenant);
  const target = mounted(ctx, session, path);
  if (!ctx.options.links) throw new HttpError(404, "Links are not enabled on this runtime");
  return ctx.options.links.sign({ tenant, volume: target.mount.volumeId, path: target.path, method: "GET", expiresIn });
}

/** A file already in the agent's mounts, as a reference. */
async function pathRef(ctx: ToolsContext, session: Pick<Session, "header">, path: string): Promise<FileRef> {
  const volumes = ctx.options.volumes;
  if (!volumes) throw new HttpError(400, "Volumes are not enabled on this runtime");
  const tenant = session.header.tenant;
  let target;
  try { target = resolveMount(session.header.mounts ?? [], path); } catch (error) { throw new HttpError(400, errorText(error)); }
  if (!target) throw new HttpError(400, "Attach a file, not /");
  const entry = await volumes.call(target.mount.volumeId, tenant, "stat", { path: target.path }).catch(error => { throw (error as HttpError).status === 404 ? new HttpError(400, `${target.show(target.path)} does not exist`) : error; });
  if (entry.type !== "file") throw new HttpError(400, `${target.show(target.path)} is a directory`);
  return fileRef(volumes, tenant, session.header.id, target.mount.volumeId, target.show(entry.path), { ...entry, contentType: await volumes.contentType(tenant, entry.path, entry) });
}

/**
 * A message's attachments as file references: files already in the agent's mounts ({path}), and
 * small files sent inline ({name, data: base64, contentType?}), saved first.
 * Everything is checked before anything is saved.
 */
export async function attach(ctx: ToolsContext, session: Session, requestId: string, inputs: unknown): Promise<FileRef[]> {
  if (!Array.isArray(inputs)) throw new HttpError(400, "files must be an array");
  if (inputs.length > FILE_LIMITS.attachments) throw new HttpError(400, `At most ${FILE_LIMITS.attachments} files can be attached to a message`);
  let inline = 0;
  const names = new Set<string>();
  const checked = inputs.map((input, index) => {
    const { transcribe, ...file } = input && typeof input === "object" ? input : {} as Record<string, unknown>;
    if (transcribe !== undefined && typeof transcribe !== "boolean") throw new HttpError(400, "transcribe is true or false");
    const asked = transcribe === undefined ? {} : { transcribe: transcribe as boolean };
    if (Object.keys(file).length === 1 && typeof file.path === "string") return { path: file.path as string, ...asked };
    const { name, data, url, contentType, ...rest } = file;
    if ((typeof data === "string") === (typeof url === "string") || (typeof data === "string" && !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) || Object.keys(rest).length || (name !== undefined && typeof name !== "string") || (contentType !== undefined && typeof contentType !== "string")) {
      throw new HttpError(400, "An attached file is {path} (a file in the agent's mounts), {name, data (base64), contentType?} or {url, name?, contentType?}, each with transcribe?");
    }
    let address: URL | undefined;
    if (typeof url === "string") {
      try { address = new URL(url); } catch { throw new HttpError(400, "An attached file's url must be an absolute https URL"); }
      if (!ctx.options.outbound) throw new HttpError(400, "Attaching files by URL is not enabled on this runtime");
    } else {
      inline += Math.floor((data as string).length * 3 / 4);
      if (inline > FILE_LIMITS.inlineBytes) throw new HttpError(413, `Inline files are limited to ${FILE_LIMITS.inlineBytes} bytes in all; upload larger ones first and attach them by path`);
    }
    // Two files of one name in a request become name, name-2, ...
    const base = safeName(name ?? (address ? decodeURIComponent(address.pathname.split("/").pop() ?? "") : undefined), `attachment-${index + 1}`);
    let unique = base;
    for (let n = 2; names.has(unique); n++) unique = base.replace(/(\.[^.]*)?$/, extension => `-${n}${extension}`);
    names.add(unique);
    return { name: unique, ...(address ? { url: address } : { data: data as string }), contentType: contentType as string | undefined, ...asked };
  });
  const volumes = ctx.options.volumes;
  if (checked.length && !volumes) throw new HttpError(400, "Volumes are not enabled on this runtime");
  const tenant = session.header.tenant;
  const refs: (FileRef & { transcribe?: boolean })[] = [];
  for (const input of checked) {
    const asked = input.transcribe === undefined ? {} : { transcribe: input.transcribe };
    if ("path" in input) { refs.push({ ...await pathRef(ctx, session, input.path as string), ...asked }); continue; }
    const target = uploadTarget(ctx, session, requestId, input.name);
    const { body, contentType } = "url" in input ? await fetchAttachment(ctx, input.url) : { body: Buffer.from(input.data, "base64"), contentType: undefined };
    const saved = await volumes!.put(tenant, target.mount.volumeId, target.path, body, { contentType: input.contentType ?? contentType, by: session.header.id });
    refs.push({ ...await fileRef(volumes!, tenant, session.header.id, target.mount.volumeId, target.show(saved.path), { ...saved, contentType: saved.contentType! }), ...asked });
  }
  return refs;
}

/** A file attached by URL: fetched from the public internet (the outbound guard), at most FILE_LIMITS.urlBytes, streamed to the volume. */
async function fetchAttachment(ctx: ToolsContext, url: URL): Promise<{ body: AsyncIterable<Uint8Array>; contentType?: string }> {
  let response: Response;
  try { response = await ctx.options.outbound!.fetch(url, { timeoutMs: FILE_LIMITS.urlMs, maxBytes: FILE_LIMITS.urlBytes, maxRedirects: FILE_LIMITS.urlRedirects }); }
  catch (error) { throw new HttpError(400, `Could not fetch ${url.origin}${url.pathname} (${errorText(error).slice(0, 200)})`); }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new HttpError(400, `Could not fetch ${url.origin}${url.pathname} (HTTP ${response.status})`);
  }
  const contentType = declaredType(response.headers.get("content-type"));
  const length = Number(response.headers.get("content-length"));
  if (length > FILE_LIMITS.urlBytes) { await response.body.cancel(); throw new HttpError(413, `A file attached by URL may be at most ${FILE_LIMITS.urlBytes} bytes`); }
  const stream = response.body;
  const body = async function* () {
    try { for await (const chunk of stream) yield chunk as Uint8Array; }
    catch (error) { throw new HttpError(/larger than/.test(errorText(error)) ? 413 : 400, `Could not fetch ${url.origin}${url.pathname} (${errorText(error).slice(0, 200)})`); }
  };
  return { body: body(), ...(contentType ? { contentType } : {}) };
}

/** js_exec's `fs`: the file tools over the agent's mounts, durable before any effect like any other tool call. */
export async function fsCall(ctx: ToolsContext, session: Session, op: string, args: Record<string, unknown>, signal: AbortSignal) {
  if (!ctx.options.volumes || !session.header.mounts?.length) throw new Error("This agent has no volumes mounted");
  if (!["readFile", "writeFile", "stat", "list", "remove"].includes(op)) throw new Error("Unknown fs call");
  await ctx.beforeEffect(session);
  return ctx.options.volumes.tool(toolContext(ctx, session), `fs.${op}`, args, signal);
}

/** A referenced file's bytes for the agent's model request, as base64 (only sizes a model can be shown). */
export async function fileData(ctx: ToolsContext, session: Session, ref: unknown) {
  if (!validFileRef(ref) || ref.size > Math.max(FILE_LIMITS.imageBytes, FILE_LIMITS.documentBytes) || !ctx.options.volumes) throw new Error("Invalid file reference");
  return (await ctx.options.volumes.readRange(session.header.tenant, ref, 0, ref.size)).toString("base64");
}

/**
 * A `tools.search` query over the agent's code-mode tools; a rerank stage that fails is logged and
 * left out. Ranking by meaning is platform usage at what its providers charged: the tenant pays
 * the runtime, never with its own keys, so which provider serves it stays the runtime's choice.
 */
export function searchTools(ctx: ToolsContext, session: Session, query: SearchQuery) {
  return searchCatalog(session.searchable ?? [], query, {
    rerankers: ctx.options.rerankers ?? [],
    onError: (error, stage) => console.error(JSON.stringify({ type: "tool_search_rerank_failed", reranker: stage.kind, agent: session.header.id, error: safeError(error) })),
    onRanked: ({ cost }) => toolSearchUsage(ctx, session, cost, 1),
  });
}

function toolSearchUsage(ctx: ToolsContext, session: Session, usd: number, searches: number) {
  const usage: UsageRecord = { provider: "runtime", model: "tool_search", usage: { cost: { total: usd } }, platform: true, toolSearch: true, toolSearches: searches };
  ctx.options.onUsage?.(session.header.tenant, session.header.id, usage);
  ctx.endUserCharge(session.header.id, usage);
}
