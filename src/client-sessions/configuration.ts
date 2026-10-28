import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createHmac, randomUUID } from "node:crypto";
import type { AgentConfig, Credentials, ToolDefinition } from "../protocol.ts";
import type { AgentSupervisor } from "../supervisor.ts";
import { configurationRefusal, configurationUpdate } from "../session-config.ts";
import { validateDefinitions } from "../tool-policy.ts";
import { canonical } from "../../shared/durable-json.ts";
import type { Storage } from "../../shared/storage.ts";
import { agentMetadata, type AgentMetadata } from "../../shared/agent-metadata.ts";
import { HttpError } from "../http.ts";
import { VolumeService } from "../volumes.ts";
import type { Db } from "../db.ts";
import { NotOwner, type Claim } from "../ownership.ts";
import { OVERRIDES, type DefinitionRef } from "../definitions.ts";
import { mcpServerView, type McpServerSpec, type Sources } from "../tool-sources.ts";
import { builtinsInput } from "../builtins.ts";
import type { AgentIdentity } from "../identity.ts";
import { validFileRef } from "../files.ts";
import { safeError, Steps } from "../metrics.ts";
import { delegateSettings, limitsOnly, startsChildren, type DelegateSettings } from "../multi-agent.ts";
import { decideInput } from "../decisions.ts";
import * as events from "./events.ts";
import * as spend from "./spend.ts";
import * as delegation from "./delegation.ts";
import * as sessionTools from "./tools.ts";
import { type SessionHeader, type RunSettings, type ForkedFrom, type JournalRecord, type Session, type ClientSessionOptions, type DefinitionConfig, validSessionId, validId, hash, expired, activityOf, visible, runningRun } from "./state.ts";

export type ConfigurationContext = {
  options: ClientSessionOptions;
  db: Db;
  supervisor: AgentSupervisor;
  storage: Storage;
  sessions: Map<string, Session>;
  loading: Map<string, Promise<Session | undefined>>;
  creatingRuns: Set<string>;
  eventBlock: number;
  toolsContext: sessionTools.ToolsContext;
  spendContext: spend.SpendContext;
  delegationContext: delegation.DelegationContext;
  load(id: string): Promise<Session | undefined>;
  readHeader(id: string): Promise<{ value: SessionHeader; revision: number } | undefined>;
  writeHeader(session: Session): Promise<void>;
  ownerElsewhere(id: string): Promise<string | undefined>;
  makeRoom(id: string, tenant: string, run?: boolean): Promise<void>;
  journalKey(id: string): string;
  seedFork(id: string, claim: Claim | undefined, fork: { messages: AgentMessage[]; turns: number[]; model: Message[] }): Promise<void>;
  setSpendLimit(session: Session, usd: number | null): Promise<void>;
  ensureStarted(session: Session): Promise<any>;
  discard(session: Session): Promise<void>;
  owns(id: string, tenant: string): Promise<boolean>;
  busy(session: Session): boolean;
  spendOf: spend.SpendContext["spendOf"];
};

export async function resolveApiKey(ctx: ConfigurationContext, session: Session, provider: string, keyScope: string | undefined): Promise<{ key?: string; platform: boolean }> {
  const resolved = await ctx.options.apiKeyFor?.(session.header.tenant, provider, keyScope);
  return typeof resolved === "object" ? resolved : { key: resolved, platform: false };
}

/**
 * An upsert's target for an existing agent: a `configure` request's parameters carrying the whole configuration
 * asked for, and its provision hash. It is queued whether or not the agent has it already (an earlier upsert may be
 * queued), so the last upsert wins; when it runs, what the agent already has is left (see `upsertChanges`). What
 * configuration cannot change (who it acts for, its definition, its mounts) is refused now; initialMessages only
 * apply when an agent is made.
 */
function reconfiguration(header: SessionHeader, definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools" | "apiKey">, metadata: AgentMetadata,
  mounts: unknown, origin: { definition: DefinitionRef } | undefined, identity: AgentIdentity | undefined, provisionHash: string, own: Pick<Sources, "builtins" | "delegate" | "mcpServers" | "decide"> = {}, remount = false) {
  const differs = (a: unknown, b: unknown) => canonical(a ?? null) !== canonical(b ?? null);
  const remounted = mounts !== undefined && differs((header.mounts ?? []).map(({ volumeId, path, mode }) => ({ volumeId, path, mode })), (VolumeService.resolved(header.id, mounts as unknown[]) as { volumeId: string; path: string; mode?: string }[]).map(({ volumeId, path, mode }) => ({ volumeId, path, mode: mode ?? "rw" })));
  const fixed = [
    ...differs(header.identity?.subject, identity?.subject) ? ["subject"] : [], ...differs(header.identity?.context, identity?.context) ? ["context"] : [],
    ...(header.definition?.id ?? null) !== (origin?.definition.id ?? null) ? ["definition"] : [],
    // Mounts change only when the upsert says so (`remount`): its configure request then sets them between turns.
    ...remounted && !remount ? ["mounts"] : [],
  ];
  if (fixed.length) throw new HttpError(409, `An existing agent's ${fixed.join(", ")} cannot change; delete it (DELETE /v1/agents/${header.id}) or use another idempotency key${fixed.includes("mounts") ? ", or send remount: true to change its mounts" : ""}`);
  return {
    ...remounted ? { mounts } : {},
    provisionHash, model: `${config.model.provider}/${config.model.id}`, thinkingLevel: config.thinkingLevel ?? "off",
    systemPromptAppend: config.systemPromptAppend ?? "", fileTools: config.fileTools !== false, codeMode: config.codeMode !== false, runLimits: config.runLimits ?? null,
    maxOutputTokens: config.maxOutputTokens ?? null, temperature: config.temperature ?? null, dataCollection: config.dataCollection ?? null, name: metadata.name ?? null, type: metadata.type ?? null,
    // A language only when the upsert gives one (null clears it): an upsert from an SDK that predates it, which drops the
    // field, leaves the language set by PATCH .../configuration.
    ...config.language !== undefined ? { language: config.language } : {},
    // Only a definition's own fields are the agent's: the rest follow its definition.
    ...origin ? {} : { systemPrompt: config.systemPrompt ?? null, modelHeaders: config.modelHeaders ?? null, tools: definitions, builtins: own.builtins ?? [], delegate: own.delegate ?? null, mcpServers: own.mcpServers ?? [], decide: own.decide ?? null },
  };
}

/** Of an upsert's target, the fields the agent does not have already. */
function upsertChanges(header: SessionHeader, target: Record<string, any>) {
  const differs = (a: unknown, b: unknown) => canonical(a ?? null) !== canonical(b ?? null);
  const current = header.config;
  const changes: Record<string, unknown> = {};
  if (target.model !== undefined && target.model !== `${current.model.provider}/${current.model.id}`) changes.model = target.model;
  if (target.thinkingLevel !== undefined && target.thinkingLevel !== (current.thinkingLevel ?? "off")) changes.thinkingLevel = target.thinkingLevel;
  if (target.systemPromptAppend !== undefined && target.systemPromptAppend !== (current.systemPromptAppend ?? "")) changes.systemPromptAppend = target.systemPromptAppend;
  if (target.fileTools !== undefined && target.fileTools !== (current.fileTools !== false)) changes.fileTools = target.fileTools;
  if (target.codeMode !== undefined && target.codeMode !== (current.codeMode !== false)) changes.codeMode = target.codeMode;
  if ("systemPrompt" in target && differs(current.systemPrompt, target.systemPrompt)) changes.systemPrompt = target.systemPrompt;
  if ("modelHeaders" in target && differs(current.modelHeaders, target.modelHeaders)) changes.modelHeaders = target.modelHeaders;
  if ("runLimits" in target && differs(current.runLimits, target.runLimits)) changes.runLimits = target.runLimits;
  for (const key of ["maxOutputTokens", "temperature", "dataCollection", "language"] as const) if (key in target && differs(current[key], target[key])) changes[key] = target[key] as never;
  if (target.tools !== undefined && differs(header.definitions, target.tools)) changes.tools = target.tools;
  if (target.builtins !== undefined && differs(header.sources?.builtins ?? [], target.builtins)) changes.builtins = target.builtins;
  if (target.delegate !== undefined && differs(header.sources?.delegate, target.delegate)) changes.delegate = target.delegate;
  if (target.decide !== undefined && (target.decide ?? null) !== (header.sources?.decide ?? null)) changes.decide = target.decide;
  if (target.mcpServers !== undefined && differs(header.sources?.mcpServers ?? [], target.mcpServers)) changes.mcpServers = target.mcpServers;
  return changes;
}

/** An agent's own MCP servers, checked as the runtime's tool sources check them: none without tool sources. */
export const inlineServers = (ctx: ConfigurationContext, tenant: string) => (input: unknown): McpServerSpec[] => {
  if (input === null || (Array.isArray(input) && !input.length)) return [];
  if (!ctx.options.sources) throw new HttpError(400, "This runtime has no tool sources: mcpServers cannot be served");
  return ctx.options.sources.inline(input, tenant);
};

/** The id of the agent `create` makes for a tenant's idempotency key. */
export function agentId(tenant: string, key: string) {
  return `client_${hash(`${tenant}:${key}`).slice(0, 40)}`;
}

/**
 * Provision an agent, idempotently per `key`. An agent made from a definition records it
 * (`origin.definition`), and `origin.provision` stands for its configuration in the
 * idempotency check, so a retry after the definition changed returns the same agent.
 */
export async function create(ctx: ConfigurationContext, definitions: ToolDefinition[], config: Omit<AgentConfig, "id" | "directory" | "tools">, given: string | undefined, metadata: AgentMetadata = {}, tenant: string, ttlMs?: number | null, mounts?: unknown, origin?: { definition: DefinitionRef; provision: unknown; overrides?: string[]; sources?: Sources }, identity?: AgentIdentity, access: { keyScope?: string; spendLimit?: number; bucket?: string; toolsHash?: string; remount?: boolean; idleTtlMs?: number; builtins?: string[]; delegate?: DelegateSettings; mcpServers?: McpServerSpec[]; decide?: boolean; parent?: SessionHeader["parent"]; fork?: { id: string; from: ForkedFrom; messages: AgentMessage[]; turns: number[]; model: Message[] }; admit?: (unchanged: boolean) => Promise<unknown>; run?: RunSettings } = {}, steps = new Steps()): Promise<{ id: string; token: string; expiresAt: number | null; [status: string]: unknown }> {
  metadata = agentMetadata(metadata);
  validateDefinitions(definitions);
  // The caller's key, shown in listings; an agent made without one gets a key nothing else knows.
  const key = given ?? randomUUID();
  if (!validId(key)) throw new HttpError(400, "Invalid provisioning idempotency key");
  const { id, token, existing } = await steps.time("lookup", keyed(ctx, tenant, key));
  // A stateless run's key names one run: the same request again is that run, as it is; another request is refused.
  const sameRun = (header: SessionHeader) => {
    if (header.tenant !== tenant || header.run?.fingerprint !== access.run!.fingerprint) throw new HttpError(409, "This Idempotency-Key was used for another run; use another key", "IDEMPOTENCY_CONFLICT");
    return { id, token, expiresAt: header.expiresAt, existing: true };
  };
  const ranAlready = access.run && (ctx.sessions.get(id)?.header ?? existing?.value);
  if (ranAlready) return sameRun(ranAlready);
  // A fork's volume was made for the id its key had a moment ago: another generation now (it was deleted meanwhile) is a retry.
  if (access.fork && access.fork.id !== id) throw new HttpError(503, "The fork's key changed agents while it was made; retry");
  const { apiKey: _key, ...safeConfig } = config;
  // Its own MCP servers are checked as they are given (ToolSources.inline), or copied from a checked agent (a fork).
  const own = { ...(access.builtins?.length ? { builtins: access.builtins } : {}), ...(access.delegate ? { delegate: access.delegate } : {}), ...(access.mcpServers?.length ? { mcpServers: access.mcpServers } : {}), ...(access.decide !== undefined ? { decide: access.decide } : {}) };
  const provisionHash = hash(canonical({ ...origin ? { definition: origin.provision } : { definitions, config: safeConfig, ...(Object.keys(metadata).length ? { metadata } : {}), ...(mounts !== undefined ? { mounts } : {}), ...own }, ...(identity ? { identity } : {}) }));
  // The same key for an existing agent updates it: create or reconfigure (the last upsert wins).
  const changes = (header: SessionHeader) => ({ reconfigure: { ...reconfiguration(header, definitions, safeConfig, metadata, mounts, origin, identity, provisionHash, own, access.remount), ...(access.toolsHash ? { toolsHash: access.toolsHash } : {}), ...(access.bucket !== undefined && access.bucket !== header.bucket ? { bucket: access.bucket } : {}) } });
  // An agent's own sources are its builtins (and their settings) and MCP servers; one made from a definition has the definition's.
  const sources: Sources | undefined = origin ? origin.sources : Object.keys(own).length ? own : undefined;
  // The caller counts the create (its rate limit) now, told whether the key's agent has this configuration already:
  // an upsert that changes nothing makes nothing.
  const known = ctx.sessions.get(id)?.header ?? existing?.value;
  await access.admit?.(!!known && known.tenant === tenant && known.provisionHash === provisionHash && !known.revoked && !expired(known.expiresAt));
  if (existing) {
    if (existing.value.tenant !== tenant) throw new HttpError(409, "Idempotency key belongs to another tenant");
    const changed = changes(existing.value);
    if (await steps.time("route", ctx.ownerElsewhere(id))) return { id, token, expiresAt: existing.value.expiresAt, configHash: provisionHash, running: true, ...changed };
  }
  // A key with no agent a moment ago needs no second read: unless a create here is making it, this one does.
  let session = existing || ctx.sessions.has(id) || ctx.loading.has(id) ? await steps.time("load", ctx.load(id)) : undefined;
  // Another create of this agent on this node is provisioning it: wait for what it makes. Two at once
  // would each take the claim, and the second acquire's new epoch would fence the first out.
  while (!session && ctx.loading.has(id)) session = await steps.time("load", ctx.load(id));
  let created = false;
  let changed = {};
  if (session) {
    if (session.header.tenant !== tenant) throw new HttpError(409, "Idempotency key belongs to another tenant");
    if (session.header.revoked || expired(session.header.expiresAt)) throw new HttpError(410, "Session expired or revoked");
    if (access.run) return sameRun(session.header);
    changed = changes(session.header);
  } else {
    // Loads and creates of this agent here wait for this one (see `load`).
    const provisioned = Promise.withResolvers<Session | undefined>();
    ctx.loading.set(id, provisioned.promise);
    const settle = (made?: Session) => {
      provisioned.resolve(made);
      if (ctx.loading.get(id) === provisioned.promise) ctx.loading.delete(id);
    };
    let claim: Claim | undefined;
    try {
      // Capacity is reserved before anything is persisted: an agent refused for it leaves nothing behind.
      if (access.run) ctx.creatingRuns.add(id);
      await steps.time("room", ctx.makeRoom(id, tenant, !!access.run));
      const granted = ctx.options.volumes ? await steps.time("mounts", ctx.options.volumes.mountsFor(tenant, id, mounts)) : undefined;
      const ownership = ctx.options.ownership;
      if (ownership) {
        const acquired = await steps.time("claim", ownership.acquire(id));
        if ("owner" in acquired) throw new NotOwner(acquired.owner);
        claim = acquired.claim;
      }
      // A new agent's first ids are reserved with its row (`writeHeader`).
      const cursor = Date.now() * 1000;
      session = {
        header: { version: 3, id, tenant, digest: hash(token), expiresAt: access.idleTtlMs ? Date.now() + access.idleTtlMs : ttlMs === null ? null : Date.now() + (ttlMs ?? ctx.options.ttlMs ?? 24 * 60 * 60 * 1000), revoked: false, ...(access.idleTtlMs ? { idleTtlMs: access.idleTtlMs } : {}), metadata, definitions, config: safeConfig, provisionHash, ...(granted ? { mounts: granted } : {}), ...(origin ? { definition: origin.definition } : {}), ...(sources ? { sources } : {}), ...(origin?.overrides?.length ? { overrides: origin.overrides } : {}), ...(identity ? { identity } : {}), ...(access.keyScope ? { keyScope: access.keyScope } : {}), ...(access.bucket ? { bucket: access.bucket } : {}), ...(access.toolsHash ? { toolsHash: access.toolsHash } : {}), ...(given !== undefined ? { key: given } : {}), ...(access.fork ? { forkedFrom: access.fork.from } : {}), ...(access.parent ? { parent: access.parent } : {}), ...(access.run ? { run: access.run } : {}) },
        claim, requests: new Map(), running: new Map(), log: ctx.storage.log<JournalRecord>(ctx.journalKey(id), claim),
        cursor, reserved: cursor + ctx.eventBlock, events: [], eventBytes: 0, watchers: new Set(), polls: new Set(), inflight: 0, runs: Promise.resolve(), resuming: new Set(), settling: 0, lastActive: Date.now(),
      };
      // FileRefs its initial messages or a fork's history carry are its own now: their chunks are pinned to it before it
      // exists, so there is never an agent without them (a pin left by a create that failed only keeps chunks stored).
      const refs = [...safeConfig.initialMessages ?? [], ...access.fork?.messages ?? []].flatMap(message => Array.isArray((message as { content?: unknown }).content) ? (message as { content: unknown[] }).content.filter(validFileRef) : []);
      if (refs.length && ctx.options.volumes) await ctx.options.volumes.pin(tenant, id, refs.flatMap(ref => ref.chunks));
      // A fork's history is in its journal before it exists, written under its claim: the copied history archived before
      // its base.
      if (access.fork) await steps.time("history", ctx.seedFork(id, claim, access.fork));
      // A conditional create: if a concurrent request made this agent first, retry as a load.
      await steps.time("header", ctx.writeHeader(session));
      ctx.sessions.set(id, session);
      created = true;
      settle(session);
      await Promise.all([
        granted && steps.time("watch", ctx.options.volumes!.watch(id, tenant, [], granted, claim)),
        access.spendLimit !== undefined && steps.time("spend", ctx.setSpendLimit(session, access.spendLimit)),
      ]);
    } catch (error) {
      settle();
      if (!created) {
        ctx.supervisor.unreserve(id);
        if (claim) await ctx.options.ownership!.release(claim).catch(() => {});
        if (session?.fault?.message.includes("moved")) return create(ctx, definitions, config, key, metadata, tenant, ttlMs, mounts, origin, identity, access, steps);
        throw error;
      }
      await ctx.discard(session!);
      throw error;
    } finally { ctx.creatingRuns.delete(id); }
  }
  // Creating records the agent: its host starts in the background, so the response does not wait on listing its tool
  // servers, and a prompt sent meanwhile waits on the same start. A start that fails is only logged: the agent exists,
  // and its next request starts it again, answering with the error if it recurs.
  if (created) void ctx.ensureStarted(session).catch(error => {
    if (!session.header.revoked) console.error(JSON.stringify({ type: "agent_start_failed", agent: id, tenant, error: safeError(error) }));
  });
  return { id, token, expiresAt: session.header.expiresAt, configHash: provisionHash, ...changed };
}

/**
 * An agent's token: derived from its tenant and key (with the key's generation) until it is rotated, then from its
 * id and how many times it was, so rotating makes a new one even for an agent made without a key.
 */
function agentToken(ctx: ConfigurationContext, tenant: string, scoped: string, id: string, rotation = 0) {
  return createHmac("sha256", ctx.options.secret).update(rotation ? `client-rotated:${tenant}:${id}:${rotation}` : `client-v2:${tenant}:${scoped}`).digest("hex");
}

/**
 * A new token for a tenant's agent: the old one stops working at once, here and on every node (they check the header
 * this writes), and connections made with it (the application's, event streams) are closed. Applications reconnect
 * with the new one, which `credentials` gives from now on.
 */
export async function rotateToken(ctx: ConfigurationContext, id: string, tenant: string): Promise<{ id: string; token: string; expiresAt: number | null }> {
  const session = (await ctx.owns(id, tenant)) ? await ctx.load(id) : undefined;
  if (!session || session.header.tenant !== tenant) throw new HttpError(404, "Unknown agent");
  const rotation = (session.header.tokenRotation ?? 0) + 1;
  const token = agentToken(ctx, tenant, "", id, rotation);
  session.header.tokenRotation = rotation;
  session.header.digest = hash(token);
  await ctx.writeHeader(session);
  events.retire(session);
  events.endStreams(session);
  console.log(JSON.stringify({ type: "agent_token_rotated", agent: id, tenant, rotation }));
  return { id, token, expiresAt: session.header.expiresAt };
}

/**
 * The agent a tenant's key names now: its id and token, and its stored header unless this node holds it. A key whose
 * agent was deleted or expired names a fresh one: the next generation of the key, with an id and token of its own, so
 * the old agent's id is never reused and its token never works again.
 */
export async function keyed(ctx: ConfigurationContext, tenant: string, key: string): Promise<{ id: string; token: string; existing?: { value: SessionHeader } }> {
  for (let generation = 0; ; generation++) {
    // Idempotency keys are per tenant.
    const scoped = `${key}${generation ? `#${generation}` : ""}`;
    const id = agentId(tenant, scoped);
    // A deleted or expired agent (a tombstone once purged) is never loaded again; one another node serves only needs its header.
    const existing = ctx.sessions.has(id) ? undefined : await ctx.readHeader(id);
    const header = ctx.sessions.get(id)?.header ?? existing?.value;
    if (!header || !(header.revoked || expired(header.expiresAt))) return { id, token: agentToken(ctx, tenant, scoped, id, header?.tokenRotation), existing };
  }
}

/** GET /v1/agents' filters and page. Without `limit` the whole (filtered) list, as callers have always had it. */
export type AgentListQuery = {
  limit?: number;
  /** The previous page's `next`: agents after it, by id. */
  cursor?: string;
  /** A workspace id, or "unassigned" for agents in none. */
  workspaceId?: string;
  /** running: served by a node now; failed: a run failed in the last 24 hours; expiring: has an expiry. */
  status?: "running" | "failed" | "expiring";
  /** Only sub-agents (a delegate or spawn_agent call made them), or none of them. */
  subAgents?: "only" | "exclude";
  /** Part of its name, key or id, ignoring case. */
  q?: string;
  /** Just this agent (GET /v1/agents/{id}'s summary). */
  id?: string;
};
export const AGENT_PAGE_MAX = 200;
export const FAILED_WINDOW_MS = 24 * 3600_000;
const encodeCursor = (id: string) => Buffer.from(id).toString("base64url");
function decodeCursor(cursor: string) {
  const id = Buffer.from(cursor, "base64url").toString();
  if (!id || id.length > 200 || encodeCursor(id) !== cursor) throw new HttpError(400, "cursor must be a previous page's next");
  return id;
}
const like = (value: string) => `%${value.replace(/[\\%_]/g, match => `\\${match}`)}%`;

/** A tenant's live agents (not its stateless runs' sessions), filtered, by id; `next` when a page has more after it. */
export async function list(ctx: ConfigurationContext, tenant: string, query: AgentListQuery = {}) {
  const now = Date.now();
  const params: unknown[] = [tenant, now];
  const where = ["a.tenant = $1", "not a.revoked", "(a.expires_at is null or a.expires_at > $2)", "a.header->'run' is null"];
  const param = (value: unknown) => { params.push(value); return `$${params.length}`; };
  if (query.id !== undefined) where.push(`a.id = ${param(query.id)}`);
  if (query.cursor !== undefined) where.push(`a.id > ${param(decodeCursor(query.cursor))}`);
  if (query.workspaceId === "unassigned") where.push("w.workspace is null");
  else if (query.workspaceId !== undefined) where.push(`w.workspace = ${param(query.workspaceId)}`);
  if (query.status === "running") where.push("n.node is not null");
  if (query.status === "failed") where.push(`a.last_error_at > ${param(now - FAILED_WINDOW_MS)}`);
  if (query.status === "expiring") where.push("a.expires_at is not null");
  if (query.subAgents === "only") where.push("a.header->'parent'->>'agentId' is not null");
  if (query.subAgents === "exclude") where.push("a.header->'parent'->>'agentId' is null");
  if (query.q?.trim()) {
    const pattern = param(like(query.q.trim()));
    where.push(`(a.name ilike ${pattern} or a.header->>'key' ilike ${pattern} or a.id ilike ${pattern})`);
  }
  const limit = query.limit === undefined ? undefined : Math.min(Math.max(1, query.limit), AGENT_PAGE_MAX);
  const { rows } = await ctx.db.query(`
    select a.id, a.header->>'key' as key, a.name, a.type, a.model, a.expires_at, a.resume_failures, a.resume_after, a.header->'parent'->>'agentId' as parent, a.header->>'provisionHash' as config_hash,
      a.last_active_at, a.last_error_at, a.last_error_class, w.workspace, n.node is not null as served
    from agents a
    left join actor_owners o on o.actor = a.id
    left join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now()
    left join lateral (select workspace from workspace_assignments wa where wa.tenant = a.tenant and wa.kind = 'agent' and wa.resource = a.id order by wa.assigned_at desc, wa.sequence desc limit 1) w on true
    where ${where.join(" and ")} order by a.id${limit === undefined ? "" : ` limit ${limit + 1}`}`, params);
  const more = limit !== undefined && rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const agents = page.map(row => {
    const local = ctx.sessions.get(row.id);
    const response = local?.response;
    const running = ctx.supervisor.agents.has(row.id) || (!local && row.served);
    // The configuration it has: equal hashes, equal configurations (an upsert of it changes nothing).
    const configHash = (local?.header.provisionHash ?? row.config_hash) as string;
    return { id: row.id as string, key: row.key as string | null, name: row.name as string, type: row.type as string, model: row.model as string, configHash, connected: !!response && !response.destroyed, running: running as boolean, expiresAt: row.expires_at as number | null,
      resume: row.resume_failures ? { failures: row.resume_failures as number, after: Number(row.resume_after) } : null, ...(row.parent ? { parentAgentId: row.parent as string } : {}),
      workspaceId: (row.workspace ?? null) as string | null,
      lastActiveAt: row.last_active_at === null ? null : Number(row.last_active_at),
      lastError: row.last_error_at === null ? null : { at: Number(row.last_error_at), class: row.last_error_class as string } };
  });
  // Served by a node but not loaded there is not running: the page can come out shorter, never wrong.
  return { agents: query.status === "running" ? agents.filter(agent => agent.running) : agents, next: more ? encodeCursor(page.at(-1)!.id) : undefined };
}

/**
 * An existing agent's credentials, by its id or the key it was made with, without touching its configuration (an
 * upsert would set it to what the caller passes). The token is the one `create` gave: derived from the key and its
 * generation, so only an agent made with a key has one to give again; or, once rotated (`rotateToken`), the latest.
 */
export async function credentials(ctx: ConfigurationContext, tenant: string, ref: string): Promise<{ id: string; token: string; expiresAt: number | null; configHash?: string }> {
  // By id alone: a purged agent's tombstone keeps only its id, and still holds its key's generation.
  const live = async (id: string) => (await ctx.db.query("select tenant, header->>'key' as key, (header->>'tokenRotation')::int as rotation, header->>'provisionHash' as config_hash, expires_at, revoked, header->'run' is not null as run from agents where id = $1", [id])).rows[0] as { tenant: string | null; key: string | null; rotation: number | null; config_hash: string | null; expires_at: number | null; revoked: boolean; run: boolean } | undefined;
  // A stateless run's session is no agent: it has no credentials to give.
  const alive = (row: { tenant: string | null; expires_at: number | null; revoked: boolean; run: boolean }) => row.tenant === tenant && !row.revoked && !row.run && !expired(row.expires_at === null ? null : Number(row.expires_at));
  const found = (id: string, scoped: string, row: { rotation: number | null; config_hash: string | null; expires_at: number | null }) => {
    const configHash = ctx.sessions.get(id)?.header.provisionHash ?? row.config_hash;
    return { id, token: agentToken(ctx, tenant, scoped, id, row.rotation ?? 0), expiresAt: row.expires_at === null ? null : Number(row.expires_at), ...(configHash ? { configHash } : {}) };
  };
  if (validSessionId(ref)) {
    const row = await live(ref);
    if (row && alive(row)) {
      if (row.rotation) return found(ref, "", row);
      if (!row.key) throw new HttpError(409, "AGENT_KEYLESS: this agent was made without a key, so its token is only what its create answered");
      // Its generation: the key's agents before it were deleted or expired.
      for (let generation = 0; generation < 10_000; generation++) {
        const scoped = `${row.key}${generation ? `#${generation}` : ""}`;
        if (agentId(tenant, scoped) === ref) return found(ref, scoped, row);
      }
    }
  }
  if (validId(ref)) {
    for (let generation = 0; ; generation++) {
      const scoped = `${ref}${generation ? `#${generation}` : ""}`, id = agentId(tenant, scoped);
      const row = await live(id);
      if (!row) break;
      if (alive(row)) return found(id, scoped, row);
    }
  }
  throw new HttpError(404, "No agent has this id or key");
}

export async function inspect(ctx: ConfigurationContext, id: string, tenant: string) {
  const metadata = (await ctx.owns(id, tenant)) ? (await list(ctx, tenant, { id })).agents[0] : undefined;
  const session = metadata && await ctx.load(id);
  if (!metadata || !session) throw new HttpError(404, "Agent not found");
  const definition = session.header.definition && { id: session.header.definition.id, revision: session.header.definition.revision };
  return { ...metadata, ...(definition ? { definition } : {}), tools: session.header.definitions, systemPrompt: session.header.config.systemPrompt ?? "",
    ...(session.header.config.systemPromptAppend ? { systemPromptAppend: session.header.config.systemPromptAppend } : {}),
    ...(session.header.config.fileTools === false ? { fileTools: false } : {}), ...(session.header.config.codeMode === false ? { codeMode: false } : {}), mounts: session.header.mounts ?? [], keyScope: session.header.keyScope ?? null, bucket: session.header.bucket ?? null, modelHeaders: session.header.config.modelHeaders ?? null,
    builtins: session.header.sources?.builtins ?? [], delegate: session.header.sources?.delegate ?? null, mcpServers: (session.header.sources?.mcpServers ?? []).map(mcpServerView), decide: session.header.sources?.decide ?? null,
    ...(session.header.parent ? { parentAgentId: session.header.parent.agentId, parentRunId: session.header.parent.runId } : {}),
    spendLimit: await ctx.spendOf(session).then(spend => spend && { usd: spend.usd, spent: spend.spent }), runLimits: session.header.config.runLimits ?? null,
    maxOutputTokens: session.header.config.maxOutputTokens ?? null, temperature: session.header.config.temperature ?? null, dataCollection: session.header.config.dataCollection ?? null, language: session.header.config.language ?? null,
    ...(session.header.forkedFrom ? { forkedFrom: session.header.forkedFrom } : {}),
    ...activityOf(session.running.values()), cursor: session.cursor, events: session.events.map(({ id, data }) => ({ id, data })), requests: [...session.requests.values()].map(visible) };
}

/**
 * A tenant's key for `provider` changed: stop that tenant's idle agents using it
 * so their next request starts with the new key. Busy agents keep their key
 * until their turn ends and they go idle.
 */
export async function providerKeyChanged(ctx: ConfigurationContext, tenant: string, provider: string) {
  for (const session of ctx.sessions.values()) {
    if (session.header.tenant !== tenant || session.header.config.model.provider !== provider) continue;
    if (ctx.supervisor.agents.has(session.header.id) && !ctx.busy(session)) await ctx.supervisor.stop(session.header.id);
  }
}

/**
 * Credentials for one model call: for the agent's tenant's own endpoint, a token with the claims its tool
 * servers' tokens have, for the turn's actor; else its key scope's current key for the model's provider.
 */
export async function modelAuth(ctx: ConfigurationContext, session: Session): Promise<Credentials> {
  const { header } = session;
  const endpoint = spend.endpoint(ctx.spendContext, session);
  if (endpoint && ctx.options.modelToken) {
    const run = runningRun(session), actor = run?.actor, lineage = delegation.lineage(ctx.delegationContext, session, run);
    return { identity: true, apiKey: await ctx.options.modelToken(endpoint.baseUrl, {
      tenant: header.tenant, agent: header.id, ...(header.definition ? { definition: header.definition.id } : {}), ...(header.identity ? { identity: header.identity } : {}), ...(actor ? { actor } : {}), ...lineage,
    }) };
  }
  const provider = header.config.model.provider;
  if (!ctx.options.scopedKey) throw new Error("This agent's model takes no per-call credentials");
  const resolved = await ctx.options.scopedKey(header.tenant, header.keyScope, provider);
  if (!resolved && !header.keyScope) throw new Error(`The ${provider} provider is gone: set it again with PUT /v1/providers/${provider}, or move this agent to another model`);
  if (!resolved) throw new Error(`No ${provider} API key is configured for key scope ${header.keyScope} or this tenant; set one with PUT /v1/key-scopes/${header.keyScope}/providers/${provider}`);
  const { platform, ...credentials } = resolved;
  session.platformKey = platform;
  return credentials;
}

/** The configuration an agent takes from its definition's current revision; tools added at creation stay. */
async function definitionUpdate(ctx: ConfigurationContext, session: Session, target?: { id: string }) {
  const current = session.header.definition;
  if (!current) throw new Error("This agent was not made from a definition");
  const id = target?.id ?? current.id;
  const resolved = await ctx.options.definitionFor!(session.header.tenant, id);
  // Its servers are listed afresh for the tools the agent takes now: what they offer may have changed with it.
  if (resolved.sources?.mcpServers?.length) ctx.options.sources?.forget(session.header.tenant, resolved.sources.mcpServers);
  // The attached server's tools stay, as does the agent's own configuration; the tools list is rebuilt with the definition's sources.
  const config = Object.fromEntries(Object.entries(resolved.config).filter(([key]) => !session.header.overrides?.includes(key))) as Partial<DefinitionConfig["config"]>;
  return { update: { ...config, tools: session.header.definitions }, definition: { id, revision: resolved.revision }, sources: resolved.sources };
}

export async function configure(ctx: ConfigurationContext, session: Session, params: any, live: boolean) {
  const id = session.header.id;
  const applied = params.definition !== undefined ? await definitionUpdate(ctx, session, params.definition) : undefined;
  // An upsert's own fields (see `reconfiguration`): what the agent is called, and the configuration it now matches.
  // Of its target, only what the agent does not have already is applied.
  const { provisionHash, name, type, toolsHash: declared, ...asked } = params;
  // The hash of the tools as the application declared them: given by an upsert, else of a configure's own mcp.tools.
  const toolsHash = declared ?? (asked.mcp?.tools !== undefined ? hash(JSON.stringify(asked.mcp.tools)) : undefined);
  const { mounts, ...wanted } = asked;
  const { builtins, delegate, mcpServers, decide, ...given } = provisionHash !== undefined ? upsertChanges(session.header, wanted) : wanted;
  // The agent's own builtins, their settings and MCP servers (an agent from a definition has the definition's): its sources, with the tools they offer.
  const reSourced = builtins !== undefined || delegate !== undefined || mcpServers !== undefined || decide !== undefined;
  const sources = reSourced ? ownSources(session.header.sources, { builtins, delegate, mcpServers, decide }, inlineServers(ctx, session.header.tenant)) : session.header.sources;
  // An upsert with remount: true sets its mounts here, between turns; the agent's next start describes them.
  if (mounts !== undefined) await sessionTools.remount(ctx.toolsContext, session, mounts);
  const changed = provisionHash === undefined || reSourced || mounts !== undefined || Object.keys(given).length > 0 || (name !== undefined && name !== (session.header.metadata?.name ?? null)) || (type !== undefined && type !== (session.header.metadata?.type ?? null));
  const { keyScope, ...update } = (applied?.update ?? configurationUpdate(given, ctx.options.modelEndpoints?.(session.header.tenant), await ctx.options.customProviders?.(session.header.tenant, scopeAfter(session.header, given)))) as ReturnType<typeof configurationUpdate> & { fileTools?: boolean; codeMode?: boolean };
  // Checked again as it applies, after the configuration queued before it (a definition's own change is not: its calls leave out what does not apply).
  const refusal = applied ? undefined : configurationRefusal(session.header.config, update);
  if (refusal) throw new HttpError(400, refusal);
  // A new model may belong to another provider, and a new key scope has keys of its own: the agent needs that provider's key.
  const resolved = update.model || keyScope !== undefined ? await resolveApiKey(ctx, session, (update.model ?? session.header.config.model).provider, keyScope === undefined ? session.header.keyScope : keyScope ?? undefined) : undefined;
  const apiKey = resolved?.key;
  if (resolved && ctx.options.apiKeyFor && !apiKey) throw new Error(`No ${(update.model ?? session.header.config.model).provider} API key is configured for this tenant; set one with PUT /v1/providers/${(update.model ?? session.header.config.model).provider}/key`);
  // An agent that is not running takes its new configuration when it next starts.
  const result = !Object.keys(update).length && !keyScope && keyScope !== null && !reSourced ? { configured: true } : live ? await ctx.supervisor.request(id, "configure", {
    ...update, ...apiKey ? { apiKey } : {},
    // Replacing the application's tools keeps the runtime's own.
    // A changed data policy can take the decide tool away or give it back (decisionServer).
    ...update.tools || "fileTools" in update || "codeMode" in update || "dataCollection" in update || reSourced ? { tools: await sessionTools.toolset(ctx.toolsContext, session, { ...update.tools ? { tools: update.tools } : {}, sources: applied ? applied.sources : sources, ..."fileTools" in update ? { fileTools: update.fileTools } : {}, ..."codeMode" in update ? { codeMode: update.codeMode } : {} }) } : {},
  }) : { configured: true };
  const { tools, ...config } = update;
  if (resolved && live) session.platformKey = resolved.platform;
  if (keyScope) session.header.keyScope = keyScope; else if (keyScope === null) delete session.header.keyScope;
  if (tools !== undefined) session.header.definitions = tools;
  session.header.config = { ...session.header.config, ...config };
  if (reSourced) { if (sources) session.header.sources = sources; else delete session.header.sources; }
  if (applied) {
    session.header.definition = applied.definition;
    if (applied.sources) session.header.sources = applied.sources; else delete session.header.sources;
  } else if (session.header.definition) {
    // A model or thinking level configured directly is the agent's own from then on.
    const overrides = new Set([...session.header.overrides ?? [], ...OVERRIDES.filter(key => (update as Record<string, unknown>)[key] !== undefined)]);
    if (overrides.size) session.header.overrides = [...overrides];
  }
  if (provisionHash !== undefined) session.header.provisionHash = provisionHash;
  if (toolsHash !== undefined) session.header.toolsHash = toolsHash;
  if (name !== undefined || type !== undefined) {
    const metadata = { ...session.header.metadata, ...name !== undefined ? { name } : {}, ...type !== undefined ? { type } : {} };
    session.header.metadata = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null)) as AgentMetadata;
  }
  await ctx.writeHeader(session);
  return provisionHash !== undefined ? { ...result, changed } : result;
}

/**
 * An agent's own sources (one without a definition) once a configuration gives builtins, delegate, mcpServers or decide: what it
 * leaves out stays, the delegate settings go with their builtin (delegateSettings), and its MCP servers are checked by
 * `inline` (ToolSources.inline: no credentials).
 */
export function ownSources(current: Sources | undefined, given: { builtins?: unknown; delegate?: unknown; mcpServers?: unknown; decide?: unknown }, inline: (input: unknown) => McpServerSpec[]): Sources | undefined {
  const builtins = given.builtins !== undefined ? builtinsInput(given.builtins) as string[] : current?.builtins ?? [];
  // Kept when builtins change: settings of a builtin still given, or limits alone (which need none).
  const kept = current?.delegate && (startsChildren(builtins) || limitsOnly(current.delegate)) ? current.delegate : undefined;
  const delegate = delegateSettings(builtins, given.delegate !== undefined ? given.delegate : kept);
  const mcpServers = given.mcpServers !== undefined ? inline(given.mcpServers) : current?.mcpServers ?? [];
  const decide = given.decide !== undefined ? decideInput(given.decide, true) : current?.decide ?? null;
  const { builtins: _builtins, delegate: _delegate, mcpServers: _servers, decide: _decide, ...rest } = current ?? {};
  const next: Sources = { ...rest, ...(builtins.length ? { builtins } : {}), ...(delegate ? { delegate } : {}), ...(mcpServers.length ? { mcpServers } : {}), ...(decide !== null ? { decide } : {}) };
  return Object.keys(next).length ? next : undefined;
}

/** The key scope an agent has once `update` applies: the one it names (null for none), else its own. */
export const scopeAfter = (header: SessionHeader, update: { keyScope?: unknown }) => Object.hasOwn(update, "keyScope") ? update.keyScope as string | null : header.keyScope;
