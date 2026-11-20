import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { canonical } from "../shared/durable-json.ts";
import { V1_COMPAT_REQUEST_PREFIX, type RequestRecord } from "../shared/client-protocol.ts";
import { RESERVED_CHECK_ERROR, RESERVED_CHECK_PREFIX } from "../shared/monitors.ts";
import type { PromptInput } from "./v1-prompt-schema.ts";
import { activityOf, validId } from "./v1-client-state.ts";
import { HttpError } from "./core/http-error.ts";
import { fetchWithoutRedirects } from "./core/no-redirect.ts";

export type MigratedAgent = {
  tenant: string;
  agent: string;
  destination_tenant: string;
  destination_agent: string;
  event_base: number;
  bridged?: boolean;
};
type ArchivedRequest = (requestId: string) => Promise<RequestRecord | undefined>;
export type CompatibilitySql = { query<Row = unknown>(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> };
type RuntimeRequest = (route: MigratedAgent, path: string, init: RequestInit) => Promise<Response>;

const runResponse = z.object({
  id: z.string(),
  agentId: z.string(),
  idempotencyKey: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  status: z.enum(["queued", "running", "input_required", "completed", "failed", "cancelled"]),
  text: z.string(),
  output: z.unknown(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), ok: z.boolean() })),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() }),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
type Run = z.infer<typeof runResponse>;
export const v2Event = z.object({
  seq: z.number().int().positive(),
  runId: z.string().nullable(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type V2Event = z.infer<typeof v2Event>;
const historyMessage = z.object({
  seq: z.number().int().positive(),
  runId: z.string().nullable(),
  role: z.enum(["user", "assistant", "tool", "system"]),
  content: z.object({
    text: z.string().optional(),
    files: z.array(z.unknown()).optional(),
    toolCalls: z.array(z.object({ id: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) })).optional(),
    toolName: z.string().optional(),
    toolCallId: z.string().optional(),
    isError: z.boolean().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  createdAt: z.number().int().nonnegative(),
});
export type V2HistoryMessage = z.infer<typeof historyMessage>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const waitLimitMs = 25_000;

// Reserve a separate key namespace for the v1 request IDs.
const runKey = (requestId: string) => V1_COMPAT_REQUEST_PREFIX + requestId;

export const unavailable = () => new HttpError(502, "The migrated agent's runtime did not return a valid response", "V2_RUNTIME_UNAVAILABLE");
const conflict = () => new HttpError(409, "Request ID reused with different arguments", "IDEMPOTENCY_CONFLICT");
export const unsupportedV1Operation = () => new HttpError(501, "This operation has no v1 compatibility mapping for the migrated agent", "V1_COMPAT_UNSUPPORTED");
export const cutoverInProgress = () => Object.assign(
  new HttpError(503, "AGENT_V2_CUTOVER: The agent is between runtimes. Retry with the same request ID.", "AGENT_V2_CUTOVER"),
  { retryAfter: 1 },
);

function projectRun(run: Run, id: string, fingerprint: string): RequestRecord {
  const base = { id, method: "prompt" as const, fingerprint, startedAt: run.startedAt };
  if (run.status === "queued") return { ...base, state: "running" };
  const began = run.startedAt;
  if (run.status === "running") return { ...base, began, state: "running" };
  const error = run.error?.message;
  const inputRequired = run.status === "input_required";
  const budgetReached = run.error?.code === "spend_limit_exceeded";
  const status = inputRequired ? "input_required" : budgetReached ? "paused" : run.status === "completed" ? "completed" : "failed";
  const stopped = inputRequired ? "input_required" : budgetReached ? "spend_limit" : undefined;
  return {
    ...base,
    began,
    state: "completed",
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    status,
    ...(error ? { error } : {}),
    ...(stopped ? { stopped } : {}),
    ...(budgetReached ? { stoppedReason: "budget_reached" as const } : {}),
    outcome: { result: {
      reply: run.text,
      output: run.output,
      usage: { input: run.usage.inputTokens, output: run.usage.outputTokens, costUsd: run.usage.costUsd },
      toolCalls: run.toolCalls.map(({ id: toolCallId, name: tool, ok }) => ({ toolCallId, tool, ok })),
      ...(run.error ? { error: run.error.message, code: budgetReached ? "spend_limit" : run.error.code } : {}),
      ...(stopped ? { stopped } : {}),
    } },
  };
}

/** Connects the existing v1 HTTP authentication and agent identity to a fenced v2 destination. */
export class V1Compatibility {
  private readonly sql: CompatibilitySql;
  private readonly request: RuntimeRequest;

  constructor(
    sql: CompatibilitySql,
    request: RuntimeRequest,
  ) {
    this.sql = sql;
    this.request = request;
  }

  static fromEnv(sql: CompatibilitySql, env = process.env) {
    return V1Compatibility.configured(sql, env.AGENT_V2_COMPAT_API_KEYS, env.AGENT_V2_COMPAT_URL);
  }

  static configured(sql: CompatibilitySql, configured?: string, baseUrl?: string, request: typeof fetch = fetch) {
    if (configured === undefined) return undefined;
    let keys: Record<string, string>;
    try {
      keys = z.record(z.string().min(1), z.string().min(1)).parse(JSON.parse(configured));
    } catch {
      throw new Error("AGENT_V2_COMPAT_API_KEYS must be a JSON object mapping destination tenants to keys");
    }
    for (const [tenant, key] of Object.entries(keys)) {
      if (key.split(".")[0] !== `cr_live_${tenant}`) {
        throw new Error("AGENT_V2_COMPAT_API_KEYS must contain a v2 API key for each destination tenant");
      }
    }
    const url = URL.parse(baseUrl ?? "https://run.camelai.com/v2");
    const local = url?.protocol === "http:" && url.hostname === "127.0.0.1";
    if (!url || (!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || !/^\/v2\/?$/.test(url.pathname)) {
      throw new Error("AGENT_V2_COMPAT_URL must be an HTTPS or loopback /v2 API URL");
    }
    const root = new URL("/v2/", url);
    const credentials = new Map(Object.entries(keys));
    return new V1Compatibility(sql, (route, path, init) => {
      const key = credentials.get(route.destination_tenant);
      if (!key) throw new HttpError(503, "The migrated agent's runtime credential is unavailable", "V2_CREDENTIAL_UNAVAILABLE");
      const agentPath = `agents/${encodeURIComponent(route.destination_agent)}`;
      const endpoint = new URL(path === "detail" ? agentPath : `${agentPath}/${path}`, root);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${key}`);
      return fetchWithoutRedirects(request, endpoint, { ...init, headers });
    });
  }

  async route(tenant: string, agent: string, admissionSignal?: AbortSignal): Promise<MigratedAgent | undefined> {
    const deadline = Date.now() + 5_000;
    do {
      const { rows: [row] } = await this.sql.query<{
        tenant: string; agent: string; destination_tenant: string | null; destination_agent: string | null; event_base: number | null;
      }>(`select f.tenant, f.agent, r.destination_tenant, r.destination_agent, r.event_base
        from agent_v2_cutovers f left join agent_v2_routes r using (tenant, agent)
        where f.tenant = $1 and f.agent = $2`, [tenant, agent]);
      if (!row) return undefined;
      const { destination_tenant, destination_agent, event_base } = row;
      if (destination_tenant !== null && destination_agent !== null && event_base !== null) {
        return { tenant, agent, destination_tenant, destination_agent, event_base };
      }
      if (!admissionSignal) return undefined;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw cutoverInProgress();
      await delay(Math.min(remaining, 250), undefined, { signal: admissionSignal });
    } while (!admissionSignal.aborted);
    throw admissionSignal.reason;
  }

  private async fingerprint(route: MigratedAgent, id: string) {
    if (route.bridged) return undefined;
    const { rows } = await this.sql.query<{ fingerprint: string }>(
      "select fingerprint from agent_v2_requests where tenant = $1 and agent = $2 and request_id = $3",
      [route.tenant, route.agent, id],
    );
    return rows[0]?.fingerprint;
  }

  private async reserve(route: MigratedAgent, id: string, fingerprint: string) {
    if (route.bridged) return true;
    const result = await this.sql.query(
      `insert into agent_v2_requests (tenant, agent, request_id, fingerprint) values ($1, $2, $3, $4)
       on conflict (tenant, agent, request_id) do nothing`,
      [route.tenant, route.agent, id, fingerprint],
    );
    if (result.rowCount === 1) return true;
    if (await this.fingerprint(route, id) !== fingerprint) throw conflict();
    return false;
  }

  private async call(route: MigratedAgent, path: string, body?: object, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(5_000);
    try {
      const response = await this.request(route, path, {
        method: body ? "POST" : "GET", headers: body ? { "content-type": "application/json" } : undefined,
        body: body && JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      return { response, data: await response.json() as unknown };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unavailable();
    }
  }

  private async run(route: MigratedAgent, id: string, body?: object, signal?: AbortSignal): Promise<Run | undefined> {
    const idempotencyKey = runKey(id);
    const { response, data } = await this.call(route,
      body ? "runs" : `runs/${encodeURIComponent(idempotencyKey)}?by=idempotency-key`,
      body && { ...body, idempotencyKey, wait: false }, signal);
    if (!response.ok) {
      const failure = z.object({ error: z.object({ code: z.string() }) }).safeParse(data);
      const code = failure.data?.error.code;
      if (!body && response.status === 404 && code === "run_not_found") return undefined;
      if (body && response.status === 402) throw new HttpError(402, "The v2 runtime refused the run for insufficient credit", "V2_CREDIT_REQUIRED");
      if (body && response.status === 429) throw new HttpError(429, "The v2 runtime is at its run limit", "V2_RUN_LIMIT");
      throw unavailable();
    }
    const run = runResponse.safeParse(data);
    if (!run.success || run.data.agentId !== route.destination_agent || run.data.idempotencyKey !== idempotencyKey) throw unavailable();
    return run.data;
  }

  async state(route: MigratedAgent, archived: Promise<RequestRecord[]>, signal?: AbortSignal) {
    const [{ response, data }, source] = await Promise.all([this.call(route, "runs", undefined, signal), archived]);
    const state = z.object({
      cursor: z.number().int().nonnegative(),
      activeRunId: z.string().nullable(),
      runs: z.array(runResponse),
    }).safeParse(data);
    if (!response.ok || !state.success) throw unavailable();
    const cursor = route.event_base + state.data.cursor;
    if (!Number.isSafeInteger(cursor)) throw unavailable();
    const keyed = state.data.runs.map(run => {
      if (run.agentId !== route.destination_agent) throw unavailable();
      const v1Id = this.v1RequestId(run);
      return { run, v1Id };
    });
    const v1Ids = route.bridged ? [] : keyed.flatMap(({ v1Id }) => v1Id === undefined ? [] : [v1Id]);
    const { rows } = v1Ids.length ? await this.sql.query<{ request_id: string; fingerprint: string }>(
      "select request_id, fingerprint from agent_v2_requests where tenant = $1 and agent = $2 and request_id = any($3::text[])",
      [route.tenant, route.agent, v1Ids],
    ) : { rows: [] };
    const fingerprints = new Map(rows.map(row => [row.request_id, row.fingerprint]));
    const projected = keyed.map(({ v1Id, run }) => {
      if (v1Id === undefined) return this.nativeRunView(run);
      const fingerprint = route.bridged ? `v2:${run.id}` : fingerprints.get(v1Id);
      if (!fingerprint) throw unsupportedV1Operation();
      return projectRun(run, v1Id, fingerprint);
    });
    const activity = activityOf(projected);
    const activeRun = projected[state.data.runs.findIndex(run => run.id === state.data.activeRunId)]?.id ?? null;
    return { cursor, requests: [...source, ...projected], ...activity, activeRun };
  }

  async detail(route: MigratedAgent, signal?: AbortSignal) {
    const { response, data } = await this.call(route, "detail", undefined, signal);
    const result = z.object({
      id: z.string(), model: z.string(), instructions: z.string().nullish(),
      status: z.enum(["running", "idle"]), activeRunId: z.string().nullable(),
      tools: z.array(z.object({ name: z.string(), description: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional() })).optional(),
      mcpServers: z.array(z.object({ name: z.string(), url: z.string().optional() })).optional(),
      builtins: z.array(z.string()).optional(),
    }).safeParse(data);
    if (!response.ok || !result.success || result.data.id !== route.destination_agent) throw unavailable();
    return result.data;
  }

  private v1RequestId(run: Run) {
    const key = run.idempotencyKey;
    if (!key?.startsWith(V1_COMPAT_REQUEST_PREFIX)) return undefined;
    const id = key.slice(V1_COMPAT_REQUEST_PREFIX.length);
    if (!validId(id)) throw unsupportedV1Operation();
    return id;
  }

  private nativeRunView(run: Run) {
    // The identity in a read-only native record describes its immutable run. Only stored legacy receipts authorize v1 replay.
    return projectRun(run, run.idempotencyKey ?? run.id, `v2:${run.id}`);
  }

  private async readRun(route: MigratedAgent, runId: string, signal?: AbortSignal) {
    const { response, data } = await this.call(route, `runs/${encodeURIComponent(runId)}`, undefined, signal);
    const run = runResponse.safeParse(data);
    if (!response.ok || !run.success || run.data.id !== runId || run.data.agentId !== route.destination_agent) throw unavailable();
    return run.data;
  }

  async requestByRunId(route: MigratedAgent, runId: string, signal?: AbortSignal) {
    const run = await this.readRun(route, runId, signal);
    const id = this.v1RequestId(run);
    if (id === undefined) return this.nativeRunView(run);
    const fingerprint = route.bridged ? `v2:${run.id}` : await this.fingerprint(route, id);
    if (!fingerprint) throw unsupportedV1Operation();
    return projectRun(run, id, fingerprint);
  }

  async eventPage(route: MigratedAgent, after: number | "latest", signal: AbortSignal) {
    const { response, data } = await this.call(route, `events?after=${after}`, undefined, signal);
    const page = z.object({
      events: z.array(v2Event),
      nextAfter: z.number().int().nonnegative(),
    }).safeParse(data);
    if (!response.ok || !page.success) throw unavailable();
    return page.data;
  }

  async historyBatch(route: MigratedAgent, range: { after: number } | { before: number | "latest" }, limit: number, signal: AbortSignal) {
    const cursor = "after" in range ? `after=${range.after}` : `before=${range.before}`;
    const { response, data } = await this.call(route, `history?${cursor}&limit=${limit}`, undefined, signal);
    const page = z.object({ messages: z.array(historyMessage).max(limit) }).safeParse(data);
    if (!response.ok || !page.success) throw unavailable();
    return page.data.messages;
  }

  async eventStream(route: MigratedAgent, after: number, controller: AbortController) {
    const deadline = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.request(route, `events?after=${after}&follow=1`, {
        headers: { accept: "text/event-stream" }, signal: controller.signal,
      });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel();
        throw unavailable();
      }
      return response.body;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(deadline);
    }
  }

  async prompt(route: MigratedAgent, id: string, body: z.infer<typeof PromptInput>, archived: ArchivedRequest, signal?: AbortSignal) {
    if (!validId(id)) throw new HttpError(400, "Invalid request");
    if (id.startsWith(RESERVED_CHECK_PREFIX)) throw new HttpError(400, RESERVED_CHECK_ERROR);
    const { requestId: _id, text, actor, whileRunning, allowDisconnected, history, files, ...options } = body;
    const params = { ...(text !== undefined ? { text } : {}), ...(actor !== undefined ? { actor } : {}),
      ...(history !== undefined ? { history } : {}), ...(files !== undefined ? { files } : {}),
      ...options, ...(whileRunning === "steer" ? { whileRunning } : {}) };
    const fingerprint = sha(canonical({ method: "prompt", params }));
    const existing = await this.fingerprint(route, id);
    if (existing !== undefined && existing !== fingerprint) throw conflict();
    if (existing === undefined) {
      const source = await archived(id);
      if (source) {
        if (source.fingerprint !== fingerprint) throw conflict();
        return source;
      }
    }
    if (!text || (!route.bridged && (files?.length || allowDisconnected !== undefined || whileRunning === "steer"
      || Object.keys(options).length)) || (actor !== undefined && (!actor.trim() || actor.length > 200))) {
      throw new HttpError(501, "This prompt uses options that have no v1 compatibility mapping", "V1_COMPAT_UNSUPPORTED");
    }
    const outputOption = route.bridged && "output" in options && options.output ? { outputSchema: options.output } : {};
    const firstAttempt = existing === undefined && await this.reserve(route, id, fingerprint);
    const found = firstAttempt ? undefined : await this.run(route, id, undefined, signal);
    const run = found ?? await this.run(route, id, {
      prompt: text,
      actor,
      ...(route.bridged && whileRunning === "steer" ? { whileRunning: "steer" } : {}),
      ...outputOption,
    }, signal);
    if (!run) throw unavailable();
    return projectRun(run, id, fingerprint);
  }

  async requestFor(route: MigratedAgent, id: string, waitSeconds: string | undefined, archived: ArchivedRequest, signal?: AbortSignal) {
    const wait = Number(waitSeconds ?? 0);
    if (!Number.isFinite(wait) || wait < 0) throw new HttpError(400, "wait is a number of seconds");
    if (!validId(id)) throw new HttpError(404, "Unknown request");
    const fingerprint = route.bridged ? `v2:${id}` : await this.fingerprint(route, id);
    if (!fingerprint) {
      const record = await archived(id);
      if (record) return record;
      throw new HttpError(404, "Unknown request");
    }
    const deadline = Date.now() + Math.min(wait * 1000, waitLimitMs);
    for (;;) {
      const run = await this.run(route, id, undefined, signal);
      if (!run) throw new HttpError(404, "Unknown request");
      const record = projectRun(run, id, route.bridged ? `v2:${run.id}` : fingerprint);
      const remaining = deadline - Date.now();
      if (record.state === "completed" || remaining <= 0) return record;
      await delay(Math.min(remaining, 500), undefined, { signal });
    }
  }
}
