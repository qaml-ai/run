import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getAgentStub, type AgentDO } from "./agent-do.ts";
import { parseRequestCredentials } from "./auth.ts";
import { CamelFsClient } from "./camelfs.ts";
import { mintAgentToken, randomId, sealSecret, sha256Hex } from "./crypto.ts";
import { listV2Models } from "./models.ts";
import { DEFAULT_MODEL_ID } from "./providers.ts";
import { getSkillStore, normalizeSkillSelectors } from "./skills.ts";
import { getTenantStub, type RepoRecord } from "./tenant-do.ts";
import {
  ApiError,
  extractApiError,
  type AgentEventRecord,
  type AgentUpsertInput,
  type BuiltinSuite,
  type Env,
  type PendingInputView,
  type RpcStub,
  type RunRecord,
  type StartRunInput,
  type StoredMessage,
} from "./types.ts";

export const MCP_SERVER_VERSION = "2.0.0";

export const AGENT_MCP_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
};

const MAX_BODY = 8 * 1024 * 1024;
const MAX_RESULT = 100_000;
const HEARTBEAT_MS = 20_000;
const TEXT_EVERY_MS = 1_000;
const FALLBACK_POLL_MS = 2_000;
const ELICIT_PREFIX = "input:";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "input_required"]);
const TERMINAL_EVENT_TYPES = new Set([
  "run_completed",
  "run_failed",
  "run_cancelled",
  "input_required",
]);

const BUILTIN_SUITES = [
  "files",
  "images",
  "browser",
  "bash",
  "codemode",
  "delegate",
  "workflows",
  "web_search",
  "web_fetch",
  "human",
  "skills",
] as const satisfies readonly BuiltinSuite[];

const customToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  requiresApproval: z.boolean().optional(),
});

const mcpServerSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: z.object({ type: z.literal("runtime") }).optional(),
  audience: z.string().optional(),
  allowTools: z.array(z.string()).optional(),
});

const queueConfigSchema = z.object({
  mode: z.enum(["each", "batch"]).optional(),
  windowMs: z.number().int().min(0).optional(),
});

const dreamingConfigSchema = z.object({
  enabled: z.boolean().optional(),
  idleSeconds: z.number().int().min(0).optional(),
});

const SECRET_KEY_RE = /^(token|agentToken|sealedToken|apiKey|secret|password|authorization)$/i;

function redactHeaderRecord(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
  return Object.fromEntries(Object.keys(headers as Record<string, unknown>).map((k) => [k, "***"]));
}

function redactSecretObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretObject);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "headers" && item && typeof item === "object" && !Array.isArray(item)) {
      out[key] = redactHeaderRecord(item);
    } else if (SECRET_KEY_RE.test(key)) {
      out[key] = "***";
    } else {
      out[key] = redactSecretObject(item);
    }
  }
  return out;
}

function redactAgentConfigFields<T extends Record<string, unknown>>(obj: T): T {
  const copy: Record<string, unknown> = { ...obj };
  delete copy.agentToken;
  delete copy.sealedToken;
  if (Array.isArray(copy.mcpServers)) {
    copy.mcpServers = copy.mcpServers.map((s) => redactSecretObject(s));
  }
  if (Array.isArray(copy.tools)) {
    copy.tools = copy.tools.map((t) => redactSecretObject(t));
  }
  return copy as T;
}

function redactDefinition<T extends { config: Record<string, unknown> }>(def: T): T {
  return {
    ...def,
    config: redactAgentConfigFields(def.config),
  };
}

function parseMcpCursor(cursor?: string): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const trimmed = String(cursor).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ApiError(400, "invalid_cursor", `Invalid pagination cursor '${cursor}'`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(400, "invalid_cursor", `Invalid pagination cursor '${cursor}'`);
  }
  return parsed;
}

const CAMELRUN_DOCS: Record<string, string> = {
  index: `# CamelRun v2 Documentation Index

Available topics (call read_docs with topic):
- overview: Architecture, endpoints, authentication, and core concepts
- mcp: Hosted Tenant MCP (/mcp, /v2/mcp) and Per-Agent MCP (/v2/agents/:idOrKey/mcp)
- agents: Durable keyed agents, definitions, forking, runs, history, inputs
- schedules: Cron, interval, and one-shot agent schedules
- camelfs: Versioned CamelFS repositories and file tools
- skills: Tenant-scoped reusable markdown skills
- auth: API keys, agent tokens, and RFC 9728 discovery metadata

Full docs: https://camelai.com/docs/camelrun/overview`,

  overview: `# CamelRun v2 Overview

Base URL: https://run.camelai.com
- Tenant Hosted MCP: POST /mcp or POST /v2/mcp (Bearer cr_live_...)
- Per-Agent MCP: POST /v2/agents/:idOrKey/mcp (Bearer cr_live_... or agt_tok_...)
- REST API: /v2/agents, /v2/definitions, /v2/skills, /v2/repos, /v2/models, /v2/billing

Agents are durable and keyed: the same key always refers to the same agent and its conversation history until deleted.
Most tools accept either an agent's key or its ID (agt_...).`,

  mcp: `# CamelRun v2 Hosted MCP

## Endpoints
- Tenant MCP: POST https://run.camelai.com/mcp (and /v2/mcp)
  Requires a tenant API key (Authorization: Bearer cr_live_...).
  Exposes account, billing, models, definitions, skills, agents, runs, inputs, schedules, and CamelFS tools.
- Per-Agent MCP: POST https://run.camelai.com/v2/agents/:idOrKey/mcp
  Accepts a tenant key or the agent's scoped token (agt_tok_...).
  Exposes one tool: message({ text, requestId? }) with SSE progress notifications and MCP elicitation support.

## Streaming & Long Runs
- Include _meta.progressToken on tools/call to receive SSE progress notifications.
- Use send_message with wait: false to start a run asynchronously, then poll with get_run({ agent, runId }).`,

  agents: `# Agents & Definitions

- Definitions (upsert_definition, list_definitions, get_definition, delete_definition, definition_agents):
  Reusable templates (model, instructions, builtins, skills, tools, mcpServers, repoId, spendLimitUsd).
  Secret headers in mcpServers and custom tools are redacted on read.
- Agents (upsert_agent, configure_agent, list_agents, get_agent, fork_agent, delete_agent):
  Created/updated by durable key. Use configure_agent to patch model, instructions, spendLimitUsd, compactThresholdTokens, skills, repoId, or branch without losing history.
- Runs & Human Inputs (send_message, get_run, get_history, list_inputs, answer_input, abort_agent):
  If a run returns status "input_required", inspect pending inputs via list_inputs and resume with answer_input.`,

  schedules: `# Agent Schedules

Tools: list_schedules, add_schedule, delete_schedule.
Each schedule wakes an agent with a prompt using one of:
- cron (5-field UTC cron expression, e.g. "0 9 * * 1-5")
- intervalSeconds (repeat every N seconds)
- runAt (ISO-8601 timestamp or Unix ms for a one-shot run)

Optional id/name lets you upsert a named schedule; enabled: false pauses it without deleting.`,

  camelfs: `# CamelFS Versioned Repositories

Tools: list_repos, list_files, read_file, write_file, grep_files.
- list_repos supports limit (default 50, max 200), cursor, and prefix filtering.
- Every write_file creates an immutable commit on the target ref (default repo defaultRef) and supports optimistic concurrency via expectedCommit.`,

  skills: `# Tenant Skills

Tools: list_skills, get_skill, upsert_skill, delete_skill.
- Skills are tenant-scoped markdown bundles (slug like "team/deploy-guide", optional tags and reference files).
- Attach skills to agents or definitions via skills: ["team/*"] and include "skills" in builtins so agents can discover and read them on demand.`,

  auth: `# Authentication & Discovery

- Tenant API keys (cr_live_...) grant full tenant access on /mcp, /v2/mcp, /v2/agents/:idOrKey/mcp, and /v2/* REST endpoints.
- Agent tokens (agt_tok_...) are scoped to a single agent on /v2/agents/:idOrKey/mcp and agent run/read/input REST endpoints.
- RFC 9728 Protected Resource Metadata is served at:
  - /.well-known/oauth-protected-resource (resource: /mcp)
  - /.well-known/oauth-protected-resource/mcp (resource: /mcp)
  - /.well-known/oauth-protected-resource/v2/mcp (resource: /v2/mcp)
  - /.well-known/oauth-protected-resource/v2/agents/:idOrKey/mcp`,
};

interface McpExtra {
  requestId: string | number;
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification(notification: Record<string, unknown>): Promise<void>;
}

interface WaitingElicitation {
  agentId: string;
  reply: (message: Record<string, unknown>) => void;
}

const waitingElicitations = new Map<string, WaitingElicitation>();

const HOSTED_MCP_INSTRUCTIONS = `Manage durable agents, definitions, skills, schedules, CamelFS repositories, and account billing on CamelRun v2 (https://run.camelai.com).

- An agent is durable and keyed: the same key refers to the same agent and its conversation history until deleted. Agent tools accept either the agent's key or its id (agt_...).
- Use upsert_agent to create or update an agent, configure_agent to patch specific settings, fork_agent to branch an agent's history/repo, and send_message to run a prompt (or pass wait: false and check progress with get_run).
- If a run pauses with status "input_required", inspect pending items with list_inputs and call answer_input with the inputId to resume the turn.
- Use list_schedules, add_schedule, and delete_schedule to manage cron, interval, or one-shot wake-ups.
- Use list_repos (paginated), list_files, read_file, write_file, and grep_files to inspect and edit versioned CamelFS repositories, and read_docs for concise API/MCP reference.`;

function publicOriginFor(request: Request, env: Env): string {
  const configured = env.VOICE_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

export function mcpPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: { ...AGENT_MCP_CORS, "Access-Control-Max-Age": "86400" },
  });
}

export function mcpMethodNotAllowed(): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "This server is stateless: POST each message" },
      id: null,
    },
    { status: 405, headers: { ...AGENT_MCP_CORS, Allow: "POST" } },
  );
}

export function mcpUnauthorized(
  request: Request,
  publicOrigin: string,
  agentIdOrKey?: string,
): Response {
  const invalid = Boolean(request.headers.get("Authorization"));
  const requestPath = new URL(request.url).pathname;
  const resourcePath = agentIdOrKey
    ? `/v2/agents/${encodeURIComponent(agentIdOrKey)}/mcp`
    : requestPath === "/mcp"
      ? "/mcp"
      : "/v2/mcp";
  const metadata = `${publicOrigin}/.well-known/oauth-protected-resource${resourcePath}`;
  return Response.json(
    {
      error: invalid ? "invalid_token" : "unauthorized",
      error_description: invalid
        ? "The token is invalid, expired or revoked"
        : agentIdOrKey
          ? "Send Authorization: Bearer <cr_live_... or agt_tok_...>"
          : "Send Authorization: Bearer <cr_live_... API key>",
    },
    {
      status: 401,
      headers: {
        ...AGENT_MCP_CORS,
        "WWW-Authenticate":
          `Bearer resource_metadata="${metadata}"` +
          (invalid ? ', error="invalid_token"' : "") +
          ', scope="agents"',
      },
    },
  );
}

export function mcpProtectedResourceMetadata(
  request: Request,
  env: Env,
  resourcePath: string,
): Response {
  if (request.method === "OPTIONS") return mcpPreflight();
  const origin = publicOriginFor(request, env);
  return Response.json(
    {
      resource: `${origin}${resourcePath}`,
      resource_name: "CamelRun",
      bearer_methods_supported: ["header"],
      scopes_supported: ["agents"],
      resource_documentation: "https://camelai.com/docs/camelrun/overview",
    },
    {
      status: 200,
      headers: {
        ...AGENT_MCP_CORS,
        "Cache-Control": "public, max-age=300",
      },
    },
  );
}

export function mcpAuthorizationServerMetadata(request: Request, _env: Env): Response {
  if (request.method === "OPTIONS") return mcpPreflight();
  return Response.json(
    {
      error: "oauth_not_enabled",
      error_description:
        "Interactive OAuth 2.1 token issuance is not enabled on CamelRun v2; authenticate with Authorization: Bearer <cr_live_... or agt_tok_...>.",
      service_documentation: "https://camelai.com/docs/camelrun/overview",
    },
    {
      status: 404,
      headers: {
        ...AGENT_MCP_CORS,
        "Cache-Control": "no-store",
      },
    },
  );
}

function tooLargeResponse(): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32600, message: `A message is at most ${MAX_BODY} bytes` },
      id: null,
    },
    { status: 413, headers: AGENT_MCP_CORS },
  );
}

async function readBoundedBody(request: Request): Promise<{ ok: true; body: string } | { ok: false; response: Response }> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) {
    return { ok: false, response: tooLargeResponse() };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BODY) {
          await reader.cancel();
          return { ok: false, response: tooLargeResponse() };
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const encoded = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    encoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: new TextDecoder().decode(encoded) };
}

function parseJsonRpcMessages(body: string): Array<Record<string, any>> {
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function handleStatelessTransport(
  request: Request,
  server: McpServer,
  body: string,
  stream: boolean,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const incoming = new Request(request.url, { method: "POST", headers, body });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: !stream,
  });
  await server.connect(transport);
  let streaming = false;
  try {
    const response = await transport.handleRequest(incoming);
    const answer = new Headers(response.headers);
    for (const [key, value] of Object.entries({ ...AGENT_MCP_CORS, ...extraHeaders })) {
      answer.set(key, value);
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      return new Response(response.body && (await response.arrayBuffer()), {
        status: response.status,
        headers: answer,
      });
    }
    const reader = response.body.getReader();
    const close = () => void server.close().catch(() => {});
    streaming = true;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            close();
          } else {
            controller.enqueue(value);
          }
        },
        cancel() {
          void reader.cancel().catch(() => {});
          close();
        },
      }),
      { status: response.status, headers: answer },
    );
  } finally {
    if (!streaming) await server.close();
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function cappedResultText(value: unknown, skipCap = false): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (skipCap || text.length <= MAX_RESULT) return text;
  return `${text.slice(0, MAX_RESULT)}\n\n[Cut at ${MAX_RESULT} characters of ${text.length}: ask for less, such as a smaller limit.]`;
}

function errorText(err: unknown): string {
  const apiErr = extractApiError(err);
  if (apiErr) return `${apiErr.status} (${apiErr.code}): ${apiErr.message}`;
  return err instanceof Error ? err.message : String(err);
}

function toolTextResult(
  value: string,
  isError = false,
  structuredContent?: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function createProgressReporter(extra: McpExtra) {
  const token = extra._meta?.progressToken;
  let count = 0;
  let lastSent = 0;
  let lastTextSent = 0;
  let said = "";

  const send = (message: string) => {
    if (token === undefined) return;
    lastSent = Date.now();
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++count, message },
      })
      .catch(() => {});
  };

  const heartbeat =
    token === undefined
      ? undefined
      : setInterval(() => {
          if (Date.now() - lastSent >= HEARTBEAT_MS) send("Working…");
        }, HEARTBEAT_MS);

  return {
    send,
    event(ev: { type: string; data: Record<string, unknown> }) {
      if (ev.type === "message_start" || ev.type === "run_started" || ev.type === "run_resumed") {
        said = "";
      } else if (ev.type === "text_delta" && typeof ev.data.delta === "string") {
        said = (said + ev.data.delta).slice(-200);
        if (Date.now() - lastTextSent >= TEXT_EVERY_MS) {
          lastTextSent = Date.now();
          send(said);
        }
      } else if (ev.type === "tool_call_start" && typeof ev.data.name === "string") {
        send(`Using ${ev.data.name}`);
      } else if (ev.type === "context_compacted") {
        send("Compacting history");
      }
    },
    stop() {
      if (heartbeat !== undefined) clearInterval(heartbeat);
    },
  };
}

type FollowItem =
  | { kind: "event"; runId: string | null; event: { type: string; data: Record<string, unknown> } }
  | { kind: "reply"; input: PendingInputView; message: Record<string, unknown> }
  | { kind: "poll" }
  | { kind: "aborted" };

class AsyncInbox<T> {
  private readonly items: T[] = [];
  private wake?: () => void;

  push(item: T): void {
    this.items.push(item);
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }

  async next(): Promise<T> {
    while (this.items.length === 0) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    return this.items.shift()!;
  }
}

async function openAgentEventSocket(
  stub: RpcStub<AgentDO>,
  inbox: AsyncInbox<FollowItem>,
): Promise<WebSocket | null> {
  try {
    const res = await stub.fetch("https://agent.internal/ws", {
      headers: { Upgrade: "websocket" },
    });
    const socket = res.status === 101 ? res.webSocket : null;
    if (!socket) return null;
    socket.accept();
    socket.addEventListener("message", ({ data }) => {
      try {
        const frame = JSON.parse(String(data)) as {
          type?: string;
          runId?: string | null;
          event?: { type: string; data: Record<string, unknown> };
        };
        if (frame.type === "event" && frame.event) {
          inbox.push({
            kind: "event",
            runId: frame.runId ?? null,
            event: frame.event,
          });
        }
      } catch {
        // Ignore malformed frames
      }
    });
    socket.addEventListener("close", () => inbox.push({ kind: "poll" }));
    socket.addEventListener("error", () => inbox.push({ kind: "poll" }));
    return socket;
  } catch {
    return null;
  }
}

function summarizeRun(
  agent: { id: string; key: string },
  run: RunRecord,
): Record<string, unknown> {
  const pendingInputs = (run.inputs ?? []).filter((i) => i.status === "pending");
  return {
    agentId: agent.id,
    agentKey: agent.key,
    runId: run.id,
    status: run.status,
    ...(run.text ? { text: run.text } : {}),
    ...(run.output !== undefined && run.output !== null ? { output: run.output } : {}),
    usage: run.usage,
    ...(run.toolCalls?.length ? { toolCalls: run.toolCalls } : {}),
    ...(run.filesChanged?.length ? { filesChanged: run.filesChanged } : {}),
    ...(pendingInputs.length ? { inputs: pendingInputs } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function flattenHistoryMessage(msg: {
  seq: number;
  runId: string | null;
  role: string;
  content: StoredMessage["content"] | Record<string, unknown>;
  createdAt: number;
}): Record<string, unknown> {
  const content = msg.content as StoredMessage["content"];
  const text = content.text;
  const truncatedText =
    text && msg.role === "tool" && text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
  return {
    seq: msg.seq,
    runId: msg.runId,
    role: msg.role,
    ...(content.toolName ? { tool: content.toolName } : {}),
    ...(truncatedText ? { text: truncatedText } : {}),
    ...(content.toolCalls?.length
      ? {
          toolCalls: content.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: tc.args,
          })),
        }
      : {}),
    ...(content.isError ? { isError: true } : {}),
    createdAt: msg.createdAt,
  };
}

async function startPreparedAgentRun(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  creds: { kind: "tenant" | "agent"; tenantId: string; tokenHash: string; agentId?: string },
  idOrKey: string,
  body: StartRunInput,
): Promise<{ agentId: string; stub: RpcStub<AgentDO>; run: RunRecord }> {
  const preacquireRunId = body.whileRunning !== "steer" ? randomId("run", 8) : undefined;
  const tenantStub = getTenantStub(env, creds.tenantId);
  const prep = await tenantStub.authorizeAndPrepareRun({
    credKind: creds.kind,
    tokenHash: creds.tokenHash,
    agentIdFromToken: creds.kind === "agent" ? creds.agentId : undefined,
    idOrKey,
    defaultModel: env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID,
    ...(body.keyScope !== undefined ? { keyScopeOverride: body.keyScope?.trim() || null } : {}),
    operation: "run",
    includeProviderCredentials: true,
    preacquireRunId,
  });
  const stub = getAgentStub(env, prep.agentId);
  try {
    const run = await stub.startRun(body, {
      runId: preacquireRunId,
      preacquiredSlot: prep.slotAcquired,
      prefetchedProvider: prep.prefetchedProvider,
      prefetchedBalanceUsd: prep.balanceUsd,
    });
    return { agentId: prep.agentId, stub, run };
  } catch (err) {
    if (prep.slotAcquired && preacquireRunId) {
      ctx.waitUntil(tenantStub.releaseSlot(preacquireRunId).catch(() => {}));
    }
    throw err;
  }
}

async function followRunWithProgress(
  stub: RpcStub<AgentDO>,
  initialRun: RunRecord,
  extra: McpExtra,
  socket: WebSocket | null,
  inbox: AsyncInbox<FollowItem>,
): Promise<RunRecord | "aborted"> {
  const progress = createProgressReporter(extra);
  const onAbort = () => inbox.push({ kind: "aborted" });
  if (extra.signal.aborted) {
    progress.stop();
    return "aborted";
  }
  extra.signal.addEventListener("abort", onAbort, { once: true });

  const targetRunId = initialRun.batchedInto ?? initialRun.id;
  let current: RunRecord =
    targetRunId !== initialRun.id ? await stub.getRun(targetRunId) : initialRun;

  const pollTimer = setInterval(() => inbox.push({ kind: "poll" }), socket ? FALLBACK_POLL_MS : 250);
  try {
    for (;;) {
      if (TERMINAL_STATUSES.has(current.status)) {
        return current;
      }
      const item = await inbox.next();
      if (item.kind === "aborted") {
        return "aborted";
      }
      if (item.kind === "poll") {
        current = await stub.getRun(targetRunId);
        continue;
      }
      if (item.kind === "event" && item.runId === targetRunId) {
        if (TERMINAL_EVENT_TYPES.has(item.event.type)) {
          current = await stub.getRun(targetRunId);
        } else {
          progress.event(item.event);
        }
      }
    }
  } finally {
    clearInterval(pollTimer);
    extra.signal.removeEventListener("abort", onAbort);
    progress.stop();
  }
}

function buildElicitationParams(
  input: PendingInputView,
  can: { form: boolean; url: boolean },
): Record<string, unknown> | undefined {
  const prompt = input.prompt ?? {};
  const mcpElicit = prompt.elicitation as
    | { mode?: string; message?: string; url?: string; requestedSchema?: Record<string, unknown> }
    | undefined;
  const emptySchema = { type: "object", properties: {} };

  if (mcpElicit?.mode === "url") {
    const message = String(prompt.question ?? mcpElicit.message ?? "Open this page to continue");
    if (can.url && typeof mcpElicit.url === "string") {
      return { mode: "url", message, url: mcpElicit.url, elicitationId: input.id };
    }
    if (can.form && typeof mcpElicit.url === "string") {
      return {
        message: `${message}\n\nOpen ${mcpElicit.url}, then accept once it is done.`,
        requestedSchema: emptySchema,
      };
    }
    return undefined;
  }

  if (!can.form) return undefined;

  if (mcpElicit?.mode === "form") {
    return {
      message: String(prompt.question ?? mcpElicit.message ?? "Input required"),
      requestedSchema: mcpElicit.requestedSchema ?? emptySchema,
    };
  }

  if (input.kind === "approval") {
    const message = String(
      prompt.message ?? `Approve execution of tool '${String(prompt.tool ?? "tool")}'?`,
    );
    return {
      message: `${message}\n\n${clip(JSON.stringify(prompt.args ?? {}), 2_000)}`,
      requestedSchema: emptySchema,
    };
  }

  const question = String(prompt.question ?? "Input requested");
  const options = Array.isArray(prompt.options)
    ? prompt.options.filter((o): o is string => typeof o === "string" && o.length > 0)
    : [];
  const answerField = options.length
    ? {
        type: "string",
        title: "Answer",
        description: `${question} (${options.join(", ")})`,
        enum: options,
      }
    : { type: "string", title: "Answer", description: question };

  return {
    message: question,
    requestedSchema: {
      type: "object",
      properties: { answer: answerField },
      required: ["answer"],
    },
  };
}

async function settleElicitationReply(
  stub: RpcStub<AgentDO>,
  input: PendingInputView,
  reply: Record<string, any>,
  trustedResponder: boolean,
): Promise<boolean> {
  const action = reply?.result?.action;
  if (reply?.error || (action !== "accept" && action !== "decline")) return false;
  const content = (reply.result?.content ?? {}) as Record<string, unknown>;
  const mcpElicit = input.prompt?.elicitation as { mode?: string } | undefined;

  let body: { approved: boolean; answer?: unknown; wait: boolean };
  if (action === "decline") {
    body = { approved: false, wait: false };
  } else if (input.kind === "approval") {
    body = { approved: true, wait: false };
  } else if (mcpElicit?.mode === "form") {
    body = { approved: true, answer: content, wait: false };
  } else {
    body = {
      approved: true,
      answer: "answer" in content ? content.answer : content,
      wait: false,
    };
  }

  try {
    await stub.respondToInput(input.id, body, trustedResponder);
  } catch (err) {
    if (extractApiError(err)?.status !== 409) throw err;
  }
  return true;
}

function formatInputRequiredResult(
  publicOrigin: string,
  agentId: string,
  run: RunRecord,
  requestId: string,
  inputs: PendingInputView[],
): CallToolResult {
  const lines = inputs.map((input) => {
    const prompt = input.prompt ?? {};
    const mcpElicit = prompt.elicitation as { mode?: string; url?: string } | undefined;
    if (input.kind === "approval") {
      const msg = String(
        prompt.message ?? `Approve execution of tool '${String(prompt.tool ?? "tool")}'?`,
      );
      return `- approval ${input.id}: ${msg} ${clip(JSON.stringify(prompt.args ?? {}), 1_000)}`;
    }
    if (mcpElicit?.mode === "url" && mcpElicit.url) {
      return `- url ${input.id}: ${String(prompt.question ?? "Action required")} Open ${mcpElicit.url}, then confirm.`;
    }
    const question = String(prompt.question ?? "Input requested");
    const options = Array.isArray(prompt.options) ? prompt.options.map(String) : [];
    return `- question ${input.id}: ${question}${options.length ? ` (${options.join(", ")})` : ""}`;
  });
  const agentUrl = `${publicOrigin}/v2/agents/${encodeURIComponent(agentId)}`;
  return toolTextResult(
    [
      "The agent is waiting for human input before continuing:",
      ...lines,
      `Answer with POST ${agentUrl}/inputs/<inputId> ({"approved": true|false, "answer": ...}) or the answer_input tool on /v2/mcp. Once answered, call message again with the same text and requestId "${requestId}" to get the resumed reply.`,
    ].join("\n"),
    false,
    {
      status: "input_required",
      runId: run.id,
      requestId,
      inputs,
    },
  );
}

// ============================================================================
// 1. Hosted Tenant MCP Server (`/v2/mcp` and `/mcp`)
// ============================================================================

export async function serveHostedTenantMcp(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  if (request.method === "OPTIONS") return mcpPreflight();

  const publicOrigin = publicOriginFor(request, env);
  let creds: Awaited<ReturnType<typeof parseRequestCredentials>>;
  try {
    creds = await parseRequestCredentials(env, request);
  } catch (err) {
    const apiErr = extractApiError(err);
    if (apiErr?.status === 401) {
      return mcpUnauthorized(request, publicOrigin);
    }
    throw err;
  }

  if (creds.kind === "agent") {
    return Response.json(
      {
        error: "forbidden",
        error_description:
          "Agent-scoped tokens cannot access the tenant MCP server; connect to /v2/agents/<agent>/mcp instead",
      },
      { status: 403, headers: AGENT_MCP_CORS },
    );
  }
  if (creds.kind !== "tenant") {
    return mcpUnauthorized(request, publicOrigin);
  }

  const tenantStub = getTenantStub(env, creds.tenantId);
  const verified = await tenantStub.verifyApiKey(creds.tokenHash);
  if (!verified) {
    return mcpUnauthorized(request, publicOrigin);
  }

  if (request.method !== "POST") return mcpMethodNotAllowed();

  const read = await readBoundedBody(request);
  if (!read.ok) return read.response;
  const messages = parseJsonRpcMessages(read.body);

  const server = createTenantMcpServer(env, ctx, {
    tenantId: verified.tenantId,
    tokenHash: creds.tokenHash,
    publicOrigin,
  });

  const shouldStream = messages.some(
    (m) => m?.method === "tools/call" && m?.params?._meta?.progressToken !== undefined,
  );

  return handleStatelessTransport(request, server, read.body, shouldStream, {});
}

function createTenantMcpServer(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  session: { tenantId: string; tokenHash: string; publicOrigin: string },
): McpServer {
  const { tenantId, tokenHash, publicOrigin } = session;
  const tenantStub = getTenantStub(env, tenantId);
  const cfs = new CamelFsClient(env, tenantId);

  const server = new McpServer(
    { name: "camelrun", title: "CamelRun", version: MCP_SERVER_VERSION },
    { instructions: HOSTED_MCP_INSTRUCTIONS },
  );

  const readAnn = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const addAnn = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  const destructiveAnn = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

  const resolveAgentOrThrow = async (idOrKey: string) => {
    const entry = await tenantStub.resolveAgent(idOrKey);
    if (!entry) {
      throw new ApiError(404, "agent_not_found", `Agent '${idOrKey}' not found`);
    }
    return { entry, stub: getAgentStub(env, entry.id) };
  };

  function register<S extends z.ZodRawShape>(
    name: string,
    title: string,
    description: string,
    inputSchema: S,
    annotations: {
      readOnlyHint: boolean;
      destructiveHint: boolean;
      openWorldHint: boolean;
      idempotentHint?: boolean;
    },
    handler: (args: z.infer<z.ZodObject<S>>, extra: McpExtra) => Promise<unknown>,
    options?: { skipCap?: boolean },
  ) {
    server.registerTool(
      name,
      { title, description, inputSchema, annotations: { title, ...annotations } },
      (async (args: z.infer<z.ZodObject<S>>, extra: McpExtra) => {
        try {
          const result = await handler(args, extra);
          return {
            content: [
              {
                type: "text" as const,
                text: options?.skipCap ? JSON.stringify(result) : cappedResultText(result),
              },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: errorText(err) }],
          };
        }
      }) as any,
    );
  }

  // ---- Account & Billing ----

  register(
    "whoami",
    "Show account",
    "Show the authenticated CamelRun v2 account (tenant), balance, tier, default model, and active concurrency.",
    {},
    readAnn,
    async () => {
      const me = await tenantStub.getMe();
      return {
        ...me,
        defaultModel: env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID,
        url: publicOrigin,
      };
    },
  );

  register(
    "get_billing",
    "Get billing summary",
    "Get the account's credit balance, monthly cap, active agent concurrency, and recent daily usage breakdown.",
    {},
    readAnn,
    async () => tenantStub.getBillingSummary(),
  );

  register(
    "list_models",
    "List models",
    "List available LLM models with provider, reasoning support, max tokens, pricing, and availability for this account.",
    {
      available: z
        .boolean()
        .optional()
        .describe("Only models available to this account (default true)"),
      provider: z.string().min(1).optional().describe("Filter by provider, e.g. openai, anthropic, openrouter"),
      keyScope: z.string().min(1).optional().describe("Optional BYOK key scope"),
    },
    readAnn,
    async ({ available, provider, keyScope }) =>
      listV2Models(env, tenantId, {
        provider: provider ?? null,
        availableOnly: available !== false,
        keyScope: keyScope ?? null,
      }),
    { skipCap: true },
  );

  register(
    "read_docs",
    "Read CamelRun docs",
    "Read concise CamelRun v2 API and Hosted MCP documentation. Omit topic for the documentation index.",
    {
      topic: z
        .string()
        .optional()
        .describe("Topic name: overview, mcp, agents, schedules, camelfs, skills, auth (default: index)"),
      path: z
        .string()
        .optional()
        .describe("Alias for topic (v1 compatibility, e.g. 'llms.txt' or 'guides/definitions.md')"),
    },
    readAnn,
    async ({ topic, path }) => {
      const raw = (topic ?? path ?? "index").trim().toLowerCase();
      const cleaned = raw.replace(/^\/+/, "").replace(/^docs\//, "").replace(/\.md$/, "");
      const aliases: Record<string, string> = {
        "": "index",
        index: "index",
        "llms.txt": "index",
        overview: "overview",
        mcp: "mcp",
        "guides/mcp-server": "mcp",
        "reference/cli": "mcp",
        agents: "agents",
        definitions: "agents",
        "guides/definitions": "agents",
        "guides/tools": "agents",
        schedules: "schedules",
        camelfs: "camelfs",
        repos: "camelfs",
        skills: "skills",
        auth: "auth",
      };
      const resolved = aliases[cleaned];
      if (resolved && CAMELRUN_DOCS[resolved]) {
        return CAMELRUN_DOCS[resolved];
      }
      return `Unknown doc topic '${raw}'.\n\n${CAMELRUN_DOCS.index}`;
    },
  );

  // ---- Definitions ----

  const definitionIdParam = z.string().min(1).describe("Definition slug");

  register(
    "list_definitions",
    "List definitions",
    "List reusable agent definitions configured in this account (credentials redacted).",
    {},
    readAnn,
    async () => {
      const defs = await tenantStub.listDefinitions();
      return {
        definitions: defs.map((d) =>
          redactDefinition({
            ...d,
            config: (d.config ?? {}) as unknown as Record<string, unknown>,
          }),
        ),
      };
    },
  );

  register(
    "get_definition",
    "Get definition",
    "Get a reusable agent definition by slug (credentials redacted).",
    {
      idOrSlug: definitionIdParam.optional().describe("Definition slug"),
      slug: definitionIdParam.optional().describe("Alias for idOrSlug"),
      definition: definitionIdParam.optional().describe("Alias for idOrSlug (v1 compatibility)"),
    },
    readAnn,
    async ({ idOrSlug, slug, definition }) => {
      const target = (idOrSlug ?? slug ?? definition)?.trim();
      if (!target) {
        throw new ApiError(400, "invalid_request", "Provide `idOrSlug` (definition slug)");
      }
      const def = await tenantStub.getDefinition(target);
      if (!def) {
        throw new ApiError(404, "not_found", `Definition '${target}' not found`);
      }
      return redactDefinition({
        ...def,
        config: (def.config ?? {}) as unknown as Record<string, unknown>,
      });
    },
  );

  register(
    "upsert_definition",
    "Upsert definition",
    "Create or update a reusable agent definition by slug.",
    {
      slug: z.string().min(1).max(80).describe("Definition slug identifier"),
      model: z.string().optional().describe("Model ID from list_models"),
      instructions: z.string().optional().describe("System prompt / instructions"),
      builtins: z.array(z.enum(BUILTIN_SUITES)).optional().describe("Enabled built-in tool suites"),
      skills: z.array(z.string()).optional().describe("Attached tenant skill slugs or globs (e.g. ['camel-bots/*'])"),
      tools: z.array(customToolSchema).optional().describe("Custom HTTP/webhook tools"),
      mcpServers: z.array(mcpServerSchema).optional().describe("External MCP servers to attach"),
      queue: queueConfigSchema.optional().describe("Queue mode configuration (each or batch)"),
      dreaming: dreamingConfigSchema.optional().describe("Idle dreaming consolidation settings"),
      compactThresholdTokens: z.number().int().min(1).optional().describe("Context compaction threshold in tokens"),
      spendLimitUsd: z.number().min(0).optional().describe("Maximum USD spend per agent"),
      idleTtlSeconds: z.number().int().min(0).optional().describe("Idle TTL in seconds"),
      repoId: z.string().nullable().optional().describe("Default CamelFS repo ID"),
      branch: z.string().optional().describe("Default CamelFS branch"),
      keyScope: z.string().nullable().optional().describe("Optional BYOK key scope"),
    },
    { ...destructiveAnn, idempotentHint: true },
    async ({ slug, ...config }) => {
      const cleaned = Object.fromEntries(
        Object.entries(config).filter(([, v]) => v !== undefined),
      ) as AgentUpsertInput;
      if (cleaned.skills !== undefined) {
        cleaned.skills = normalizeSkillSelectors(cleaned.skills);
      }
      const saved = await tenantStub.upsertDefinition(slug.trim(), cleaned);
      return redactDefinition({
        ...saved,
        config: (saved.config ?? {}) as unknown as Record<string, unknown>,
      });
    },
  );

  register(
    "delete_definition",
    "Delete definition",
    "Delete a reusable agent definition by slug. Existing agents keep running with their current config.",
    {
      idOrSlug: definitionIdParam.optional().describe("Definition slug to delete"),
      slug: definitionIdParam.optional().describe("Alias for idOrSlug"),
      definition: definitionIdParam.optional().describe("Alias for idOrSlug (v1 compatibility)"),
    },
    destructiveAnn,
    async ({ idOrSlug, slug, definition }) => {
      const target = (idOrSlug ?? slug ?? definition)?.trim();
      if (!target) {
        throw new ApiError(400, "invalid_request", "Provide `idOrSlug` (definition slug)");
      }
      const deleted = await tenantStub.deleteDefinition(target);
      if (!deleted) {
        throw new ApiError(404, "not_found", `Definition '${target}' not found`);
      }
      return { deleted: true, slug: target };
    },
  );

  // ---- Skills ----

  const skillStore = getSkillStore(env);

  register(
    "list_skills",
    "List tenant skills",
    "List reusable tenant-scoped markdown skills, optionally filtered by slug prefix or tag.",
    {
      prefix: z.string().optional().describe("Optional slug prefix filter (e.g. 'team/')"),
      tag: z.string().optional().describe("Optional tag filter"),
    },
    readAnn,
    async ({ prefix, tag }) => ({
      skills: await skillStore.listSkills(tenantId, {
        prefix: prefix?.trim() || undefined,
        tag: tag?.trim() || undefined,
      }),
    }),
  );

  register(
    "get_skill",
    "Get tenant skill",
    "Get a tenant skill by slug including its markdown body and reference files.",
    {
      slug: z.string().min(1).max(128).describe("Skill slug (e.g. 'team/deploy-guide')"),
    },
    readAnn,
    async ({ slug }) => {
      const skill = await skillStore.getSkill(tenantId, slug.trim());
      if (!skill) {
        throw new ApiError(404, "skill_not_found", `Skill '${slug}' not found`);
      }
      return skill;
    },
  );

  register(
    "upsert_skill",
    "Upsert tenant skill",
    "Create or update a tenant-scoped markdown skill by slug.",
    {
      slug: z.string().min(1).max(128).describe("Skill slug (lowercase segments separated by '/', '-', '_')"),
      markdown: z.string().min(1).describe("Skill markdown content (optional YAML frontmatter)"),
      name: z.string().optional().describe("Optional display name"),
      description: z.string().optional().describe("Optional short description"),
      tags: z.array(z.string()).optional().describe("Optional discovery tags"),
      files: z.record(z.string(), z.string()).optional().describe("Optional relative reference files map"),
    },
    { ...destructiveAnn, idempotentHint: true },
    async ({ slug, markdown, name, description, tags, files }) =>
      skillStore.upsertSkill(tenantId, slug.trim(), {
        markdown,
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(files !== undefined ? { files } : {}),
      }),
  );

  register(
    "delete_skill",
    "Delete tenant skill",
    "Delete a tenant skill by slug.",
    {
      slug: z.string().min(1).max(128).describe("Skill slug to delete"),
    },
    destructiveAnn,
    async ({ slug }) => {
      const clean = slug.trim();
      const res = await skillStore.deleteSkill(tenantId, clean);
      return { ok: true, slug: clean, deleted: res.deleted };
    },
  );

  // ---- Agents & Messaging ----

  const agentParam = z.string().min(1).describe("Agent key or id (agt_...)");

  const listAgentsPaginated = async (opts: {
    limit?: number;
    cursor?: string;
    prefix?: string;
    definitionId?: string;
  }) => {
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    const offset = parseMcpCursor(opts.cursor);
    const prefix = opts.prefix?.trim() || undefined;
    const definitionId = opts.definitionId?.trim() || undefined;

    const raw = (await tenantStub.listAgents({
      limit,
      cursor: offset > 0 ? String(offset) : undefined,
      prefix,
      definitionId,
    })) as unknown;

    // Fallback for warm deferred TenantDOs that ignore the options arg and return an unpaginated array.
    if (Array.isArray(raw)) {
      const filtered = raw.filter((item: { id?: string; key?: string; definition?: string | null }) => {
        if (definitionId && item.definition !== definitionId) return false;
        if (prefix) {
          const k = item.key ?? "";
          const i = item.id ?? "";
          if (!k.startsWith(prefix) && !i.startsWith(prefix)) return false;
        }
        return true;
      });
      const total = filtered.length;
      const agents = filtered.slice(offset, offset + limit);
      const nextOffset = offset + agents.length;
      return {
        agents,
        ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
        total,
      };
    }

    const page = raw as {
      agents: Array<Record<string, unknown>>;
      nextCursor?: string;
      total?: number;
    };
    const agents = Array.isArray(page.agents) ? page.agents.slice(0, limit) : [];
    return {
      agents,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(typeof page.total === "number" ? { total: page.total } : {}),
    };
  };

  register(
    "definition_agents",
    "List a definition's agents",
    "List agents associated with a given definition slug (paginated).",
    {
      definitionId: definitionIdParam.optional().describe("Definition slug to filter agents by"),
      definition: definitionIdParam.optional().describe("Alias for definitionId (v1 compatibility)"),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum agents to return (default 50, max 200)"),
      cursor: z.string().optional().describe("Pagination cursor from previous response"),
    },
    readAnn,
    async ({ definitionId, definition, limit, cursor }) => {
      const target = (definitionId ?? definition)?.trim();
      if (!target) {
        throw new ApiError(400, "invalid_request", "Provide `definitionId` (definition slug)");
      }
      const page = await listAgentsPaginated({ definitionId: target, limit, cursor });
      return { definitionId: target, ...page };
    },
  );

  register(
    "list_agents",
    "List agents",
    "List durable keyed agents in this account with optional pagination and prefix/definition filtering.",
    {
      limit: z.number().int().min(1).max(200).optional().describe("Maximum agents to return (default 50, max 200)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous list_agents call"),
      prefix: z.string().optional().describe("Filter agents whose key or id starts with this prefix"),
      definitionId: z.string().optional().describe("Filter agents by definition slug"),
    },
    readAnn,
    async ({ limit, cursor, prefix, definitionId }) =>
      listAgentsPaginated({ limit, cursor, prefix, definitionId }),
  );

  register(
    "get_agent",
    "Get agent",
    "Get an agent's configuration, active run, last run, and pending inputs (credentials redacted).",
    { agent: agentParam },
    readAnn,
    async ({ agent }) => {
      const { stub } = await resolveAgentOrThrow(agent);
      const state = await stub.getState();
      return redactAgentConfigFields(state as unknown as Record<string, unknown>);
    },
  );

  register(
    "upsert_agent",
    "Create or update agent",
    "Create a durable keyed agent or update an existing agent with the same key (keeping its history).",
    {
      key: z.string().min(1).max(80).describe("Durable key for the agent"),
      definition: z.string().optional().describe("Definition slug to inherit configuration from"),
      model: z.string().optional().describe("Model ID from list_models"),
      instructions: z.string().optional().describe("System prompt / instructions"),
      builtins: z.array(z.enum(BUILTIN_SUITES)).optional().describe("Enabled built-in tool suites"),
      skills: z.array(z.string()).optional().describe("Attached tenant skill slugs or globs (e.g. ['camel-bots/*'])"),
      tools: z.array(customToolSchema).optional().describe("Custom HTTP/webhook tools"),
      mcpServers: z.array(mcpServerSchema).optional().describe("External MCP servers to attach"),
      queue: queueConfigSchema.optional().describe("Queue mode configuration (each or batch)"),
      dreaming: dreamingConfigSchema.optional().describe("Idle dreaming consolidation settings"),
      compactThresholdTokens: z.number().int().min(1).optional().describe("Context compaction threshold in tokens"),
      repoId: z.string().nullable().optional().describe("CamelFS repository ID to attach"),
      branch: z.string().optional().describe("CamelFS branch ref"),
      spendLimitUsd: z.number().min(0).optional().describe("Spend limit in USD"),
      idleTtlSeconds: z.number().int().min(0).optional(),
      keyScope: z.string().nullable().optional().describe("Optional BYOK key scope"),
    },
    { ...destructiveAnn, idempotentHint: true },
    async ({ key, ...rest }) => {
      const trimmedKey = key.trim();
      if (!trimmedKey) {
        throw new ApiError(400, "invalid_request", "Agent key cannot be empty");
      }
      const input = Object.fromEntries(
        Object.entries(rest).filter(([, v]) => v !== undefined),
      ) as AgentUpsertInput;
      if (input.skills !== undefined) {
        input.skills = normalizeSkillSelectors(input.skills);
      }
      const candidateAgentId = randomId("agt", 8);
      const minted = await mintAgentToken(tenantId, candidateAgentId);
      const candidateSealedToken = await sealSecret(minted.token, env.VAULT_SECRET);

      const prep = await tenantStub.authorizeAndPrepareAgent({
        credKind: "tenant",
        tokenHash,
        key: trimmedKey,
        input,
        defaultModel: env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID,
        candidateAgentId,
        candidateTokenHash: minted.tokenHash,
        candidateSealedToken,
      });

      const defCfg = prep.definitionConfig;
      const queueCfg = input.queue
        ? { mode: input.queue.mode ?? "each", windowMs: input.queue.windowMs ?? 0 }
        : defCfg?.queue
          ? { mode: defCfg.queue.mode ?? "each", windowMs: defCfg.queue.windowMs ?? 0 }
          : undefined;
      const dreamingCfg = input.dreaming
        ? {
            enabled: input.dreaming.enabled ?? false,
            idleSeconds: input.dreaming.idleSeconds ?? 3600,
          }
        : defCfg?.dreaming
          ? {
              enabled: defCfg.dreaming.enabled ?? false,
              idleSeconds: defCfg.dreaming.idleSeconds ?? 3600,
            }
          : undefined;

      const initResult = await getAgentStub(env, prep.agentId).initAgent({
        id: prep.agentId,
        tenantId: prep.tenantId,
        key: trimmedKey,
        model: input.model ?? defCfg?.model,
        keyScope:
          input.keyScope !== undefined ? input.keyScope?.trim() || null : defCfg?.keyScope,
        initialModel: prep.model,
        instructions: input.instructions ?? defCfg?.instructions,
        definition: input.definition,
        tools: input.tools ?? defCfg?.tools,
        mcpServers: input.mcpServers ?? defCfg?.mcpServers,
        builtins: input.builtins ?? defCfg?.builtins,
        skills: input.skills !== undefined ? input.skills : defCfg?.skills,
        queue: queueCfg,
        repoId: prep.repoId,
        lineage: prep.lineage,
        branch: prep.branch,
        spendLimitUsd: input.spendLimitUsd ?? defCfg?.spendLimitUsd,
        idleTtlSeconds: input.idleTtlSeconds ?? defCfg?.idleTtlSeconds,
        compactThresholdTokens:
          input.compactThresholdTokens !== undefined
            ? Math.floor(input.compactThresholdTokens)
            : defCfg?.compactThresholdTokens,
        dreaming: dreamingCfg,
      });

      return {
        id: prep.agentId,
        key: trimmedKey,
        repoId: prep.repoId,
        branch: prep.branch,
        model: initResult.config.model,
        created: prep.created,
      };
    },
  );

  register(
    "configure_agent",
    "Configure agent",
    "Patch an existing agent's configuration (model, instructions, spendLimitUsd, compactThresholdTokens, skills, builtins, repoId, branch, etc.) while keeping its history.",
    {
      agent: agentParam,
      model: z.string().min(1).optional().describe("Model ID from list_models"),
      instructions: z.string().optional().describe("Replace system prompt / instructions"),
      spendLimitUsd: z.number().min(0).optional().describe("Spend limit in USD"),
      compactThresholdTokens: z.number().int().min(1).optional().describe("Context compaction threshold in tokens"),
      skills: z.array(z.string()).optional().describe("Attached tenant skill slugs or globs"),
      builtins: z.array(z.enum(BUILTIN_SUITES)).optional().describe("Enabled built-in tool suites"),
      repoId: z.string().nullable().optional().describe("CamelFS repository ID to attach, or null to detach"),
      branch: z.string().min(1).optional().describe("CamelFS branch ref"),
      keyScope: z.string().nullable().optional().describe("Optional BYOK key scope"),
      idleTtlSeconds: z.number().int().min(0).optional().describe("Idle TTL in seconds"),
      tools: z.array(customToolSchema).optional().describe("Custom HTTP/webhook tools"),
      mcpServers: z.array(mcpServerSchema).optional().describe("External MCP servers to attach"),
      queue: queueConfigSchema.optional().describe("Queue mode configuration"),
      dreaming: dreamingConfigSchema.optional().describe("Idle dreaming consolidation settings"),
    },
    destructiveAnn,
    async ({ agent, ...patch }) => {
      const provided = Object.entries(patch).filter(([, v]) => v !== undefined);
      if (provided.length === 0) {
        throw new ApiError(400, "invalid_request", "Provide at least one configuration field to update");
      }
      const { entry, stub } = await resolveAgentOrThrow(agent);

      let nextRepoId: string | null | undefined;
      let nextLineage: string | null | undefined;
      let nextBranch: string | undefined = patch.branch?.trim() || undefined;

      if (patch.repoId !== undefined) {
        if (patch.repoId === null || patch.repoId === "") {
          nextRepoId = null;
          nextLineage = null;
        } else {
          const repo = await tenantStub.getRepo(patch.repoId.trim());
          nextRepoId = repo.repoId;
          nextLineage = repo.lineage;
          if (!nextBranch) nextBranch = repo.defaultRef;
        }
      }

      const normalizedSkills =
        patch.skills !== undefined ? normalizeSkillSelectors(patch.skills) : undefined;

      const initResult = await stub.initAgent({
        id: entry.id,
        tenantId,
        key: entry.key,
        ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
        ...(patch.keyScope !== undefined ? { keyScope: patch.keyScope?.trim() || null } : {}),
        ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
        ...(patch.spendLimitUsd !== undefined ? { spendLimitUsd: patch.spendLimitUsd } : {}),
        ...(patch.compactThresholdTokens !== undefined
          ? { compactThresholdTokens: Math.floor(patch.compactThresholdTokens) }
          : {}),
        ...(normalizedSkills !== undefined ? { skills: normalizedSkills } : {}),
        ...(patch.builtins !== undefined ? { builtins: patch.builtins } : {}),
        ...(patch.idleTtlSeconds !== undefined ? { idleTtlSeconds: patch.idleTtlSeconds } : {}),
        ...(patch.tools !== undefined ? { tools: patch.tools } : {}),
        ...(patch.mcpServers !== undefined ? { mcpServers: patch.mcpServers } : {}),
        ...(patch.queue !== undefined
          ? { queue: { mode: patch.queue.mode ?? "each", windowMs: patch.queue.windowMs ?? 0 } }
          : {}),
        ...(patch.dreaming !== undefined
          ? {
              dreaming: {
                enabled: patch.dreaming.enabled ?? false,
                idleSeconds: patch.dreaming.idleSeconds ?? 3600,
              },
            }
          : {}),
        ...(nextRepoId !== undefined ? { repoId: nextRepoId, lineage: nextLineage ?? null } : {}),
        ...(nextBranch !== undefined ? { branch: nextBranch } : {}),
      });

      if (nextRepoId !== undefined || nextBranch !== undefined) {
        await tenantStub.updateAgentRepo(
          entry.id,
          initResult.config.repoId,
          initResult.config.branch,
        );
      }

      return redactAgentConfigFields(initResult.config as unknown as Record<string, unknown>);
    },
  );

  register(
    "fork_agent",
    "Fork agent",
    "Fork an existing agent into a new agent with a copy of its configuration, conversation history (optionally up to atSeq), and optionally its CamelFS repository.",
    {
      agent: agentParam,
      newKey: z.string().min(1).max(80).optional().describe("Durable key for the forked agent"),
      key: z.string().min(1).max(80).optional().describe("Alias for newKey (v1 compatibility)"),
      name: z.string().min(1).max(80).optional().describe("Optional fallback key name if newKey/key is omitted"),
      atSeq: z.number().int().min(0).optional().describe("Copy messages up to this sequence number (default latest)"),
      forkRepo: z
        .boolean()
        .optional()
        .describe("Also fork the attached CamelFS repository (default true)"),
    },
    addAnn,
    async ({ agent, newKey, key, name, atSeq, forkRepo }) => {
      const { stub } = await resolveAgentOrThrow(agent);
      const targetKey = (newKey ?? key ?? name)?.trim() || undefined;
      const forked = await stub.forkAgent({
        ...(targetKey ? { key: targetKey } : {}),
        ...(atSeq !== undefined ? { atSeq } : {}),
        ...(forkRepo !== undefined ? { forkRepo } : {}),
      });
      const { agentToken: _redactedToken, ...safeFork } = forked;
      return safeFork;
    },
  );

  register(
    "delete_agent",
    "Delete agent",
    "Permanently delete an agent, stopping any active run and purging its history. Confirm before deleting.",
    { agent: agentParam },
    destructiveAnn,
    async ({ agent }) => {
      const { entry, stub } = await resolveAgentOrThrow(agent);
      await stub.destroyAgent();
      await tenantStub.deleteAgentIndex(entry.id);
      return { deleted: true, id: entry.id, key: entry.key };
    },
  );

  register(
    "send_message",
    "Send message to agent",
    "Send a prompt to an agent and wait for its turn to settle (streaming progress when requested). Returns reply text, structured output, usage, filesChanged, and pending inputs if status is input_required.",
    {
      agent: agentParam,
      message: z.string().min(1).describe("Message / prompt to send to the agent"),
      requestId: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe("Optional idempotency key; retrying with the same requestId returns the same run"),
      whileRunning: z
        .enum(["queue", "steer"])
        .optional()
        .describe("Queue behind or steer an active run (default queue)"),
      wait: z.boolean().optional().describe("Wait for the turn to settle (default true)"),
      maxSteps: z.number().int().min(1).max(100).optional(),
      spendLimitUsd: z.number().min(0).optional(),
      outputSchema: z.record(z.string(), z.unknown()).optional(),
    },
    { ...addAnn, openWorldHint: true },
    async (
      { agent, message, requestId, whileRunning, wait, maxSteps, spendLimitUsd, outputSchema },
      extra,
    ) => {
      const { entry, stub } = await resolveAgentOrThrow(agent);
      const shouldWait = wait !== false;

      const inbox = new AsyncInbox<FollowItem>();
      const socket = shouldWait ? await openAgentEventSocket(stub, inbox) : null;
      try {
        const { run } = await startPreparedAgentRun(
          env,
          ctx,
          { kind: "tenant", tenantId, tokenHash },
          entry.id,
          {
            prompt: message,
            idempotencyKey: requestId,
            whileRunning,
            wait: false,
            maxSteps,
            spendLimitUsd,
            outputSchema,
          },
        );
        if (!shouldWait) {
          return summarizeRun({ id: entry.id, key: entry.key }, run);
        }
        const settled = await followRunWithProgress(stub, run, extra, socket, inbox);
        if (settled === "aborted") {
          return {
            agentId: entry.id,
            agentKey: entry.key,
            runId: run.id,
            status: "cancelled_wait",
            note: "The MCP call was cancelled; the agent's run continues in the background.",
          };
        }
        return summarizeRun({ id: entry.id, key: entry.key }, settled);
      } finally {
        try {
          socket?.close(1000, "done");
        } catch {
          // Ignore close errors
        }
      }
    },
  );

  register(
    "get_run",
    "Get agent run",
    "Fetch a run's status, reply text, structured output, usage, pending inputs, or error. Useful after send_message with wait: false.",
    {
      agent: agentParam,
      runId: z.string().min(1).optional().describe("Run ID (run_...)"),
      requestId: z
        .string()
        .min(1)
        .optional()
        .describe("Idempotency key / requestId (alternative to runId)"),
      byIdempotencyKey: z
        .boolean()
        .optional()
        .describe("Look up runId as an idempotency key (default false unless requestId is used)"),
      wait: z
        .boolean()
        .optional()
        .describe("Wait for the run to settle if still running (default false)"),
    },
    readAnn,
    async ({ agent, runId, requestId, byIdempotencyKey, wait }, extra) => {
      const lookupId = (runId ?? requestId)?.trim();
      if (!lookupId) {
        throw new ApiError(400, "invalid_request", "Provide `runId` or `requestId`");
      }
      const { entry, stub } = await resolveAgentOrThrow(agent);
      const useIdempotencyKey = Boolean(byIdempotencyKey || (!runId && requestId));
      const run = await stub.getRun(lookupId, useIdempotencyKey);
      if (!wait || TERMINAL_STATUSES.has(run.status)) {
        return summarizeRun({ id: entry.id, key: entry.key }, run);
      }
      const inbox = new AsyncInbox<FollowItem>();
      const socket = await openAgentEventSocket(stub, inbox);
      try {
        const settled = await followRunWithProgress(stub, run, extra, socket, inbox);
        if (settled === "aborted") {
          return {
            agentId: entry.id,
            agentKey: entry.key,
            runId: run.id,
            status: "cancelled_wait",
            note: "The MCP call was cancelled; the agent's run continues in the background.",
          };
        }
        return summarizeRun({ id: entry.id, key: entry.key }, settled);
      } finally {
        try {
          socket?.close(1000, "done");
        } catch {
          // Ignore close errors
        }
      }
    },
  );

  register(
    "get_history",
    "Get agent history",
    "Read an agent's conversation messages (role, text, tool calls, tool results).",
    {
      agent: agentParam,
      limit: z.number().int().min(1).max(500).optional().describe("Maximum messages to return (default 50)"),
      after: z.number().int().min(0).optional().describe("Return messages after this sequence number"),
    },
    readAnn,
    async ({ agent, limit, after }) => {
      const { entry, stub } = await resolveAgentOrThrow(agent);
      const page = await stub.getHistory({ after: after ?? 0, limit: limit ?? 50 });
      return {
        agentId: entry.id,
        agentKey: entry.key,
        nextAfter: page.nextAfter,
        ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}),
        ...(page.compaction ? { compaction: page.compaction } : {}),
        messages: page.messages.map(flattenHistoryMessage),
      };
    },
  );

  register(
    "list_inputs",
    "List pending inputs",
    "List pending approvals and human questions waiting for an answer on an agent.",
    { agent: agentParam },
    readAnn,
    async ({ agent }) => {
      const { entry, stub } = await resolveAgentOrThrow(agent);
      const runs = await stub.getRunsWithPendingInputs();
      const inputs = runs.flatMap((r) =>
        (r.inputs ?? [])
          .filter((inp) => inp.status === "pending")
          .map((inp) => ({ ...inp, runId: r.id })),
      );
      return {
        agentId: entry.id,
        agentKey: entry.key,
        inputs,
        runs: runs.map((r) => summarizeRun({ id: entry.id, key: entry.key }, r)),
      };
    },
  );

  register(
    "answer_input",
    "Answer pending input",
    "Answer a pending approval or human question on an agent and resume its paused run. Supports both v2 (inputId, approved, answer) and v1/alias (id, value) parameters.",
    {
      agent: agentParam,
      inputId: z.string().min(1).optional().describe("Pending input ID (inp_...)"),
      id: z.string().min(1).optional().describe("Alias for inputId"),
      approved: z
        .boolean()
        .optional()
        .describe("Approve (true) or decline (false). Required for approval inputs; defaults to true for questions."),
      answer: z.unknown().optional().describe("Answer value for question or form inputs"),
      value: z
        .unknown()
        .optional()
        .describe("Alias for approved/answer (v1 compatibility: boolean approves/declines, 'decline' declines, else sets answer)"),
      wait: z.boolean().optional().describe("Wait for the resumed run to settle (default true)"),
    },
    { ...destructiveAnn, openWorldHint: true },
    async ({ agent, inputId, id, approved, answer, value, wait }) => {
      const resolvedInputId = (inputId ?? id)?.trim();
      if (!resolvedInputId) {
        throw new ApiError(400, "invalid_request", "Provide `inputId` (or `id`)");
      }
      let resolvedApproved = approved;
      let resolvedAnswer = answer;
      if (resolvedApproved === undefined && resolvedAnswer === undefined && value !== undefined) {
        if (typeof value === "boolean") {
          resolvedApproved = value;
        } else if (value === "decline") {
          resolvedApproved = false;
        } else {
          resolvedAnswer = value;
        }
      }
      const { entry, stub } = await resolveAgentOrThrow(agent);
      const run = await stub.respondToInput(
        resolvedInputId,
        { approved: resolvedApproved, answer: resolvedAnswer, wait: wait !== false },
        true,
      );
      return summarizeRun({ id: entry.id, key: entry.key }, run);
    },
  );

  register(
    "abort_agent",
    "Abort agent run",
    "Abort an agent's running turn (and optionally its queued runs). History is kept.",
    {
      agent: agentParam,
      keepQueued: z.boolean().optional().describe("Keep queued runs instead of cancelling them"),
    },
    destructiveAnn,
    async ({ agent, keepQueued }) => {
      const { entry, stub } = await resolveAgentOrThrow(agent);
      const res = await stub.abortRuns({ keepQueued });
      return { agentId: entry.id, agentKey: entry.key, ...res };
    },
  );

  // ---- Schedules ----

  register(
    "list_schedules",
    "List agent schedules",
    "List cron, interval, and one-shot schedules configured on an agent.",
    { agent: agentParam },
    readAnn,
    async ({ agent }) => {
      const { entry, stub } = await resolveAgentOrThrow(agent);
      const res = await stub.listSchedules();
      return { agentId: entry.id, agentKey: entry.key, schedules: res.schedules };
    },
  );

  register(
    "add_schedule",
    "Add agent schedule",
    "Create or upsert a scheduled wake-up on an agent using cron (5-field UTC), intervalSeconds, or one-shot runAt.",
    {
      agent: agentParam,
      id: z.string().min(1).max(80).optional().describe("Optional schedule ID to upsert"),
      name: z.string().min(1).max(80).optional().describe("Alias for id"),
      prompt: z.string().min(1).optional().describe("Prompt / message to send when the schedule fires"),
      text: z.string().min(1).optional().describe("Alias for prompt (v1 compatibility)"),
      cron: z.string().min(1).optional().describe("5-field UTC cron expression, e.g. '0 9 * * 1-5'"),
      cronExpr: z.string().min(1).optional().describe("Alias for cron"),
      intervalSeconds: z.number().int().min(1).optional().describe("Repeat interval in seconds"),
      everySeconds: z.number().int().min(1).optional().describe("Alias for intervalSeconds"),
      runAt: z
        .union([z.string(), z.number()])
        .optional()
        .describe("One-shot ISO-8601 timestamp or Unix ms"),
      timezone: z
        .string()
        .optional()
        .describe("Optional timezone note (note: v2 cron expressions currently evaluate in UTC)"),
      enabled: z.boolean().optional().describe("Whether the schedule is enabled (default true)"),
    },
    { ...addAnn, openWorldHint: true },
    async ({
      agent,
      id,
      name,
      prompt,
      text,
      cron,
      cronExpr,
      intervalSeconds,
      everySeconds,
      runAt,
      enabled,
    }) => {
      const effectivePrompt = (prompt ?? text)?.trim();
      if (!effectivePrompt) {
        throw new ApiError(400, "invalid_request", "`prompt` (or `text`) is required");
      }
      const { entry, stub } = await resolveAgentOrThrow(agent);
      const schedule = await stub.createSchedule({
        ...(id ?? name ? { id: (id ?? name)!.trim() } : {}),
        ...((intervalSeconds ?? everySeconds) !== undefined
          ? { intervalSeconds: intervalSeconds ?? everySeconds }
          : {}),
        ...(cron ?? cronExpr ? { cron: (cron ?? cronExpr)!.trim() } : {}),
        ...(runAt !== undefined ? { runAt } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        prompt: effectivePrompt,
      });
      return { agentId: entry.id, agentKey: entry.key, ...schedule };
    },
  );

  register(
    "delete_schedule",
    "Delete agent schedule",
    "Delete a schedule from an agent by scheduleId.",
    {
      agent: agentParam,
      scheduleId: z.string().min(1).describe("Schedule ID (sch_... or custom id)"),
    },
    destructiveAnn,
    async ({ agent, scheduleId }) => {
      const { entry, stub } = await resolveAgentOrThrow(agent);
      await stub.deleteSchedule(scheduleId.trim());
      return { agentId: entry.id, agentKey: entry.key, scheduleId: scheduleId.trim(), deleted: true };
    },
  );

  // ---- CamelFS Repositories ----

  const repoIdParam = z.string().min(1).describe("CamelFS repository ID");

  register(
    "list_repos",
    "List repositories",
    "List the account's versioned CamelFS repositories with pagination and optional prefix filtering.",
    {
      limit: z.number().int().min(1).max(200).optional().describe("Maximum repositories to return (default 50, max 200)"),
      cursor: z.string().optional().describe("Pagination cursor from a previous list_repos call"),
      prefix: z.string().optional().describe("Filter repositories whose repoId or name starts with this prefix"),
    },
    readAnn,
    async ({ limit, cursor, prefix }) => {
      const pageLimit = Math.min(200, Math.max(1, Math.floor(limit ?? 50)));
      const offset = parseMcpCursor(cursor);
      const cleanPrefix = prefix?.trim() || undefined;

      const raw = (await tenantStub.listRepos({
        limit: pageLimit,
        cursor: offset > 0 ? String(offset) : undefined,
        prefix: cleanPrefix,
      })) as unknown;

      // Fallback for warm deferred TenantDOs that ignore the options arg and return RepoRecord[].
      if (Array.isArray(raw)) {
        const filtered = (raw as RepoRecord[]).filter((r) => {
          if (!cleanPrefix) return true;
          return r.repoId.startsWith(cleanPrefix) || r.name.startsWith(cleanPrefix);
        });
        const total = filtered.length;
        const repos = filtered.slice(offset, offset + pageLimit);
        const nextOffset = offset + repos.length;
        return {
          repos,
          ...(nextOffset < total ? { nextCursor: String(nextOffset) } : {}),
          total,
        };
      }

      const page = raw as { repos: RepoRecord[]; nextCursor?: string; total?: number };
      const repos = Array.isArray(page.repos) ? page.repos.slice(0, pageLimit) : [];
      return {
        repos,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        ...(typeof page.total === "number" ? { total: page.total } : {}),
      };
    },
  );

  register(
    "list_files",
    "List repository files",
    "List files and directories in a CamelFS repository.",
    {
      repoId: repoIdParam,
      path: z.string().optional().describe("Optional directory path prefix"),
      at: z.string().optional().describe("Ref or commit (default repo defaultRef)"),
      recursive: z.boolean().optional().describe("List recursively (default true)"),
      glob: z.string().optional().describe("Optional glob filter"),
    },
    readAnn,
    async ({ repoId, path, at, recursive, glob }) => {
      const repo = await tenantStub.getRepo(repoId);
      return cfs.ls(repo.lineage, {
        at: at || repo.defaultRef,
        path: path || "",
        recursive: recursive !== false,
        glob,
      });
    },
  );

  register(
    "read_file",
    "Read repository file",
    "Read a file from a CamelFS repository.",
    {
      repoId: repoIdParam,
      path: z.string().min(1).describe("File path within the repository"),
      at: z.string().optional().describe("Ref or commit (default repo defaultRef)"),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    },
    readAnn,
    async ({ repoId, path, at, offset, limit }) => {
      const repo = await tenantStub.getRepo(repoId);
      return cfs.read(repo.lineage, {
        at: at || repo.defaultRef,
        path,
        offset,
        limit,
      });
    },
  );

  register(
    "write_file",
    "Write repository file",
    "Write or update a file in a CamelFS repository, creating a new commit.",
    {
      repoId: repoIdParam,
      path: z.string().min(1).describe("File path within the repository"),
      content: z.string().optional().describe("UTF-8 text file content"),
      base64: z.string().optional().describe("Base64-encoded binary content (alternative to content)"),
      ref: z.string().optional().describe("Target branch ref (default repo defaultRef)"),
      message: z.string().optional().describe("Commit message"),
      expectedCommit: z.string().optional().describe("Optional optimistic concurrency commit hash"),
    },
    destructiveAnn,
    async ({ repoId, path, content, base64, ref, message, expectedCommit }) => {
      if (content === undefined && base64 === undefined) {
        throw new ApiError(400, "invalid_request", "Provide either `content` or `base64`");
      }
      const repo = await tenantStub.getRepo(repoId);
      const out = await cfs.write(repo.lineage, {
        ref: ref || repo.defaultRef,
        expectedCommit,
        author: `tenant:${tenantId}`,
        message: message || `mcp write ${path}`,
        puts: [{ path, content, base64 }],
      });
      void tenantStub.updateRepoCommit(repo.repoId, out.commit).catch(() => {});
      return out;
    },
  );

  register(
    "grep_files",
    "Search repository files",
    "Search for a pattern across files in a CamelFS repository.",
    {
      repoId: repoIdParam,
      pattern: z.string().min(1).describe("Search pattern"),
      pathPrefix: z.string().optional().describe("Optional path prefix to restrict search"),
      at: z.string().optional().describe("Ref or commit (default repo defaultRef)"),
      maxMatches: z.number().int().min(1).max(500).optional(),
    },
    readAnn,
    async ({ repoId, pattern, pathPrefix, at, maxMatches }) => {
      const repo = await tenantStub.getRepo(repoId);
      return cfs.grep(repo.lineage, {
        at: at || repo.defaultRef,
        pattern,
        pathPrefix,
        maxMatches,
      });
    },
  );

  return server;
}

// ============================================================================
// 2. Per-Agent Hosted MCP Server (`/v2/agents/:idOrKey/mcp`)
// ============================================================================

export async function servePerAgentMcp(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  idOrKey: string,
): Promise<Response> {
  if (request.method === "OPTIONS") return mcpPreflight();

  const publicOrigin = publicOriginFor(request, env);
  let creds: Awaited<ReturnType<typeof parseRequestCredentials>>;
  try {
    creds = await parseRequestCredentials(env, request);
  } catch (err) {
    const apiErr = extractApiError(err);
    if (apiErr?.status === 401) {
      return mcpUnauthorized(request, publicOrigin, idOrKey);
    }
    throw err;
  }

  if (creds.kind !== "tenant" && creds.kind !== "agent") {
    return mcpUnauthorized(request, publicOrigin, idOrKey);
  }

  let prep: Awaited<ReturnType<ReturnType<typeof getTenantStub>["authorizeAndPrepareRun"]>>;
  try {
    prep = await getTenantStub(env, creds.tenantId).authorizeAndPrepareRun({
      credKind: creds.kind,
      tokenHash: creds.tokenHash,
      agentIdFromToken: creds.kind === "agent" ? creds.agentId : undefined,
      idOrKey,
      defaultModel: env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID,
      operation: "run",
      includeProviderCredentials: false,
    });
  } catch (err) {
    const apiErr = extractApiError(err);
    if (apiErr?.status === 401) {
      return mcpUnauthorized(request, publicOrigin, idOrKey);
    }
    if (apiErr) {
      return Response.json(
        { error: { code: apiErr.code, message: apiErr.message } },
        { status: apiErr.status, headers: AGENT_MCP_CORS },
      );
    }
    throw err;
  }

  if (request.method !== "POST") return mcpMethodNotAllowed();

  const read = await readBoundedBody(request);
  if (!read.ok) return read.response;
  const messages = parseJsonRpcMessages(read.body);

  const agentId = prep.agentId;
  const stub = getAgentStub(env, agentId);
  const trustedResponder = creds.kind === "tenant";

  // Handle client JSON-RPC responses to server-initiated elicitation requests (`id: "input:<inputId>"`).
  const elicitationReplies = messages.filter(
    (m) => typeof m?.id === "string" && m.id.startsWith(ELICIT_PREFIX) && m.method === undefined,
  );
  if (elicitationReplies.length > 0) {
    for (const reply of elicitationReplies) {
      const pending = waitingElicitations.get(reply.id);
      if (pending?.agentId === agentId) {
        pending.reply(reply);
        continue;
      }
      const inputId = (reply.id as string).slice(ELICIT_PREFIX.length);
      const runsWithInputs = await stub.getRunsWithPendingInputs().catch(() => [] as RunRecord[]);
      const matchingInput = runsWithInputs
        .flatMap((r) => r.inputs ?? [])
        .find((inp) => inp.id === inputId && inp.status === "pending");
      if (matchingInput) {
        await settleElicitationReply(stub, matchingInput, reply, trustedResponder).catch(() => {});
      }
    }
    return new Response(null, { status: 202, headers: AGENT_MCP_CORS });
  }

  const initialize = messages.find((m) => m?.method === "initialize");
  const elicitationCap = initialize?.params?.capabilities?.elicitation as
    | { form?: unknown; url?: unknown }
    | undefined;
  const sessionId = initialize
    ? crypto.randomUUID().replaceAll("-", "") +
      "." +
      (elicitationCap && (elicitationCap.form || !elicitationCap.url) ? "f" : "") +
      (elicitationCap?.url ? "u" : "")
    : request.headers.get("mcp-session-id");
  const capFlags = sessionId?.split(".")[1] ?? "";
  const can = { form: capFlags.includes("f"), url: capFlags.includes("u") };

  const agentEntry = await getTenantStub(env, creds.tenantId)
    .resolveAgent(agentId)
    .catch(() => null);
  const agentName = agentEntry?.key || idOrKey;

  const server = new McpServer({
    name: "camelrun-agent",
    title: agentName ? `CamelRun agent (${agentName})` : "CamelRun agent",
    version: MCP_SERVER_VERSION,
  });

  server.registerTool(
    "message",
    {
      title: agentName ? `Message ${agentName}` : "Message the agent",
      description: [
        `Send a message to the agent "${agentName}" and get its reply.`,
        "It keeps one conversation with everyone who messages it, so it remembers what was said before. A reply can take minutes.",
      ].join("\n\n"),
      inputSchema: {
        text: z.string().min(1).describe("Your message"),
        requestId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,80}$/)
          .optional()
          .describe(
            "Sending again with the same requestId is the same message: it is not sent twice, and the call returns its reply",
          ),
      },
      annotations: {
        title: agentName ? `Message ${agentName}` : "Message the agent",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    (async (
      { text, requestId }: { text: string; requestId?: string },
      extra: McpExtra,
    ): Promise<CallToolResult> => {
      const derivedId = sessionId
        ? `mcp_${(await sha256Hex(`${sessionId}:${String(extra.requestId)}`)).slice(0, 40)}`
        : `mcp_${crypto.randomUUID().replaceAll("-", "")}`;
      const effectiveRequestId = requestId ?? derivedId;

      return conversePerAgent({
        env,
        ctx,
        creds: {
          kind: creds.kind as "tenant" | "agent",
          tenantId: creds.tenantId,
          tokenHash: creds.tokenHash,
          agentId: creds.kind === "agent" ? creds.agentId : undefined,
        },
        agentId,
        stub,
        publicOrigin,
        can,
        trustedResponder,
        elicit: (id, params, ex) =>
          server.server.transport!.send(
            { jsonrpc: "2.0", id, method: "elicitation/create", params } as any,
            { relatedRequestId: ex.requestId },
          ),
        text,
        requestId: effectiveRequestId,
        extra,
      });
    }) as any,
  );

  return handleStatelessTransport(
    request,
    server,
    read.body,
    messages.some((m) => m?.method === "tools/call"),
    initialize && sessionId ? { "Mcp-Session-Id": sessionId } : {},
  );
}

async function conversePerAgent(opts: {
  env: Env;
  ctx: Pick<ExecutionContext, "waitUntil">;
  creds: { kind: "tenant" | "agent"; tenantId: string; tokenHash: string; agentId?: string };
  agentId: string;
  stub: RpcStub<AgentDO>;
  publicOrigin: string;
  can: { form: boolean; url: boolean };
  trustedResponder: boolean;
  elicit: (id: string, params: Record<string, unknown>, extra: McpExtra) => Promise<void>;
  text: string;
  requestId: string;
  extra: McpExtra;
}): Promise<CallToolResult> {
  const {
    env,
    ctx,
    creds,
    agentId,
    stub,
    publicOrigin,
    can,
    trustedResponder,
    elicit,
    text,
    requestId,
    extra,
  } = opts;

  const inbox = new AsyncInbox<FollowItem>();
  const progress = createProgressReporter(extra);
  const askedIds = new Set<string>();
  const onAbort = () => inbox.push({ kind: "aborted" });
  if (extra.signal.aborted) {
    progress.stop();
    return toolTextResult("The call was cancelled before the message was sent", true);
  }
  extra.signal.addEventListener("abort", onAbort, { once: true });

  const socket = await openAgentEventSocket(stub, inbox);
  const pollTimer = setInterval(() => inbox.push({ kind: "poll" }), socket ? FALLBACK_POLL_MS : 250);

  try {
    let run: RunRecord;
    try {
      const started = await startPreparedAgentRun(env, ctx, creds, agentId, {
        prompt: text,
        idempotencyKey: requestId,
        wait: false,
      });
      run = started.run;
    } catch (err) {
      const apiErr = extractApiError(err);
      if (apiErr?.status === 429) {
        return toolTextResult(
          `The agent is busy: ${apiErr.message}. Try again shortly.`,
          true,
        );
      }
      throw err;
    }

    const targetRunId = run.batchedInto ?? run.id;
    let current: RunRecord = targetRunId !== run.id ? await stub.getRun(targetRunId) : run;

    for (;;) {
      if (current.status === "completed") {
        const replyText =
          current.text ||
          (current.output !== undefined && current.output !== null
            ? JSON.stringify(current.output)
            : "(The agent ended its turn without a reply.)");
        return toolTextResult(replyText, false, {
          status: "completed",
          runId: current.id,
          requestId,
          usage: current.usage,
          ...(current.output !== undefined && current.output !== null
            ? { output: current.output }
            : {}),
        });
      }

      if (current.status === "failed" || current.status === "cancelled") {
        const msg =
          current.error?.message ??
          (current.status === "cancelled" ? "The run was cancelled" : "The run failed");
        return toolTextResult(msg, true, {
          status: current.status,
          runId: current.id,
          requestId,
          ...(current.error ? { error: current.error } : {}),
        });
      }

      if (current.status === "input_required") {
        const pending = (current.inputs ?? []).filter((inp) => inp.status === "pending");
        if (pending.length === 0) {
          current = await stub.getRun(targetRunId);
          continue;
        }
        const nextUnasked = pending.find((inp) => !askedIds.has(inp.id));
        if (nextUnasked) {
          const params = buildElicitationParams(nextUnasked, can);
          if (!params) {
            return formatInputRequiredResult(publicOrigin, agentId, current, requestId, pending);
          }
          const elicitId = `${ELICIT_PREFIX}${nextUnasked.id}`;
          askedIds.add(nextUnasked.id);
          waitingElicitations.set(elicitId, {
            agentId,
            reply: (message) => inbox.push({ kind: "reply", input: nextUnasked, message }),
          });
          const label = String(
            nextUnasked.prompt?.question ??
              nextUnasked.prompt?.message ??
              "Waiting for your input",
          );
          progress.send(`Asking you: ${label}`);
          await elicit(elicitId, params, extra);
        }
      }

      const item = await inbox.next();
      if (item.kind === "aborted") {
        return toolTextResult("The call was cancelled; the agent's turn goes on", true);
      }
      if (item.kind === "poll") {
        current = await stub.getRun(targetRunId);
        continue;
      }
      if (item.kind === "reply") {
        const settled = await settleElicitationReply(
          stub,
          item.input,
          item.message,
          trustedResponder,
        );
        current = await stub.getRun(targetRunId);
        if (!settled) {
          const stillPending = (current.inputs ?? []).filter((inp) => inp.status === "pending");
          if (stillPending.length > 0) {
            return formatInputRequiredResult(
              publicOrigin,
              agentId,
              current,
              requestId,
              stillPending,
            );
          }
        }
        continue;
      }
      if (item.kind === "event" && item.runId === targetRunId) {
        if (
          TERMINAL_EVENT_TYPES.has(item.event.type) ||
          item.event.type === "input_resolved"
        ) {
          current = await stub.getRun(targetRunId);
        } else {
          progress.event(item.event);
        }
      }
    }
  } catch (err) {
    return toolTextResult(errorText(err), true);
  } finally {
    clearInterval(pollTimer);
    extra.signal.removeEventListener("abort", onAbort);
    progress.stop();
    for (const id of askedIds) {
      waitingElicitations.delete(`${ELICIT_PREFIX}${id}`);
    }
    try {
      socket?.close(1000, "done");
    } catch {
      // Ignore close errors
    }
  }
}
