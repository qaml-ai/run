/**
 * Operational metrics as CloudWatch Embedded Metric Format log lines, as `node_load` is
 * (ecs.ts): CloudWatch Logs extracts them into namespace AgentRuntime, so publishing
 * needs no API calls or IAM. One line per turn (outcome, duration, time to first token,
 * model and tool counts), per failed model response, per webhook delivery and per batch
 * of run and usage events. Dimensions are few and bounded: outcome, error class,
 * provider, model, tenant, webhook kind. Nothing a user wrote goes into a line: errors go as `safeError` has them.
 */
import type { WebhookEvent } from "./webhooks.ts";
import { errorText } from "./protocol.ts";

type Unit = "Count" | "Milliseconds" | "None";
type Value = number | [number, Unit];

let sink = (line: string) => console.log(line);

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
  service = process.env.AGENT_SERVICE_NAME,
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

function emit(type: string, line: Parameters<typeof metricLine>[1]) {
  sink(metricLine(type, line));
}

const CLASSES: [string, RegExp][] = [
  ["runtime_restart", /runtime restarted/i],
  ["rate_limit", /\b429\b|rate.?limit|too many requests/i],
  ["overloaded", /overloaded|\b529\b/i],
  ["context_overflow", /context.{0,20}(length|window|limit)|too long|maximum context|exceeds? the (maximum|context)/i],
  ["auth", /\b40[13]\b|unauthori[sz]ed|forbidden|api.?key|authentication/i],
  ["billing", /\b402\b|credit|insufficient|quota|spend limit|payment/i],
  ["timeout", /timed? ?out|timeout|deadline/i],
  ["provider_5xx", /\b5\d\d\b|internal server error|bad gateway|service unavailable/i],
  ["network", /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|terminated/i],
];

/** A model's or run's error, sorted into one of a few classes for a metric dimension. */
export function errorClass(message: string | null | undefined): string {
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
  return `${errorClass(message)}${facts.length ? ` ${facts.join(" ")}` : ""} (${message.length} chars)`;
}

const CODE_CLASSES: [string, RegExp][] = [
  ["cpu_limit", /^Codemode CPU limit exceeded/],
  ["memory_limit", /^Codemode memory limit exceeded|Array buffer allocation failed/],
  ["sandbox_seccomp", /^Codemode sandbox process exited \(SIGSYS/],
  ["sandbox_rlimit", /^Codemode sandbox process exited \(\w+: a resource limit/],
  ["spawn_failed", /^Codemode sandbox process could not start/],
  ["guest_limit", /^Codemode CPU or wall-clock limit exceeded/],
  ["timeout_waiting_worker", /^Codemode timed out after \d+ms waiting for a sandbox worker/],
  ["timeout_tool", /^Codemode timed out after \d+ms while tools\./],
  ["timeout", /^Codemode timed out/],
  ["aborted", /^Codemode aborted/],
  ["worker_exited", /^Codemode (worker|sandbox process) exited/],
  ["memory", /memory or execution limit|out of memory/i],
  ["tool_limit", /^Codemode (tool call|transfer) limit exceeded|^Too many concurrent tool calls/],
  ["syntax", /SyntaxError/],
];

/** A js_exec error, sorted by which limit stopped it (else `guest_error`, the code's own), for a metric dimension. */
export function codeErrorClass(message: string | null | undefined): string {
  if (!message) return "none";
  return CODE_CLASSES.find(([, pattern]) => pattern.test(message))?.[0] ?? "guest_error";
}

/**
 * One js_exec execution: how long it took, the CPU its guest used (when it finished), the timeoutMs
 * it asked for and got, and how it ended, so its limits can be tuned from what executions need.
 */
export function recordCodeExecution(execution: { tenant?: string; ms: number; requestedTimeoutMs?: number; timeoutMs: number; cpuMs?: number; error?: unknown }) {
  // Only the class goes in the line: a guest's error can echo what a user wrote.
  const failure = execution.error === undefined ? "none" : codeErrorClass(errorText(execution.error));
  emit("code_execution", {
    // Engine stays a dimension, always v8 since QuickJS was removed, so the metric's series and dashboards carry on.
    dimensions: { ErrorClass: failure, Engine: "v8" },
    rollups: [[], ["ErrorClass"], ["Engine"], ["Engine", "ErrorClass"]],
    metrics: { CodeExecutions: 1, CodeDurationMs: [execution.ms, "Milliseconds"], CodeCpuMs: execution.cpuMs === undefined ? undefined : [execution.cpuMs, "Milliseconds"] },
    properties: { tenant: execution.tenant, timeoutMs: execution.timeoutMs, ...(execution.requestedTimeoutMs !== undefined ? { requestedTimeoutMs: execution.requestedTimeoutMs } : {}) },
  });
}

/**
 * A v8-exec process that did not get to answer: it could not be started (`code`, the spawn's errno, logged as `errno`),
 * or something other than the runtime killed it (`signal`: SIGSYS for its seccomp allowlist, SIGXCPU
 * or SIGKILL for its rlimits or the OOM killer; agent-launcher reports the signal). Written by the runtime that ran it.
 */
export function recordV8Exec(event: { event: "spawn_failed" | "killed"; code?: string; signal?: string }) {
  emit("v8_exec", {
    dimensions: { Event: event.event },
    rollups: [["Event"]],
    metrics: { V8ExecFailures: 1 },
    properties: { ...(event.code ? { errno: event.code } : {}), ...(event.signal ? { signal: event.signal } : {}) },
  });
}

/** The methods that are a turn of the model (not code executions, configuration or loads). */
const TURN_METHODS = new Set(["prompt", "continue", "resume"]);

/**
 * A host's turns, observed from its events and its handler: `event` sees each event
 * the host emits, `wrap` times each turn and writes its line when it ends.
 */
export function observeTurns(model: () => { provider: string; id: string } | undefined, clock = Date.now, tenant: () => string | undefined = () => undefined) {
  let turn: { started: number; firstToken?: number; responses: number; errors: number; retries: number; tools: number; toolErrors: number } | undefined;

  function event(value: unknown) {
    const event = value as { type?: string; message?: any; toolName?: string; isError?: boolean; result?: any };
    if (event.type === "message_update" && event.message?.role === "assistant") {
      if (turn && turn.firstToken === undefined) turn.firstToken = clock();
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      if (turn) turn.responses++;
      if (event.message.stopReason === "error") {
        if (turn) turn.errors++;
        const provider = String(event.message.provider ?? model()?.provider ?? "unknown");
        const id = String(event.message.model ?? model()?.id ?? "unknown");
        const errorMessage = String(event.message.errorMessage ?? "");
        emit("model_error", {
          dimensions: { Provider: provider, Model: id, ErrorClass: errorClass(errorMessage || "error") },
          rollups: [[], ["Provider", "Model"], ["ErrorClass"]],
          metrics: { ModelErrors: 1 },
          properties: { error: safeError(errorMessage) },
        });
      }
    } else if (event.type === "auto_retry_start") {
      if (turn) turn.retries++;
    } else if (event.type === "tool_execution_end") {
      if (turn) turn.tools++;
      if (event.isError) {
        if (turn) turn.toolErrors++;
        // The error's class only, never its text: a tool's error can echo what a user wrote.
        const text = String(event.result?.content?.find?.((part: any) => part?.type === "text")?.text ?? "");
        sink(JSON.stringify({ type: "tool_failed", toolName: event.toolName ?? "", tenant: tenant(), errorClass: event.toolName === "js_exec" ? codeErrorClass(text) : errorClass(text || "error"), provider: model()?.provider, model: model()?.id }));
      }
    }
  }

  function finish(current: NonNullable<typeof turn>, method: string, result: any, thrown: unknown) {
    // A limit's stop carries its reason as the error, but the turn did not fail.
    const limited = thrown === undefined && (result?.stopped === "spend_limit" || result?.stopped === "turn_limit") ? result.stopped as string : undefined;
    const error = thrown !== undefined ? "exception" : !limited && typeof result?.error === "string" && result.error ? errorClass(result.error) : "none";
    const outcome = error !== "none" ? "failed" : result?.stopped === "input_required" ? "input_required" : limited ?? "completed";
    const { provider = "unknown", id = "unknown" } = model() ?? {};
    emit("turn_metrics", {
      dimensions: { Outcome: outcome, ErrorClass: error, Provider: provider, Model: id },
      rollups: [[], ["Outcome"], ["ErrorClass"], ["Provider", "Model"]],
      metrics: {
        Turns: 1, TurnDurationMs: [clock() - current.started, "Milliseconds"],
        TimeToFirstTokenMs: current.firstToken === undefined ? undefined : [current.firstToken - current.started, "Milliseconds"],
        // Failed responses are counted by their own lines (model_error), under the same dimensions.
        ModelResponses: current.responses, ModelRetries: current.retries,
        ToolCalls: current.tools, ToolErrors: current.toolErrors,
      },
      properties: { method, modelErrors: current.errors },
    });
  }

  function wrap(handle: (method: string, params: any) => Promise<any>) {
    return async (method: string, params: any): Promise<any> => {
      // A turn while another runs is refused by the host ("busy"): not a turn of its own.
      if (!TURN_METHODS.has(method) || turn) return handle(method, params);
      const current = turn = { started: clock(), responses: 0, errors: 0, retries: 0, tools: 0, toolErrors: 0 };
      let result: any;
      try { result = await handle(method, params); }
      catch (error) { turn = undefined; finish(current, method, undefined, error); throw error; }
      turn = undefined;
      finish(current, method, result, undefined);
      return result;
    };
  }

  return { event, wrap };
}

/**
 * Count run and usage events as they are written to the outboxes: runs started,
 * resumed after a lost node, completed, stopped for input, failed (by error class, and
 * those a restart cut short); model spend by tenant, provider and model. A write that
 * rolls back and is retried is counted again; that is rare, and these are for alarms.
 */
export function recordEventMetrics(events: WebhookEvent[]) {
  const runs = new Map<string, Record<string, number>>();
  const failures = new Map<string, number>();
  const costs = new Map<string, { usd: number; events: number }>();
  for (const event of events) {
    const data = event.data as any;
    if (event.type === "usage.recorded") {
      const key = JSON.stringify([event.tenant, String(data.provider ?? "unknown"), String(data.model ?? "unknown")]);
      const cost = costs.get(key) ?? { usd: 0, events: 0 };
      cost.usd += Number(data.cost?.usd) || 0;
      cost.events++;
      costs.set(key, cost);
      continue;
    }
    if (!event.type.startsWith("run.")) continue;
    const counts = runs.get(event.tenant) ?? {};
    const add = (name: string) => { counts[name] = (counts[name] ?? 0) + 1; };
    if (event.type === "run.started") { add("RunsStarted"); if (data.resumes) add("RunsResumed"); }
    if (event.type === "run.completed") { add("RunsCompleted"); if (data.stopped === "input_required") add("RunsInputRequired"); if (data.stopped === "spend_limit") add("RunsSpendLimited"); if (data.stopped === "turn_limit") add("RunsTurnLimited"); }
    if (event.type === "run.failed") {
      add("RunsFailed");
      if (data.uncertain) add("RunsUncertain");
      const key = JSON.stringify([event.tenant, errorClass(String(data.error ?? "error"))]);
      failures.set(key, (failures.get(key) ?? 0) + 1);
    }
    runs.set(event.tenant, counts);
  }
  for (const [tenant, counts] of runs) {
    emit("run_events", { dimensions: { Tenant: tenant }, rollups: [[], ["Tenant"]], metrics: counts });
  }
  for (const [key, count] of failures) {
    const [tenant, error] = JSON.parse(key);
    emit("run_failed", { dimensions: { Tenant: tenant, ErrorClass: error }, rollups: [["ErrorClass"], ["Tenant", "ErrorClass"]], metrics: { RunsFailedByClass: count } });
  }
  for (const [key, cost] of costs) {
    const [tenant, provider, model] = JSON.parse(key);
    emit("model_cost", {
      dimensions: { Tenant: tenant, Provider: provider, Model: model }, rollups: [[], ["Tenant"], ["Provider", "Model"]],
      metrics: { ModelCostUsd: [Math.round(cost.usd * 1e6) / 1e6, "None"], ModelUsageEvents: cost.events },
    });
  }
}

/**
 * A webhook delivery's line: delivered (its lag from the event's creation, and the
 * attempts it took), or failed (`webhook_failed`, the type alarms match on, with why).
 */
export function deliveryLine(delivery: { kind: "endpoint" | "usage"; tenant: string; event: string; attempts: number; lagMs: number; error?: string }, service = process.env.AGENT_SERVICE_NAME) {
  const { kind, tenant, event, attempts, lagMs, error } = delivery;
  const properties = { tenant, event, attempts, ...(error !== undefined ? { error } : {}) };
  return error !== undefined
    ? metricLine("webhook_failed", { dimensions: { Kind: kind }, rollups: [[], ["Kind"]], metrics: { WebhooksFailed: 1 }, properties }, service)
    : metricLine("webhook_delivered", {
      dimensions: { Kind: kind }, rollups: [[], ["Kind"]],
      metrics: { WebhooksDelivered: 1, WebhookDeliveryLagMs: [lagMs, "Milliseconds"], WebhookAttempts: attempts }, properties,
    }, service);
}

/** Deliveries waiting in both outboxes, and how long the oldest has waited. */
export function webhookBacklogLine(backlog: { pending: number; oldestAgeMs: number }, service = process.env.AGENT_SERVICE_NAME) {
  return metricLine("webhook_backlog", {
    dimensions: {}, rollups: [[]],
    metrics: { WebhookBacklog: backlog.pending, WebhookOldestPendingMs: [backlog.oldestAgeMs, "Milliseconds"] },
  }, service);
}

/** An event stream subscriber (a watcher or a waiting poll) refused with 429 at the agent's, tenant's or node's limit. */
export function recordWatchRefused(scope: "agent" | "tenant" | "node", tenant: string) {
  emit("watch_refused", { dimensions: { Scope: scope, Tenant: tenant }, rollups: [[], ["Scope"], ["Tenant"]], metrics: { WatchersRefused: 1 } });
}

/** How long each step of one operation took: each is timed on its own, so steps that run at once each show their own time. */
export class Steps {
  readonly began = performance.now();
  readonly ms: Record<string, number> = {};
  async time<T>(step: string, work: Promise<T> | (() => Promise<T>)): Promise<T> {
    const started = performance.now();
    try { return await (typeof work === "function" ? work() : work); }
    finally { this.ms[step] = (this.ms[step] ?? 0) + Math.round(performance.now() - started); }
  }
  get total() { return Math.round(performance.now() - this.began); }
}

const stepMetrics = (prefix: string, steps: Steps) => Object.fromEntries([[`${prefix}Ms`, [steps.total, "Milliseconds"]],
  ...Object.entries(steps.ms).map(([step, ms]) => [`${prefix}${step[0].toUpperCase()}${step.slice(1)}Ms`, [ms, "Milliseconds"]])]) as Record<string, Value>;

/** A POST /v1/agents: its total and each step's milliseconds (`create_timing`); `Upsert` says whether the key's agent existed. */
export function recordCreate(steps: Steps, create: { tenant: string; agent?: string; upsert: boolean; error?: string }) {
  emit("create_timing", {
    dimensions: { Outcome: create.error === undefined ? "created" : "failed", Upsert: String(create.upsert) }, rollups: [[], ["Outcome", "Upsert"]],
    metrics: stepMetrics("Create", steps), properties: { tenant: create.tenant, ...(create.agent ? { agent: create.agent } : {}), ...(create.error !== undefined ? { error: create.error } : {}) },
  });
}

/** An agent's cold start: its total and each step's milliseconds (`start_timing`). */
export function recordStart(steps: Steps, start: { tenant: string; agent: string; error?: string }) {
  emit("start_timing", {
    dimensions: { Outcome: start.error === undefined ? "started" : "failed" }, rollups: [[], ["Outcome"]],
    metrics: stepMetrics("Start", steps), properties: { tenant: start.tenant, agent: start.agent, ...(start.error !== undefined ? { error: start.error } : {}) },
  });
}

/** Write a line through the sink (for callers outside this module). */
export function writeMetricLine(line: string) {
  sink(line);
}
