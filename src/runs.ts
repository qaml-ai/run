import { createHash, randomUUID } from "node:crypto";
import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { canonical } from "../shared/durable-json.ts";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { runIdOf, runSessionOf, type ClientSessions, type RunSettings } from "./client-sessions.ts";
import { errorStatus, HttpError, readJson } from "./http.ts";
import * as schema from "./api-schemas.ts";

/**
 * Stateless runs (`/v1/runs`): an agent's configuration and an input in, a result out, nothing carried over. Each run is
 * a single-use session the agents list never shows, so it is as durable as an agent's run (a node lost or retiring
 * mid-run hands it on at its last step boundary), counts against runs per minute and busy agents as one does, and is
 * billed the same. Once it ends its result, events and messages are kept for its retention, then purged.
 */
type Route = (config: RouteConfig, handler: (c: Context<any>) => Promise<Response> | Response) => void;
type Submit = (agent: string, tenant: string, request: { id: string; method: string; params: Record<string, unknown> }) => Promise<RequestRecord>;
export interface RunsContext {
  clients: ClientSessions;
  /** Make a run's session, as POST /v1/agents makes an agent (its definition, model and tool sources resolved alike). */
  createRun?: (tenant: string, params: Record<string, unknown>, key: string, run: RunSettings & { ttlMs: number }) => Promise<{ id: string; existing?: boolean }>;
  submit?: Submit;
  /** A request of an agent once it settles or `waitMs` passes, wherever the agent is served. */
  requestAnywhere?: (agent: string, tenant: string, requestId: string, waitMs: number, signal?: AbortSignal) => Promise<RequestRecord | undefined>;
  /** How long an ended run is kept by default (AGENT_RUN_RETENTION_SECONDS; default a day). */
  runRetentionSeconds?: number;
  /**
   * Refuse a new run now if the tenant has no runs left this minute or is at its busy-agent limit, without counting:
   * a burst past either is turned away before a session is made for each. Accepting the run still decides.
   */
  runPrecheck?: (tenant: string) => Promise<void>;
}

/** The longest a request waits for a run to end (a proxy in front may cut a quiet response off after 100 s). */
export const MAX_RUN_WAIT_MS = 60_000;
/** How long a run's session lives at most before it ends, past which it is purged even if its end was never recorded. */
const RUN_BOUND_MS = 7 * 86_400_000;
const DEFAULT_RETENTION_SECONDS = 86_400;

const json = (c: Context, status: number, value: unknown) => c.json(value, status as ContentfulStatusCode, { "Cache-Control": "no-store" });
const reply = (description: string, value: z.ZodType) => ({ description, content: { "application/json": { schema: value } } });
const runPath = z.object({ id: z.string().openapi({ description: "The run's id (run_…)" }) });
const waitQuery = z.object({ wait: z.string().optional().openapi({ description: "Seconds to wait for the run to end (at most 60 on create, 25 here): it answers as soon as it does, else when the wait ends, still running" }) });

/** A run as the API shows it, from its request: what it answered, or how it failed, and its usage and tool calls. */
export function runView(record: RequestRecord, retentionMs: number) {
  const result = (record.outcome?.result ?? {}) as Record<string, any>;
  const outcome = record.outcome;
  const ended = record.state === "completed";
  const error = !ended ? null
    : outcome?.error !== undefined ? { code: /aborted/i.test(outcome.error) ? "aborted" : "runtime_error", message: outcome.error, ...(outcome.uncertain ? { uncertain: true } : {}) }
    : typeof result.error === "string" ? { code: typeof result.code === "string" ? result.code : /aborted/i.test(result.error) ? "aborted" : "model_error", message: result.error }
    : result.stopped === "spend_limit" ? { code: "spend_limit", message: "The run reached its spend limit" }
    : result.stopped === "turn_limit" ? { code: "turn_limit", message: "The run reached its limit of model responses or time" } : null;
  return {
    id: record.id, status: !ended ? "running" : error ? "failed" : result.stopped === "input_required" ? "input_required" : "completed",
    text: typeof result.reply === "string" ? result.reply : "", ...(result.output !== undefined ? { output: result.output } : {}), error,
    usage: result.usage ?? null, toolCalls: result.toolCalls ?? [], toolErrors: result.toolErrors ?? [], sourceErrors: result.sourceErrors ?? [], files: result.files ?? [],
    ...(record.metadata ? { metadata: record.metadata } : {}), ...(record.startedAt ? { createdAt: record.startedAt } : {}), ...(record.began ? { startedAt: record.began } : {}),
    ...(record.endedAt ? { endedAt: record.endedAt } : {}), expiresAt: ended && record.endedAt ? record.endedAt + retentionMs : null,
    ...(record.resumes ? { resumes: record.resumes } : {}), ...(record.handoffs?.length ? { handoffs: record.handoffs } : {}),
  };
}

/** Seconds to wait, as `wait` gives them (true: the most), in ms within `most`. */
function waitMs(value: unknown, most: number) {
  if (value === undefined || value === false) return 0;
  if (value === true) return most;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new HttpError(400, "wait is true, or a number of seconds");
  return Math.min(seconds * 1000, most);
}

export function runRoutes(route: Route, context: () => RunsContext) {
  const session = (c: Context) => {
    const id = runSessionOf(c.req.param("id")!);
    if (!id) throw new HttpError(404, "Unknown run");
    return id;
  };
  /** The run's request once it ends or `ms` passes, riding out a move between nodes. */
  const settle = async (c: Context, agent: string, tenant: string, record: RequestRecord, ms: number) => {
    const { clients, requestAnywhere } = context();
    const closed = new AbortController();
    (c.env as { outgoing?: { once(event: string, listener: () => void): void } } | undefined)?.outgoing?.once("close", () => closed.abort());
    for (const until = Date.now() + ms; record.state !== "completed" && Date.now() < until && !closed.signal.aborted;) {
      const left = Math.min(until - Date.now(), 25_000);
      try { record = await (requestAnywhere ?? clients.awaitRequest.bind(clients))(agent, tenant, record.id, left, closed.signal) ?? record; }
      catch (error) {
        // Moving between nodes, or its node has no room yet: look again shortly.
        if (![503, 502].includes(errorStatus(error, 500))) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    return record;
  };

  route(createRoute({
    method: "post", path: "/v1/runs",
    request: {
      headers: z.object({ "idempotency-key": z.string().max(255).optional().openapi({ description: "Sending the same key with the same body returns the same run (while it is kept); the key with another body is a 409" }) }),
      query: waitQuery, body: { content: { "application/json": { schema: schema.RunInput } } },
    },
    responses: { 200: reply("The run, ended (with wait)", schema.Run), 202: reply("The run, still running: GET /v1/runs/{id} or its events for the rest", schema.Run) },
  }), async c => {
    const { clients, createRun, submit } = context();
    if (!createRun) throw new HttpError(404, "Runs are not enabled on this runtime");
    const tenant = c.var.principal.tenant;
    // Room for inline files (4 MiB, as base64) besides the configuration.
    const body = await readJson(c.req.raw.body, 7 * 1024 * 1024, {});
    const parsed = schema.RunInput.safeParse(body);
    if (!parsed.success) throw new HttpError(400, `${parsed.error.issues[0].path.join(".") || "body"}: ${parsed.error.issues[0].message}`);
    const { input, wait, retentionSeconds, output, spendLimit, actor, from, metadata, name, mounts, ...config } = parsed.data;
    const parts = typeof input === "string" ? [{ type: "text" as const, text: input }] : input;
    const text = parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n\n");
    const files = parts.flatMap(part => part.type === "file" ? [{ ...(part.name !== undefined ? { name: part.name } : {}), data: part.data, ...(part.contentType !== undefined ? { contentType: part.contentType } : {}) }] : []);
    if (!text.trim()) throw new HttpError(400, "input: give the run some text");
    const ms = waitMs(c.req.query("wait") ?? wait, MAX_RUN_WAIT_MS);
    const retentionMs = (retentionSeconds ?? context().runRetentionSeconds ?? DEFAULT_RETENTION_SECONDS) * 1000;
    // What the run is: the same key with another request is refused, never a second run (`wait` is how to answer, not what).
    const { wait: _wait, ...asked } = parsed.data;
    const fingerprint = createHash("sha256").update(canonical(asked)).digest("hex");
    const given = c.req.header("idempotency-key");
    const key = given !== undefined ? `run-${createHash("sha256").update(given).digest("hex").slice(0, 40)}` : randomUUID();
    // A run its key already names is answered as it is; a new one is refused cheaply at a limit.
    if (context().runPrecheck && !(given !== undefined && await clients.owns(clients.agentId(tenant, key), tenant))) await context().runPrecheck!(tenant);
    // No volume unless the run needs files: its inputs', or file tools it asks for.
    const params = { ...config, type: "run", ...(name !== undefined ? { name } : {}), mounts: mounts ?? (files.length || config.fileTools ? undefined : []) };
    const made = await createRun(tenant, params, key, { retentionMs, fingerprint, ttlMs: RUN_BOUND_MS + retentionMs });
    const runId = runIdOf(made.id);
    let record: RequestRecord;
    try {
      record = await (submit ?? clients.submit.bind(clients))(made.id, tenant, { id: runId, method: "prompt", params: {
        text, ...(files.length ? { files } : {}), ...(output ? { output } : {}), ...(spendLimit ? { spendLimit } : {}), ...(actor !== undefined ? { actor } : {}),
        ...(from ? { from } : {}), ...(metadata ? { metadata } : {}), allowDisconnected: true, ...(c.req.header("traceparent") ? { traceparent: c.req.header("traceparent") } : {}),
      } });
    } catch (error) {
      // Refused (busy agents, runs per minute, credit, its input): the session made for it goes, so nothing is left.
      const status = errorStatus(error, 400);
      if (!made.existing && status >= 400 && status < 500) await clients.destroyAgent(made.id, tenant).catch(() => {});
      throw error;
    }
    record = await settle(c, made.id, tenant, record, ms);
    return json(c, record.state === "completed" ? 200 : 202, runView(record, retentionMs));
  });

  route(createRoute({ method: "get", path: "/v1/runs/{id}", request: { params: runPath, query: waitQuery }, responses: { 200: reply("The run: running, or how it ended", schema.Run) } }), async c => {
    const tenant = c.var.principal.tenant, id = session(c);
    const { header, record } = await context().clients.runRecord(id, tenant, waitMs(c.req.query("wait"), 25_000));
    return json(c, 200, runView(record, header.run!.retentionMs));
  });
  route(createRoute({
    method: "get", path: "/v1/runs/{id}/events",
    request: { params: runPath, headers: z.object({ "last-event-id": z.string().optional().openapi({ description: "Resume after this event id. Without one, or one the stream no longer has, it starts with a snapshot of the run so far" }) }) },
    responses: { 200: { description: "Server-sent events as an agent's (`id: <cursor>`, `data: <ClientEvent>`), after a `ready` frame, ending with the run's `response`. A run that ended a while ago answers with its response alone; its messages are at /messages", content: { "text/event-stream": { schema: z.string() } } } },
  }), c => context().clients.runEvents(c, session(c), c.var.principal.tenant));
  route(createRoute({ method: "get", path: "/v1/runs/{id}/messages", request: { params: runPath }, responses: { 200: reply("The run's messages: its input, the model's turns and tool results", schema.History) } }), async c => {
    const tenant = c.var.principal.tenant, id = session(c);
    await context().clients.runRecord(id, tenant);
    return json(c, 200, await context().clients.agentHistory(id, tenant));
  });
  route(createRoute({ method: "post", path: "/v1/runs/{id}/abort", request: { params: runPath }, responses: { 200: reply("The run is aborted: it ends failed, code aborted", z.object({ aborted: z.literal(true) })) } }), async c => {
    const tenant = c.var.principal.tenant, id = session(c);
    await context().clients.runRecord(id, tenant);
    await context().clients.abortAgent(id, tenant);
    return json(c, 200, { aborted: true });
  });
  route(createRoute({ method: "delete", path: "/v1/runs/{id}", request: { params: runPath }, responses: { 200: reply("The run is deleted now, before its retention ends: running, it stops", schema.Deleted) } }), async c => {
    const tenant = c.var.principal.tenant, id = session(c);
    await context().clients.runRecord(id, tenant);
    await context().clients.destroyAgent(id, tenant);
    return json(c, 200, { deleted: true });
  });
}
