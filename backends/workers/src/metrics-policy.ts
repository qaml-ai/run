// Generated from src/metrics.ts; pure formatting and privacy classification.
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
type Unit = "Count" | "Milliseconds" | "Bytes" | "None";
type Value = number | [number, Unit];

let sink = (line: string) => console.log(line);

let metricService: string | undefined;
/**
 * The ServiceName dimension of every line (AGENT_SERVICE_NAME): the deployment's, so the process's, set by its entry
 * point (server.ts, agent-child.ts). Nodes sharing a process (a simulation) share it.
 */
export function setMetricService(service: string | undefined) {
  metricService = service;
}

/** Where lines go (stdout by default); tests capture them. */
export function setMetricSink(next?: (line: string) => void) {
  sink = next ?? (line => console.log(line));
}

/**
 * One EMF line. `rollups` are the dimension sets each metric is published under, by
 * name from `dimensions`; ServiceName (AGENT_SERVICE_NAME) is added to each, as for
 * `node_load`. Undefined metrics are left out.
 */
export function metricLine(
  type: string,
  line: { dimensions: Record<string, string>; rollups: string[][]; metrics: Record<string, Value | undefined>; properties?: Record<string, unknown> },
  service = metricService,
  now = Date.now(),
) {
  const metrics = Object.entries(line.metrics).filter((entry): entry is [string, Value] => entry[1] !== undefined);
  const values = Object.fromEntries(metrics.map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]));
  return JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [{
        Namespace: "AgentRuntime",
        Dimensions: line.rollups.map(names => service ? ["ServiceName", ...names] : names),
        Metrics: metrics.map(([name, value]) => ({ Name: name, Unit: Array.isArray(value) ? value[1] : "Count" })),
      }],
    },
    type, ...line.properties, ...(service ? { ServiceName: service } : {}), ...line.dimensions, ...values,
  });
}

const CLASSES: [string, RegExp][] = [
  ["compaction", /Compaction failed|Summarization failed/i],
  ["resume_limit", /^This turn exhausted its \d+ node-loss resumes/],
  ["runtime_restart", /runtime restarted/i],
  // Workers resets a Durable Object whose startup (blockConcurrencyWhile, 30 s) ran too long: the runtime's, not the
  // model's, and its "too long" is no context overflow.
  ["startup_reset", /blockConcurrencyWhile\(\).{0,40}waited for too long/],
  // A run its caller stopped (agent-host.ts: "The run was aborted"; Pi's "Request was aborted"): not a failure of the model's.
  ["aborted", /^The run was aborted|^Request was aborted/],
  // DeepSeek's own API refusing history without reasoning (deepseek-replay.ts): a bug of ours if it ever recurs, alarmed.
  ["reasoning_replay", /`reasoning_content` in the thinking mode must be passed back/],
  // The runtime's own timeout on a model stream that went quiet (model-stream.ts), ahead of the timeouts providers report.
  ["stream_stalled", /^Model stream stalled/],
  // An intact container a provider cannot decode: the host can ask once without images.
  // OpenRouter relays a host's "unsupported image"; Azure says the image data "does not represent a valid image".
  ["image_rejected", /failed to load image|cannot identify image|invalid image|unsupported image|not represent a valid image|could not process image|unable to process image|image could not be decoded|decode image/i],
  // A request carrying more image content than the provider takes (OpenRouter's 413 past 30 MB): the request's image
  // budget (agent-host.ts `hydrate`) is meant to keep under it, so one is a bug of ours, as reasoning_replay is.
  ["image_limit", /exceeded maximum number of images|image content cannot exceed|too many images|images? (is |are )?too (large|big)/i],
  // The model declined, or the provider's safety filter stopped it (pi-ai's words for each provider's stop reason).
  ["refusal", /^The model refused|content.?filter|^Provider stopped with: (sensitive|guardrail|content_filtered)/i],
  // A provider's 402, and a quota or budget used up, which some providers send as a 429: what pi-ai never retries.
  ["billing", /^402\b|\(402\)|insufficient_quota|quota exceeded|out of budget|usage limit (reached|exceeded)|UsageLimitError|subscription_sharing_usage_limit_exceeded/i],
  ["rate_limit", /\b429\b|rate.?limit|too many requests/i],
  ["overloaded", /overloaded|\b529\b/i],
  ["context_overflow", /context.{0,20}(length|window|limit)|too long|maximum context|exceeds? the (maximum|context)/i],
  ["auth", /\b40[13]\b|unauthori[sz]ed|forbidden|api.?key|authentication/i],
  ["billing", /\b402\b|credit|insufficient|quota|spend limit|payment/i],
  ["timeout", /timed? ?out|timeout|deadline/i],
  ["provider_5xx", /\b5\d\d\b|internal server error|bad gateway|service unavailable/i],
  ["network", /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|terminated/i],
];

/** A provider's stop reason (a response's `rawStopReason`) that says its safety filter, or the model's refusal, stopped it. */
const REFUSED = /^(refusal|sensitive|content_filter(ed)?|guardrail_intervened|SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|RECITATION|IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT)$|\.content_filter$/i;

/**
 * A model's or run's error, sorted into one of a few classes for a metric dimension. A failed response's `rawStopReason`,
 * when given, tells a refusal whose message is the model's own explanation. model-errors.ts maps these onto the API's
 * classes (a run's `error.errorClass`), so metrics and the API cannot disagree.
 */
export function errorClass(message: string | null | undefined, rawStopReason?: string): string {
  if (rawStopReason && REFUSED.test(rawStopReason)) return "refusal";
  if (!message) return "none";
  return CLASSES.find(([, pattern]) => pattern.test(message))?.[0] ?? "other";
}

/**
 * An error as a log line may carry it: its class, its name, status and code when it has them, and its message's
 * length, never the message. Errors from model providers, channels, tool servers and requests can echo what a
 * user wrote (a prompt, a tool call's arguments, an address). Logs keep ids and sizes; tests/log-privacy.test.ts
 * holds the lines that log a raw message to this.
 */
export function safeError(error: unknown): string {
  const message = typeof error === "string" ? error : errorText(error);
  const { status, code } = (typeof error === "object" && error ? error : {}) as { status?: unknown; code?: unknown };
  const name = error instanceof Error ? error.name === "Error" ? error.constructor.name : error.name : undefined;
  const facts = [
    name && /^\w{1,40}$/.test(name) ? name : undefined,
    typeof status === "number" && Number.isInteger(status) ? String(status) : undefined,
    typeof code === "number" || typeof code === "string" && /^[\w.-]{1,40}$/.test(code) ? String(code) : undefined,
  ].filter(Boolean);
  const pg = postgresFacts(error, message);
  return `${errorClass(message)}${facts.length ? ` ${facts.join(" ")}` : ""}${pg ? ` ${pg}` : ""} (${message.length} chars)`;
}

const IDENTIFIER = /^[\w.$-]{1,63}$/;

/**
 * What a Postgres error (node-postgres' DatabaseError) says about where it failed, never what value: the type named in
 * its message ("invalid input syntax for type bigint: ...", "... is out of range for type integer"), the query parameter
 * its `where` names ("unnamed portal parameter $2 = '...'"), the server routine,
 * and the table, column, type and constraint fields. Its detail, and the rest of its message and `where`, can hold the
 * value, so they stay out.
 */
function postgresFacts(error: unknown, message: string): string | undefined {
  if (typeof error !== "object" || !error) return undefined;
  const { code, severity, routine, where, table, column, dataType, constraint } = error as Record<string, unknown>;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code) || typeof severity !== "string") return undefined;
  const named = (key: string, value: unknown) => typeof value === "string" && IDENTIFIER.test(value) ? `${key}=${value}` : undefined;
  const facts = [
    named("type", (/^invalid input syntax for type (\w+)/.exec(message) ?? / out of range for type (\w+)$/.exec(message))?.[1]),
    named("param", typeof where === "string" ? /\bparameter \$(\d{1,4})\b/.exec(where)?.[1] : undefined),
    named("routine", routine), named("table", table), named("column", column), named("dataType", dataType), named("constraint", constraint),
  ].filter(Boolean);
  return facts.length ? `pg[${facts.join(" ")}]` : undefined;
}
