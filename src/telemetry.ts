import type { Accounts, Sealed } from "./accounts.ts";
import type { Db } from "./db.ts";
import { HttpError } from "./http.ts";
import { errorClass, metricLine, safeError, writeMetricLine } from "./metrics.ts";
import { OutboundBlocked, type Outbound } from "./outbound.ts";
import { formatTraceparent, newSpanId, newTraceId, otlpJson, otlpProtobuf, SpanKind, type Attributes, type Span } from "./otlp.ts";

/**
 * Trace export: a tenant names an OTLP/HTTP endpoint (`PUT /v1/telemetry`), and every node exports the spans of the
 * runs it serves for that tenant's agents there. A run is one trace (or part of the caller's, from its `traceparent`):
 * a span for the run, under it one per model call, tool call, compaction and wait for a person. The run's trace and
 * span ids are in its request record, so a run that moves to another node, or resumes after an input, stays in it.
 *
 * Spans carry ids, names, models, token counts, costs and outcomes. What people and models wrote (prompts, replies,
 * tool arguments and results, inputs' questions, errors' messages) is exported only when the tenant opts in
 * (`include.content`). Export never holds up a run: spans queue in memory, bounded per node and per tenant, and are
 * sent in batches through the outbound guard, retried with backoff; spans that do not fit or cannot be sent are
 * dropped and counted (`telemetry_spans` metric lines).
 */

export const PROTOCOLS = ["http/protobuf", "http/json"] as const;
export type Protocol = typeof PROTOCOLS[number];
/** A tenant's telemetry as runs read it. */
export type TraceSettings = { endpoint: string; protocol: Protocol; sampleRate: number; content: boolean; headers: Sealed | null };
/** A tenant's telemetry as the API shows it: header names only, never their values. */
export type TelemetryView = {
  endpoint: string; protocol: Protocol; sampleRate: number; include: { content: boolean }; headers: string[];
  createdAt: number; updatedAt: number; setBy: string | null;
  status: { lastExportAt: number | null; lastError: string | null; lastErrorAt: number | null };
};
/** What ClientSessions needs of tracing: whether a tenant exports (and how), and somewhere to put finished spans. */
export interface Tracing {
  settings(tenant: string): Promise<Pick<TraceSettings, "content" | "sampleRate"> | undefined>;
  record(tenant: string, span: Span): void;
}

/** Where nodes hear that a tenant's telemetry changed (payload: the tenant), so they read it again. */
export const TELEMETRY_CHANNEL = "agent_runtime_telemetry";

export const TELEMETRY_LIMITS = Object.freeze({
  /** Spans waiting to be sent on one node, all tenants together, and for one tenant. */
  nodeSpans: 20_000, tenantSpans: 5_000,
  /** Their approximate size on one node. */
  nodeBytes: 64 * 1024 * 1024,
  /** Spans in one export request. */
  batch: 512,
  /** Attempts at a batch before it is dropped; between them, backoff from 1 s doubling to a minute. */
  attempts: 5,
  /** One content attribute's characters (a prompt, a reply, a tool's arguments or result). */
  contentChars: 16_384,
  headers: 16, headerChars: 4_096, endpointChars: 2_048,
});
const TIMEOUT_MS = 10_000;
const SCOPE = { name: "camelrun", version: "1.0.0" };
const aad = (tenant: string) => `telemetry:${tenant}`;
/** Headers a tenant may not set: the request's own framing, and what the exporter sets. */
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "content-encoding", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer", "proxy-authorization", "proxy-connection"]);

type Counts = { exported: number; dropped: Record<string, number> };
type Queue = { spans: Span[]; bytes: number; attempts: number; retryAt: number; sending: boolean; failing?: string; loggedAt: number };

/** The approximate memory a queued span takes: its strings, and a fixed amount for the rest. */
function spanBytes(span: Span) {
  let bytes = 256 + span.name.length * 2;
  for (const [key, value] of Object.entries(span.attributes)) bytes += 48 + key.length * 2 + (typeof value === "string" ? value.length * 2 : Array.isArray(value) ? value.reduce((sum, item) => sum + item.length * 2, 0) : 8);
  return bytes;
}

/** What a failed export says to the tenant (the API's `status.lastError`): a status, our guard's refusal, or how the connection failed. */
function failureText(error: unknown) {
  if (error instanceof OutboundBlocked) return error.message;
  const cause = (error as { cause?: { code?: unknown } })?.cause;
  const code = typeof cause?.code === "string" ? cause.code : (error as { code?: unknown })?.code;
  return `Could not connect${typeof code === "string" && /^[\w.-]{1,40}$/.test(code) ? ` (${code})` : ""}`;
}

function headersInput(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "headers must be an object of header names to values");
  const headers = Object.entries(value as Record<string, unknown>);
  if (headers.length > TELEMETRY_LIMITS.headers) throw new HttpError(400, `At most ${TELEMETRY_LIMITS.headers} headers`);
  const out: Record<string, string> = {};
  for (const [name, text] of headers) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name)) throw new HttpError(400, `Invalid header name ${JSON.stringify(name.slice(0, 100))}`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw new HttpError(400, `The exporter sets ${name} itself`);
    if (typeof text !== "string" || text.length > TELEMETRY_LIMITS.headerChars || /[\r\n\0]/.test(text)) throw new HttpError(400, `Header ${name} must be a string of at most ${TELEMETRY_LIMITS.headerChars} characters on one line`);
    out[name.toLowerCase()] = text;
  }
  return out;
}

const viewOf = (row: any): TelemetryView => ({
  endpoint: row.endpoint, protocol: row.protocol, sampleRate: Number(row.sample_rate), include: { content: row.include_content }, headers: row.header_names,
  createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), setBy: row.set_by ?? null,
  status: { lastExportAt: row.last_export_at === null ? null : Number(row.last_export_at), lastError: row.last_error, lastErrorAt: row.last_error_at === null ? null : Number(row.last_error_at) },
});

export class Telemetry implements Tracing {
  private readonly db: Db;
  private readonly accounts: Accounts;
  private readonly outbound: Outbound;
  private readonly limits: Record<keyof typeof TELEMETRY_LIMITS, number>;
  private readonly intervalMs: number;
  private readonly retryBaseMs: number;
  private readonly ttlMs: number;
  /** Each tenant's settings as this node last read them; a change on any node is heard at once (TELEMETRY_CHANNEL). */
  private readonly cached = new Map<string, { settings: Promise<TraceSettings | undefined>; until: number }>();
  private readonly queues = new Map<string, Queue>();
  private queued = 0;
  private bytes = 0;
  /** Since the last `telemetry_spans` lines, by tenant. */
  private counts = new Map<string, Counts>();
  /** Every span this node exported or dropped, by reason, since it started (tests and diagnostics). */
  readonly totals: Counts = { exported: 0, dropped: {} };
  /** When each tenant's export status was last written, so a busy tenant writes it at most once a minute. */
  private readonly statusAt = new Map<string, { at: number; failing: boolean }>();
  private timer?: ReturnType<typeof setInterval>;
  /** Export requests in flight. */
  private readonly sending = new Set<Promise<void>>();
  private readonly resource: Attributes;

  constructor(options: { db: Db; accounts: Accounts; outbound: Outbound; limits?: Partial<Record<keyof typeof TELEMETRY_LIMITS, number>>; intervalMs?: number; retryBaseMs?: number; ttlMs?: number; service?: string }) {
    this.db = options.db;
    this.accounts = options.accounts;
    this.outbound = options.outbound;
    this.limits = { ...TELEMETRY_LIMITS, ...options.limits };
    this.intervalMs = options.intervalMs ?? 2_000;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.ttlMs = options.ttlMs ?? 60_000;
    this.resource = { "service.name": "camelrun", "telemetry.sdk.name": "camelrun", "telemetry.sdk.language": "nodejs", ...(options.service ? { "camelrun.service": options.service } : {}) };
  }

  // Settings ----------------------------------------------------------------------------------------

  /** The tenant's settings, as this node last read them; undefined when it exports nothing (or they could not be read). */
  settings(tenant: string): Promise<TraceSettings | undefined> {
    const cached = this.cached.get(tenant);
    if (cached && cached.until > Date.now()) return cached.settings;
    if (this.cached.size >= 10_000) for (const [key, entry] of this.cached) if (entry.until <= Date.now()) this.cached.delete(key);
    const settings = this.db.query("select endpoint, protocol, sample_rate, include_content, headers from telemetry_exporters where tenant = $1", [tenant])
      .then(({ rows }) => rows[0] && { endpoint: rows[0].endpoint, protocol: rows[0].protocol, sampleRate: Number(rows[0].sample_rate), content: rows[0].include_content, headers: rows[0].headers }, () => {
        this.cached.delete(tenant);
        return undefined;
      });
    this.cached.set(tenant, { settings, until: Date.now() + this.ttlMs });
    return settings;
  }

  forget(tenant: string) { this.cached.delete(tenant); }

  private async changed(tenant: string) {
    this.forget(tenant);
    await this.db.query("select pg_notify($1, $2)", [TELEMETRY_CHANNEL, tenant]).catch(() => {});
  }

  async get(tenant: string): Promise<TelemetryView | undefined> {
    const row = (await this.db.query("select * from telemetry_exporters where tenant = $1", [tenant])).rows[0];
    return row && viewOf(row);
  }

  /**
   * Set where the tenant's traces go, and how. A field left out keeps its current value (its default, the first time;
   * `endpoint` is needed then). Stored `headers` stay while the endpoint keeps its origin and are dropped when it
   * moves (credentials never follow an endpoint elsewhere); `{}` removes them.
   */
  async set(tenant: string, input: { endpoint?: unknown; headers?: unknown; protocol?: unknown; sampleRate?: unknown; include?: unknown }, setBy: string | null = null): Promise<TelemetryView> {
    const current = (await this.db.query("select endpoint, origin, protocol, sample_rate, include_content from telemetry_exporters where tenant = $1", [tenant])).rows[0];
    const given = input.endpoint ?? current?.endpoint;
    if (typeof given !== "string" || !given || given.length > this.limits.endpointChars) throw new HttpError(400, `endpoint must be the URL of an OTLP/HTTP traces receiver, at most ${this.limits.endpointChars} characters`);
    let url: URL;
    try { url = this.outbound.check(given); } catch (error) { throw new HttpError(400, (error as Error).message); }
    if (url.search || url.hash) throw new HttpError(400, "endpoint takes no query or fragment");
    // A collector's base URL (https://collector:4318) means its traces path, as OTEL_EXPORTER_OTLP_ENDPOINT does.
    if (url.pathname === "/") url.pathname = "/v1/traces";
    const endpoint = url.toString();
    const protocol = input.protocol ?? current?.protocol ?? "http/protobuf";
    if (!PROTOCOLS.includes(protocol as Protocol)) throw new HttpError(400, `protocol is ${PROTOCOLS.join(" or ")}`);
    const sampleRate = input.sampleRate ?? (current ? Number(current.sample_rate) : 1);
    if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) throw new HttpError(400, "sampleRate is a number from 0 to 1");
    const include = input.include ?? {};
    if (!include || typeof include !== "object" || Array.isArray(include) || Object.keys(include).some(key => key !== "content") || ((include as { content?: unknown }).content !== undefined && typeof (include as { content?: unknown }).content !== "boolean")) {
      throw new HttpError(400, "include is { content: boolean }");
    }
    const content = (include as { content?: boolean }).content ?? current?.include_content === true;
    const headers = input.headers === undefined ? undefined : headersInput(input.headers);
    if (!this.accounts.canStoreKeys && headers && Object.keys(headers).length) throw new HttpError(503, "This runtime is not configured to store secrets (AGENT_SECRETS_KEY), so it cannot keep telemetry headers");
    const now = Date.now();
    // Stored headers stay only for an endpoint at the origin they were given for.
    const keep = headers === undefined && current?.origin === url.origin;
    const sealed = headers && Object.keys(headers).length ? this.accounts.seal(aad(tenant), JSON.stringify(headers)) : null;
    const { rows } = await this.db.query(`
      insert into telemetry_exporters (tenant, endpoint, origin, protocol, sample_rate, include_content, headers, header_names, created_at, updated_at, set_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $11)
      on conflict (tenant) do update set endpoint = excluded.endpoint, set_by = excluded.set_by, origin = excluded.origin, protocol = excluded.protocol, sample_rate = excluded.sample_rate,
        include_content = excluded.include_content, updated_at = excluded.updated_at, last_error = null, last_error_at = null,
        headers = case when $10 then telemetry_exporters.headers else excluded.headers end,
        header_names = case when $10 then telemetry_exporters.header_names else excluded.header_names end
      returning *`, [tenant, endpoint, url.origin, protocol, sampleRate, content, sealed, headers ? Object.keys(headers).sort() : [], now, keep, setBy]);
    await this.changed(tenant);
    return viewOf(rows[0]);
  }

  /** Stop exporting the tenant's traces; spans already queued on this node are dropped as they come up. */
  async clear(tenant: string) {
    const { rowCount } = await this.db.query("delete from telemetry_exporters where tenant = $1", [tenant]);
    await this.changed(tenant);
    return !!rowCount;
  }

  /** Send one span now, and say what the endpoint answered: for checking an endpoint and its headers. */
  async test(tenant: string) {
    const settings = await this.read(tenant);
    if (!settings) throw new HttpError(404, "No telemetry is set; PUT /v1/telemetry first");
    const now = Date.now();
    const span: Span = {
      traceId: newTraceId(), spanId: newSpanId(), name: "camelrun test span", kind: SpanKind.internal, start: now - 1, end: now,
      attributes: { "camelrun.tenant": tenant, "camelrun.test": true }, status: { code: "ok" },
    };
    const sent = await this.send(settings, tenant, [span]);
    await this.writeStatus(tenant, sent.ok ? undefined : sent.error, true);
    return { ok: sent.ok, ...(sent.status ? { status: sent.status } : {}), ...(sent.ok ? {} : { error: sent.error }), traceId: span.traceId, spanId: span.spanId };
  }

  /** The settings straight from the database (the test span, which must see a change made a moment ago). */
  private async read(tenant: string): Promise<TraceSettings | undefined> {
    const row = (await this.db.query("select endpoint, protocol, sample_rate, include_content, headers from telemetry_exporters where tenant = $1", [tenant])).rows[0];
    return row && { endpoint: row.endpoint, protocol: row.protocol, sampleRate: Number(row.sample_rate), content: row.include_content, headers: row.headers };
  }

  // Export ------------------------------------------------------------------------------------------

  /** Queue a finished span for its tenant's endpoint; one that does not fit is dropped and counted. */
  record(tenant: string, span: Span) {
    const queue = this.queues.get(tenant) ?? { spans: [], bytes: 0, attempts: 0, retryAt: 0, sending: false, loggedAt: 0 };
    const bytes = spanBytes(span);
    if (queue.spans.length >= this.limits.tenantSpans || this.queued >= this.limits.nodeSpans || this.bytes + bytes > this.limits.nodeBytes) {
      this.count(tenant, "queue_full", 1);
      return;
    }
    queue.spans.push(span);
    queue.bytes += bytes;
    this.queued++;
    this.bytes += bytes;
    this.queues.set(tenant, queue);
    // A full batch goes at once, without waiting for the timer.
    if (queue.spans.length >= this.limits.batch && !queue.sending && queue.retryAt <= Date.now()) void this.sendQueue(tenant, queue);
  }

  start() {
    this.timer ??= setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref();
  }

  /** Send what is due now, every tenant's at once; resolves when those sends end. */
  async flush(): Promise<void> {
    const due = [...this.queues].filter(([, queue]) => queue.spans.length && !queue.sending && queue.retryAt <= Date.now());
    await Promise.all(due.map(([tenant, queue]) => this.sendQueue(tenant, queue)));
    this.emitCounts();
  }

  /** Stop the timer and send what is queued, within `deadlineMs`; what is left is dropped. */
  async close(deadlineMs = 5_000) {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const deadline = Date.now() + deadlineMs;
    const drain = async () => {
      while (this.queued > 0 && Date.now() < deadline) {
        // Backoff is over: each batch gets its remaining attempts now.
        for (const queue of this.queues.values()) queue.retryAt = 0;
        await Promise.all(this.sending);
        await this.flush();
      }
    };
    await Promise.race([drain(), new Promise(resolve => setTimeout(resolve, deadlineMs).unref())]);
    for (const [tenant, queue] of this.queues) if (queue.spans.length) this.count(tenant, "shutdown", queue.spans.length);
    this.queues.clear();
    this.queued = 0;
    this.bytes = 0;
    this.emitCounts();
  }

  private take(queue: Queue, spans: Span[]) {
    for (const span of spans) { const bytes = spanBytes(span); queue.bytes -= bytes; this.bytes -= bytes; }
    this.queued -= spans.length;
  }

  private sendQueue(tenant: string, queue: Queue): Promise<void> {
    queue.sending = true;
    const sending = this.sendBatch(tenant, queue).finally(() => this.sending.delete(sending));
    this.sending.add(sending);
    return sending;
  }

  private async sendBatch(tenant: string, queue: Queue) {
    const batch = queue.spans.slice(0, this.limits.batch);
    try {
      const settings = await this.settings(tenant);
      if (!settings) {
        // Telemetry was cleared: what was queued for it goes nowhere.
        queue.spans.splice(0, batch.length);
        this.take(queue, batch);
        this.count(tenant, "unconfigured", batch.length);
        return;
      }
      const sent = await this.send(settings, tenant, batch);
      if (sent.ok || !sent.retry || queue.attempts + 1 >= this.limits.attempts) {
        queue.spans.splice(0, batch.length);
        this.take(queue, batch);
        queue.attempts = 0;
        queue.retryAt = 0;
        if (sent.ok) this.count(tenant, "exported", batch.length);
        else this.count(tenant, sent.retry ? "failed" : "rejected", batch.length);
      } else {
        queue.attempts++;
        const backoff = Math.min(60_000, this.retryBaseMs * 2 ** (queue.attempts - 1));
        queue.retryAt = Date.now() + Math.max(backoff * (0.5 + Math.random() / 2), sent.retryAfterMs ?? 0);
      }
      if (!sent.ok) this.logFailure(tenant, queue, sent, batch.length);
      await this.writeStatus(tenant, sent.ok ? undefined : sent.error);
    } catch (error) {
      console.error(JSON.stringify({ type: "telemetry_export_failed", tenant, spans: batch.length, error: safeError(error) }));
    } finally {
      queue.sending = false;
      if (!queue.spans.length && this.queues.get(tenant) === queue) this.queues.delete(tenant);
    }
  }

  /** One export request: what came back, whether to try again, and why not, in words safe to show the tenant. */
  private async send(settings: TraceSettings, tenant: string, spans: Span[]): Promise<{ ok: boolean; status?: number; retry?: boolean; retryAfterMs?: number; error?: string }> {
    let headers: Record<string, string> = {};
    if (settings.headers) headers = JSON.parse(this.accounts.unseal(aad(tenant), settings.headers));
    const json = settings.protocol === "http/json";
    const body = json ? JSON.stringify(otlpJson(this.resource, SCOPE, spans)) : new Uint8Array(otlpProtobuf(this.resource, SCOPE, spans));
    try {
      const response = await this.outbound.fetch(settings.endpoint, {
        method: "POST", body, timeoutMs: TIMEOUT_MS, maxBytes: 64 * 1024,
        headers: { ...headers, "Content-Type": json ? "application/json" : "application/x-protobuf" },
      });
      await response.arrayBuffer().catch(() => {});
      if (response.ok) return { ok: true, status: response.status };
      // OTLP/HTTP: 429, 502, 503 and 504 are retryable, honoring Retry-After; other failures are not.
      const retry = [408, 429, 502, 503, 504].includes(response.status);
      const after = Number(response.headers.get("retry-after"));
      return { ok: false, status: response.status, retry, ...(retry && after > 0 ? { retryAfterMs: Math.min(after, 300) * 1000 } : {}), error: `HTTP ${response.status}` };
    } catch (error) {
      // The guard refusing the address will refuse it next time too.
      return { ok: false, retry: !(error instanceof OutboundBlocked && !/No response within/.test(error.message)), error: failureText(error) };
    }
  }

  /** A failed export's log line: the first of a failing spell, then at most one a minute per tenant. */
  private logFailure(tenant: string, queue: Queue, sent: { status?: number; retry?: boolean; error?: string }, spans: number) {
    if (queue.failing && Date.now() - queue.loggedAt < 60_000) return;
    queue.failing = sent.error;
    queue.loggedAt = Date.now();
    console.error(JSON.stringify({ type: "telemetry_export_failed", tenant, spans, attempt: queue.attempts, retry: !!sent.retry, error: safeError(Object.assign(new Error(sent.error ?? "failed"), sent.status ? { status: sent.status } : {})) }));
  }

  /** Record the tenant's last export (or failure) for GET /v1/telemetry: on a change, else at most once a minute. */
  private async writeStatus(tenant: string, error: string | undefined, now = false) {
    const last = this.statusAt.get(tenant);
    const failing = error !== undefined;
    if (!now && last && last.failing === failing && Date.now() - last.at < 60_000) return;
    this.statusAt.set(tenant, { at: Date.now(), failing });
    if (this.statusAt.size > 10_000) this.statusAt.delete(this.statusAt.keys().next().value!);
    await (failing
      ? this.db.query("update telemetry_exporters set last_error = $2, last_error_at = $3 where tenant = $1", [tenant, error!.slice(0, 500), Date.now()])
      : this.db.query("update telemetry_exporters set last_export_at = $2, last_error = null, last_error_at = null where tenant = $1", [tenant, Date.now()])).catch(() => {});
  }

  private count(tenant: string, outcome: string, spans: number) {
    const counts = this.counts.get(tenant) ?? { exported: 0, dropped: {} };
    if (outcome === "exported") { counts.exported += spans; this.totals.exported += spans; }
    else { counts.dropped[outcome] = (counts.dropped[outcome] ?? 0) + spans; this.totals.dropped[outcome] = (this.totals.dropped[outcome] ?? 0) + spans; }
    this.counts.set(tenant, counts);
  }

  /** One `telemetry_spans` line per tenant with spans exported or dropped since the last. */
  private emitCounts() {
    const counts = this.counts;
    this.counts = new Map();
    for (const [tenant, { exported, dropped }] of counts) {
      const droppedTotal = Object.values(dropped).reduce((sum, count) => sum + count, 0);
      writeMetricLine(metricLine("telemetry_spans", {
        dimensions: { Tenant: tenant }, rollups: [[], ["Tenant"]],
        metrics: { SpansExported: exported, SpansDropped: droppedTotal }, properties: { dropped },
      }));
    }
  }

  /** Spans queued on this node now. */
  get pending() { return this.queued; }
}

// Spans of a run ------------------------------------------------------------------------------------

/** A run's place in a trace, kept in its request record: its own span, the span it continues, and whether it is sampled. */
export type RunTrace = { traceId: string; spanId: string; parentSpanId?: string; sampled: boolean };

const clip = (text: string, max: number = TELEMETRY_LIMITS.contentChars) => text.length > max ? `${text.slice(0, max)}…` : text;
const json = (value: unknown) => { try { return clip(JSON.stringify(value) ?? ""); } catch { return ""; } };
/** A message's text, from a string or text blocks. */
const textOf = (content: unknown) => typeof content === "string" ? content
  : Array.isArray(content) ? content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
/** An assistant message in GenAI's output-messages form: its text, reasoning and tool calls. */
function outputMessage(message: any, finishReason?: string) {
  const parts = (Array.isArray(message?.content) ? message.content : []).flatMap((part: any) =>
    part?.type === "text" ? [{ type: "text", content: part.text }]
    : part?.type === "thinking" ? [{ type: "reasoning", content: part.thinking }]
    : part?.type === "toolCall" ? [{ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments }] : []);
  return json([{ role: "assistant", parts, ...(finishReason ? { finish_reason: finishReason } : {}) }]);
}
/**
 * A tool call's arguments and result, as the GenAI conventions name them, and as `input.value` / `output.value`
 * (OpenInference), which LangSmith and Langfuse show as a tool run's input and output.
 */
function toolContent(args: unknown, result: unknown): Attributes {
  const output = result === undefined ? undefined : clip(textOf((result as { content?: unknown })?.content));
  return { "gen_ai.tool.call.arguments": json(args), "input.value": json(args), ...(output !== undefined ? { "gen_ai.tool.call.result": output, "output.value": output } : {}) };
}
const FINISH: Record<string, string> = { stop: "stop", length: "length", toolUse: "tool_call", error: "error", aborted: "aborted" };

/**
 * Where a tool call's tool comes from, for `camelrun.tool.source`: the application's attached tools, a served
 * endpoint (an MCP source the runtime calls with identity tokens), another MCP server, an OpenAPI source, a built-in,
 * the agent's file tools, a channel's, or the runtime's own (js_exec, tool search).
 */
export type ToolSource = "attached" | "served" | "mcp" | "openapi" | "builtin" | "files" | "channel" | "runtime";

export type RunSpanOptions = {
  tenant: string; agent: { id: string; name?: string };
  request: { id: string; method: string; startedAt?: number; began?: number; actor?: string; prompt?: string; code?: string; resumes?: number; metadata?: Record<string, string> };
  trace: RunTrace; content: boolean;
  model: () => { provider: string; id: string };
  toolSource: (name: string) => ToolSource;
  record: (span: Span) => void;
};

/**
 * The spans of one run, from the events the agent publishes as it runs and the tool calls the runtime answers: a
 * model call from its round's start (or its retry) to its response's end, a tool call from its start to its end,
 * a compaction from its start to its end, and calls from js_exec's code under js_exec's span. Each child is
 * recorded as it ends; the run's span when the run does (`end`). A run handed to another node ends its open
 * children here (`abandon`), and the node that finishes it records the run's span, which has the same id.
 */
export class RunSpans {
  readonly requestId: string;
  private readonly options: RunSpanOptions;
  private readonly tools = new Map<string, { spanId: string; start?: number; name?: string; args?: unknown }>();
  private model?: { spanId: string; start: number };
  private roundStart?: number;
  private compaction?: { spanId: string; start: number; reason?: string; usage?: any };
  private responses = 0;
  private toolCalls = 0;
  private handoffs = 0;
  private ended = false;

  constructor(options: RunSpanOptions) {
    this.options = options;
    this.requestId = options.request.id;
  }

  private child(name: string, kind: Span["kind"], start: number, end: number, attributes: Attributes, status?: Span["status"], spanId = newSpanId(), parentSpanId = this.options.trace.spanId): Span {
    const span: Span = { traceId: this.options.trace.traceId, spanId, parentSpanId, name, kind, start, end: Math.max(start, end), attributes: { ...this.common(), ...attributes }, ...(status ? { status } : {}) };
    this.options.record(span);
    return span;
  }

  private common(): Attributes {
    return { "camelrun.tenant": this.options.tenant, "camelrun.agent.id": this.options.agent.id, "camelrun.request.id": this.requestId };
  }

  /** An error's status: its class, and its message only when the tenant exports content (a provider's error can echo a prompt). */
  private failure(message: string | undefined, code?: string): Span["status"] {
    return { code: "error", message: this.options.content && message ? clip(message, 1_024) : code ?? errorClass(message) };
  }

  /** The trace context of a tool call's span, for whatever the call starts (a subagent's run continues the trace under it). */
  traceparent(toolCallId: string | undefined, innerSpanId?: string) {
    const spanId = innerSpanId ?? (toolCallId ? this.toolSpan(toolCallId).spanId : this.options.trace.spanId);
    return formatTraceparent({ traceId: this.options.trace.traceId, spanId, sampled: true });
  }

  private toolSpan(toolCallId: string) {
    let tool = this.tools.get(toolCallId);
    if (!tool) this.tools.set(toolCallId, tool = { spanId: newSpanId() });
    return tool;
  }

  /** One event of the run, as it is published. */
  event(event: any, at = Date.now()) {
    if (this.ended || !event || typeof event.type !== "string") return;
    const content = this.options.content;
    switch (event.type) {
      case "turn_start": this.roundStart = at; break;
      case "auto_retry_start": this.roundStart = at + (Number(event.delayMs) || 0); this.model = undefined; break;
      case "message_start":
        if (event.message?.role === "assistant" && !this.model) { this.model = { spanId: newSpanId(), start: this.roundStart ?? at }; this.roundStart = undefined; }
        break;
      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") break;
        const model = this.model ?? { spanId: newSpanId(), start: this.roundStart ?? at };
        this.model = undefined;
        this.roundStart = undefined;
        this.responses++;
        const usage = message.usage ?? {};
        const configured = this.options.model();
        const provider = String(message.provider ?? configured.provider);
        const failed = message.stopReason === "error" || message.stopReason === "aborted";
        this.child(`chat ${message.model ?? configured.id}`, SpanKind.client, model.start, at, {
          "gen_ai.operation.name": "chat", "gen_ai.system": provider, "gen_ai.provider.name": provider,
          "gen_ai.request.model": configured.id, "gen_ai.response.model": message.model ?? configured.id,
          ...(message.responseId ? { "gen_ai.response.id": String(message.responseId) } : {}),
          "gen_ai.response.finish_reasons": [FINISH[message.stopReason] ?? String(message.stopReason ?? "unknown")],
          "gen_ai.usage.input_tokens": usage.input ?? 0, "gen_ai.usage.output_tokens": usage.output ?? 0,
          "gen_ai.usage.cache_read.input_tokens": usage.cacheRead || undefined, "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite || undefined,
          "camelrun.cost.usd": { double: Number(usage.cost?.total) || 0 }, "gen_ai.usage.cost": { double: Number(usage.cost?.total) || 0 },
          ...(failed ? { "error.type": message.stopReason === "aborted" ? "aborted" : errorClass(message.errorMessage) } : {}),
          ...(content ? { "gen_ai.output.messages": outputMessage(message, FINISH[message.stopReason]), "output.value": outputMessage(message, FINISH[message.stopReason]) } : {}),
        }, failed ? this.failure(message.errorMessage, message.stopReason === "aborted" ? "aborted" : undefined) : undefined, model.spanId);
        break;
      }
      case "tool_execution_start": {
        const tool = this.toolSpan(String(event.toolCallId));
        Object.assign(tool, { start: at, name: event.toolName, args: event.args });
        break;
      }
      case "tool_execution_end": {
        const id = String(event.toolCallId);
        const tool = this.tools.get(id) ?? { spanId: newSpanId() };
        this.tools.delete(id);
        this.toolCalls++;
        const name = String(event.toolName ?? tool.name ?? "unknown");
        const waiting = !!event.result?.details?.inputRequired;
        this.child(`execute_tool ${name}`, SpanKind.internal, tool.start ?? at, at, {
          "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.tool.call.id": id, "gen_ai.tool.type": "function",
          "camelrun.tool.source": this.options.toolSource(name),
          ...(waiting ? { "camelrun.tool.input_required": true } : {}),
          ...(event.isError ? { "error.type": "tool_error" } : {}),
          ...(content ? toolContent(tool.args ?? event.args ?? {}, event.result) : {}),
        }, event.isError ? this.failure(textOf(event.result?.content), "tool_error") : undefined, tool.spanId);
        break;
      }
      case "compaction_start": this.compaction = { spanId: newSpanId(), start: at, reason: event.reason }; break;
      case "compaction_usage": if (this.compaction) this.compaction.usage = event; break;
      case "compaction_end": {
        const compaction: { spanId: string; start: number; reason?: string; usage?: any } = this.compaction ?? { spanId: newSpanId(), start: at, reason: event.reason };
        this.compaction = undefined;
        const { status, attributes } = compactionAttributes(event, compaction.usage, compaction.reason ?? event.reason, this.options.model(), message => this.failure(message));
        this.child("compaction", SpanKind.client, compaction.start, at, attributes, status, compaction.spanId);
        break;
      }
      case "turn_resumed": case "turn_recovered": this.handoffs++; break;
    }
  }

  /** A call from js_exec's code, under js_exec's span (its `toolCallId`'s). */
  innerCall(call: { name: string; toolCallId?: string; innerCallId?: string; args?: unknown }, spanId: string, start: number, end: number, code: string | undefined, result: unknown) {
    if (this.ended) return;
    this.toolCalls++;
    const parent = call.toolCallId ? this.toolSpan(call.toolCallId).spanId : this.options.trace.spanId;
    this.child(`execute_tool ${call.name}`, SpanKind.internal, start, end, {
      "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": call.name, "gen_ai.tool.type": "function",
      ...(call.toolCallId ? { "gen_ai.tool.call.id": call.toolCallId } : {}), ...(call.innerCallId ? { "camelrun.tool.inner_call.id": call.innerCallId } : {}),
      "camelrun.tool.source": this.options.toolSource(call.name),
      ...(code ? { "error.type": code } : {}),
      ...(this.options.content ? toolContent(call.args ?? {}, result) : {}),
    }, code ? { code: "error", message: code } : undefined, spanId, parent);
  }

  /** The node lets the run go (to another node, or it stopped): open children end here, marked so; the run's span is the next owner's. */
  abandon(reason: string, at = Date.now()) {
    if (this.ended) return;
    this.ended = true;
    const status: Span["status"] = { code: "error", message: reason };
    const interrupted = { "error.type": "interrupted" };
    // A model request in flight: its response had begun, or its round had (the request sent, nothing back yet).
    const model = this.model ?? (this.roundStart !== undefined && this.roundStart <= at ? { spanId: newSpanId(), start: this.roundStart } : undefined);
    if (model) this.child(`chat ${this.options.model().id}`, SpanKind.client, model.start, at, { "gen_ai.operation.name": "chat", "gen_ai.request.model": this.options.model().id, ...interrupted }, status, model.spanId);
    for (const [id, tool] of this.tools) if (tool.start !== undefined) this.child(`execute_tool ${tool.name ?? "unknown"}`, SpanKind.internal, tool.start, at, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": tool.name ?? "unknown", "gen_ai.tool.call.id": id, ...interrupted }, status, tool.spanId);
    if (this.compaction) this.child("compaction", SpanKind.client, this.compaction.start, at, { "gen_ai.operation.name": "chat", "camelrun.operation": "compaction", ...interrupted }, status, this.compaction.spanId);
  }

  /** The run ended with `outcome`: its own span, which every child above is under. */
  end(outcome: { result?: unknown; error?: string; uncertain?: boolean } | undefined, request: RunSpanOptions["request"] = this.options.request, at = Date.now()) {
    if (this.ended) return;
    this.abandon("The run ended first", at);
    const { agent, trace, content } = this.options;
    const result = (outcome?.result ?? {}) as Record<string, any>;
    const error: string | undefined = outcome?.error ?? (typeof result.error === "string" && result.error ? result.error : undefined);
    const usage = result.usage as { responses?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number; costUsd?: number } | null | undefined;
    const model = this.options.model();
    const execute = request.method === "execute";
    const status = error !== undefined || result.stopped === "spend_limit" || result.stopped === "turn_limit" ? "failed" : result.stopped === "input_required" ? "input_required" : "completed";
    const code = typeof result.code === "string" ? result.code : outcome?.uncertain ? "uncertain" : outcome?.error !== undefined ? "runtime_error" : undefined;
    const start = request.startedAt ?? request.began ?? at;
    const span: Span = {
      traceId: trace.traceId, spanId: trace.spanId, ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
      name: `${execute ? "execute_code" : "invoke_agent"} ${agent.name ?? agent.id}`, kind: SpanKind.server, start, end: Math.max(start, at),
      attributes: {
        ...this.common(),
        "gen_ai.operation.name": execute ? "execute_code" : "invoke_agent",
        "gen_ai.agent.id": agent.id, ...(agent.name ? { "gen_ai.agent.name": agent.name } : {}), "gen_ai.conversation.id": agent.id, "session.id": agent.id,
        ...(execute ? {} : { "gen_ai.system": model.provider, "gen_ai.provider.name": model.provider, "gen_ai.request.model": model.id }),
        ...(usage ? {
          "gen_ai.usage.input_tokens": usage.input ?? 0, "gen_ai.usage.output_tokens": usage.output ?? 0,
          "gen_ai.usage.cache_read.input_tokens": usage.cacheRead || undefined, "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite || undefined,
          "camelrun.cost.usd": { double: usage.costUsd ?? 0 }, "gen_ai.usage.cost": { double: usage.costUsd ?? 0 }, "camelrun.run.model_responses": usage.responses ?? 0,
        } : {}),
        "camelrun.run.method": request.method, "camelrun.run.status": status,
        ...(result.stopped ? { "camelrun.run.stopped": String(result.stopped) } : {}),
        ...(code ? { "camelrun.error.code": code, "error.type": code } : error !== undefined ? { "error.type": errorClass(error) } : {}),
        ...(outcome?.uncertain ? { "camelrun.run.uncertain": true } : {}),
        ...(request.began !== undefined && request.startedAt !== undefined ? { "camelrun.run.queued_ms": Math.max(0, request.began - request.startedAt) } : {}),
        ...(request.resumes || this.handoffs ? { "camelrun.run.resumes": Math.max(request.resumes ?? 0, this.handoffs) } : {}),
        "camelrun.run.tool_calls": this.toolCalls, ...(Array.isArray(result.inputs) ? { "camelrun.run.inputs": result.inputs.length } : {}),
        ...(request.actor ? { "camelrun.actor": request.actor, "user.id": request.actor } : {}),
        ...(content ? {
          ...(request.prompt !== undefined ? { "gen_ai.input.messages": json([{ role: "user", parts: [{ type: "text", content: request.prompt }] }]), "input.value": clip(request.prompt) } : {}),
          ...(request.code !== undefined ? { "input.value": clip(request.code) } : {}),
          ...(request.code !== undefined ? { "camelrun.code": clip(request.code) } : {}),
          ...(typeof result.reply === "string" ? { "gen_ai.output.messages": json([{ role: "assistant", parts: [{ type: "text", content: result.reply }] }]), "output.value": clip(result.reply) } : {}),
          ...(result.output !== undefined && !execute ? { "camelrun.output": json(result.output) } : {}),
          ...(execute && Array.isArray(result.output) ? { "camelrun.code.output": clip(result.output.join("\n")) } : {}),
          ...Object.fromEntries(Object.entries(request.metadata ?? {}).map(([key, value]) => [`camelrun.metadata.${key}`, value])),
        } : {}),
      },
      ...(status === "failed" ? { status: this.failure(error ?? result.stopped, code) } : {}),
    };
    this.options.record(span);
  }
}

/** A compaction's span attributes and status, from its end event and its model call's usage. */
function compactionAttributes(event: any, usage: any, reason: string | undefined, model: { provider: string; id: string }, failure: (message: string) => Span["status"]) {
  const provider = String(usage?.provider ?? model.provider);
  const tokens = usage?.usage ?? {};
  return {
    attributes: {
      "gen_ai.operation.name": "chat", "camelrun.operation": "compaction", "gen_ai.system": provider, "gen_ai.provider.name": provider,
      "gen_ai.request.model": String(usage?.model ?? model.id),
      ...(usage ? { "gen_ai.usage.input_tokens": tokens.input ?? 0, "gen_ai.usage.output_tokens": tokens.output ?? 0, "camelrun.cost.usd": { double: Number(tokens.cost?.total) || 0 }, "gen_ai.usage.cost": { double: Number(tokens.cost?.total) || 0 } } : {}),
      ...(reason ? { "camelrun.compaction.reason": String(reason) } : {}), ...(event.background ? { "camelrun.compaction.background": true } : {}),
      ...(event.skipped ? { "camelrun.compaction.skipped": true } : {}),
      ...(typeof event.tokensBefore === "number" ? { "camelrun.compaction.tokens_before": event.tokensBefore } : {}),
      ...(typeof event.summarizedMessages === "number" ? { "camelrun.compaction.summarized_messages": event.summarizedMessages } : {}),
      ...(typeof event.keptMessages === "number" ? { "camelrun.compaction.kept_messages": event.keptMessages } : {}),
      ...(event.error ? { "error.type": errorClass(String(event.error)) } : {}),
    } as Attributes,
    status: event.error ? failure(String(event.error)) : undefined,
  };
}

/**
 * A compaction made between runs: no run's trace holds it, so it is a trace of its own, sampled at the tenant's rate.
 * Fed the background events (`event`); records its span at the end.
 */
export class BackgroundSpans {
  private compaction?: { start: number; reason?: string; usage?: any };
  private readonly options: { tenant: string; agentId: string; content: boolean; model: () => { provider: string; id: string }; record: (span: Span) => void };
  constructor(options: BackgroundSpans["options"]) { this.options = options; }

  event(event: any, at = Date.now()) {
    if (event?.type === "compaction_start") this.compaction = { start: at, reason: event.reason };
    else if (event?.type === "compaction_usage" && this.compaction) this.compaction.usage = event;
    else if (event?.type === "compaction_end") {
      const compaction: { start: number; reason?: string; usage?: any } = this.compaction ?? { start: at, reason: event.reason };
      this.compaction = undefined;
      const failure = (message: string): Span["status"] => ({ code: "error", message: this.options.content ? clip(message, 1_024) : errorClass(message) });
      const { attributes, status } = compactionAttributes(event, compaction.usage, compaction.reason ?? event.reason, this.options.model(), failure);
      this.options.record({
        traceId: newTraceId(), spanId: newSpanId(), name: "compaction", kind: SpanKind.internal, start: compaction.start, end: Math.max(compaction.start, at),
        attributes: { "camelrun.tenant": this.options.tenant, "camelrun.agent.id": this.options.agentId, "gen_ai.conversation.id": this.options.agentId, ...attributes },
        ...(status ? { status } : {}),
      });
    }
  }
}

/** Spans for the waits on people a resumed run ends: each input from when it was asked to when it settled, under the run that asked. */
export function inputSpans(rows: { id: string; kind: string; toolCallId: string; message?: string; state: string; createdAt: number; answer?: { at: number; by?: { via?: string; system?: string } } }[],
  options: { tenant: string; agentId: string; requestId: string; trace: RunTrace; content: boolean }, now = Date.now()): Span[] {
  return rows.map(row => ({
    traceId: options.trace.traceId, spanId: newSpanId(), parentSpanId: options.trace.spanId, name: "await_human_input", kind: SpanKind.internal,
    start: row.createdAt, end: Math.max(row.createdAt, row.answer?.at ?? now),
    attributes: {
      "camelrun.tenant": options.tenant, "camelrun.agent.id": options.agentId, "camelrun.request.id": options.requestId,
      "camelrun.input.id": row.id, "camelrun.input.kind": row.kind, "camelrun.input.state": row.state, "gen_ai.tool.call.id": row.toolCallId,
      ...(row.answer?.by?.via ? { "camelrun.input.via": row.answer.by.via } : row.answer?.by?.system ? { "camelrun.input.via": "runtime" } : {}),
      ...(options.content && row.message ? { "camelrun.input.message": clip(row.message) } : {}),
    },
  }));
}
