import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hosting } from "./supervisor.ts";
import { RUN_LIMITS } from "./client-sessions.ts";
import { STREAM_TIMEOUTS } from "./model-stream.ts";
import { TOOL_DEADLINES } from "./tool-servers.ts";
import { codeCapacity } from "./codemode.ts";
import { v8Settings } from "./v8-exec.ts";
import { BACKLOG_BYTES } from "./transcript.ts";
import { agentProcessEnv } from "./rpc.ts";
import { MULTI_AGENT_LIMITS } from "./multi-agent.ts";

/**
 * A node's settings, read from its environment once and checked before anything starts. `createNode` (node.ts) reads
 * process.env nowhere itself: `env` is the node's environment, for the helpers that read sections of their own (the
 * tenants file, secrets, the database, storage, pricing, outbound policy, mail, rate limits...), each of which takes it
 * as an argument. Its agent processes are told its settings (`agentEnv`), not the process's.
 *
 * Two settings stay the process's, so nodes sharing one (a simulation) share them: AGENT_SANDBOX_DIR (src/sandbox.ts),
 * the agent-launcher that started this process and confines all its children, and AGENT_SERVICE_NAME's dimension on
 * metric lines (src/metrics.ts), which server.ts sets for the process.
 */
export type NodeConfig = ReturnType<typeof nodeConfig>;

export function nodeConfig(env: NodeJS.ProcessEnv) {
  /** A positive integer setting. */
  function positiveSetting(name: string, fallback: number) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  }
  /** An optional number: undefined unless set, so the component's own default applies. */
  const optional = (name: string) => env[name] ? Number(env[name]) : undefined;
  // Agents hosted per node (processes with AGENT_HOSTING=process, in-process hosts with inline), and busy per tenant across
  // the fleet for a tenant with no maxAgents of its own and no usage tier (one not prepaid).
  const maxAgents = positiveSetting("AGENT_MAX_AGENTS", 8);
  const maxAgentsPerTenant = positiveSetting("AGENT_MAX_AGENTS_PER_TENANT", Math.max(1, Math.ceil(maxAgents / 2)));
  const port = Number(env.PORT ?? 8790);
  const drainMs = Number(env.AGENT_DRAIN_TIMEOUT_MS ?? 100_000);
  if (!Number.isInteger(drainMs) || drainMs < 0) throw new Error("AGENT_DRAIN_TIMEOUT_MS must be a non-negative integer");
  // A retiring node hands each running turn off at its next step boundary, so it waits only for the step in flight: by
  // default as long as the longest tool call may run (TOOL_DEADLINES.maxTotalMs, 20 min, with progress). A step that outlasts
  // it is handed off mid-step, its calls in flight closed as of unknown outcome.
  const retireMaxMs = Number(env.AGENT_RETIRE_MAX_MS ?? TOOL_DEADLINES.maxTotalMs);
  if (!Number.isInteger(retireMaxMs) || retireMaxMs < 0) throw new Error("AGENT_RETIRE_MAX_MS must be a non-negative integer");
  // How often every node sweeps for agents with work no node is doing (0: never). Nodes also sweep at once when told
  // that work was left (a drain, a retirement, a dead peer found), so this is the backstop.
  const orphanMs = Number(env.AGENT_ORPHAN_SWEEP_MS ?? 10_000);
  if (!Number.isInteger(orphanMs) || orphanMs < 0) throw new Error("AGENT_ORPHAN_SWEEP_MS must be a non-negative integer (0: no sweep)");
  // How often every node sweeps for sub-agents whose ending did not reach their parent (its node lost as it ended); 0: never.
  const childSweepMs = Number(env.AGENT_CHILD_SWEEP_MS ?? MULTI_AGENT_LIMITS.sweepMs);
  if (!Number.isInteger(childSweepMs) || childSweepMs < 0) throw new Error("AGENT_CHILD_SWEEP_MS must be a non-negative integer (0: no sweep)");
  // Turns sub-agent notifications may start per chain root and hour: past it they land without one, so agents cannot wake each other forever.
  const wakesPerHour = positiveSetting("AGENT_WAKES_PER_HOUR", MULTI_AGENT_LIMITS.wakesPerHour);
  const hosting = (env.AGENT_HOSTING ?? "process") as Hosting;
  if (!["process", "inline"].includes(hosting)) throw new Error("AGENT_HOSTING must be process or inline");
  const toolTimeoutMs = Number(env.AGENT_TOOL_TIMEOUT_MS ?? 15_000);
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > 15 * 60_000) throw new Error("AGENT_TOOL_TIMEOUT_MS must be an integer between 1 and 900000");
  // The most one run of a self-serve tenant's agents may take, whatever its agent sets (runLimits): model responses, and
  // seconds from when it began. A tenant's own maxRunResponses and maxRunSeconds replace them; admin tenants have none unless set.
  const runLimits = { maxResponses: Number(env.AGENT_MAX_RUN_RESPONSES ?? RUN_LIMITS.maxResponses), maxSeconds: Number(env.AGENT_MAX_RUN_SECONDS ?? RUN_LIMITS.maxSeconds) };
  if (!Number.isSafeInteger(runLimits.maxResponses) || runLimits.maxResponses < 1) throw new Error("AGENT_MAX_RUN_RESPONSES must be a positive integer");
  if (!Number.isSafeInteger(runLimits.maxSeconds) || runLimits.maxSeconds < 1) throw new Error("AGENT_MAX_RUN_SECONDS must be a positive integer");
  // How long a model request may go quiet before it fails as stalled and is retried (model-stream.ts): before its first
  // token, and between events once it streams. An agent's runLimits (firstTokenSeconds, idleSeconds) set its own.
  const streamTimeouts = { firstTokenMs: Number(env.AGENT_MODEL_FIRST_TOKEN_SECONDS ?? STREAM_TIMEOUTS.firstTokenMs / 1000) * 1000, idleMs: Number(env.AGENT_MODEL_IDLE_SECONDS ?? STREAM_TIMEOUTS.idleMs / 1000) * 1000 };
  for (const [name, ms] of [["AGENT_MODEL_FIRST_TOKEN_SECONDS", streamTimeouts.firstTokenMs], ["AGENT_MODEL_IDLE_SECONDS", streamTimeouts.idleMs]] as const) {
    if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 3_600_000) throw new Error(`${name} must be an integer from 1 to 3600`);
  }
  // How long a stateless run's result, events and messages are kept once it ends, unless the run says (POST /v1/runs).
  const runRetentionSeconds = Number(env.AGENT_RUN_RETENTION_SECONDS ?? 86_400);
  if (!Number.isInteger(runRetentionSeconds) || runRetentionSeconds < 1) throw new Error("AGENT_RUN_RETENTION_SECONDS must be a positive integer");
  const idleMs = Number(env.AGENT_IDLE_MS ?? 5 * 60_000);
  if (!Number.isInteger(idleMs) || idleMs < 1000) throw new Error("AGENT_IDLE_MS must be an integer of at least 1000");
  // Keep the production eligibility threshold in deployment configuration, not public defaults.
  const minAccountDays = env.AGENT_SIGNUP_MIN_ACCOUNT_DAYS === undefined ? undefined : Number(env.AGENT_SIGNUP_MIN_ACCOUNT_DAYS);
  if (minAccountDays !== undefined && (!Number.isFinite(minAccountDays) || minAccountDays < 0 || !Number.isSafeInteger(Math.round(minAccountDays * 86_400_000)))) {
    throw new Error("AGENT_SIGNUP_MIN_ACCOUNT_DAYS must be a non-negative, safely representable number of days");
  }
  const searchTimeoutMs = Number(env.AGENT_WEB_SEARCH_TIMEOUT_MS ?? 5_000);
  if (!Number.isInteger(searchTimeoutMs) || searchTimeoutMs < 100 || searchTimeoutMs > 60_000) throw new Error("AGENT_WEB_SEARCH_TIMEOUT_MS must be an integer between 100 and 60000");
  const purgeMs = Number(env.AGENT_PURGE_INTERVAL_MS ?? 60_000);
  if (!Number.isInteger(purgeMs) || purgeMs < 1000) throw new Error("AGENT_PURGE_INTERVAL_MS must be an integer of at least 1000");
  const billingMs = Number(env.AGENT_BILLING_INTERVAL_MS ?? 60 * 60_000);
  if (!Number.isInteger(billingMs) || billingMs < 1000) throw new Error("AGENT_BILLING_INTERVAL_MS must be an integer of at least 1000");
  // The storage charge reads tracked totals; a full listing of Storage corrects them every AGENT_STORAGE_RECONCILE_DAYS (0: never, but for the first).
  const reconcileDays = Number(env.AGENT_STORAGE_RECONCILE_DAYS ?? 7);
  if (!Number.isInteger(reconcileDays) || reconcileDays < 0) throw new Error("AGENT_STORAGE_RECONCILE_DAYS must be a non-negative integer");
  return {
    env,
    root: resolve(env.AGENT_DATA_DIR ?? ".agent-runtime"),
    port, host: env.HOST,
    // The hosted MCP endpoints call this node's REST API here.
    loopbackHost: !env.HOST || ["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(env.HOST) ? "127.0.0.1" : env.HOST.includes(":") ? `[${env.HOST}]` : env.HOST,
    publicUrl: (env.AGENT_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, ""),
    // Without AGENT_PUBLIC_URL the issuer is where the node listens: known only once it does when PORT is 0.
    publicUrlSet: !!env.AGENT_PUBLIC_URL,
    // Where browsers reach the runtime, as browser tokens say: AGENT_PUBLIC_URL unless set; empty for none.
    browserUrl: env.AGENT_BROWSER_URL?.replace(/\/+$/, ""),
    maxAgents, maxAgentsPerTenant, drainMs, retireMaxMs, orphanMs, childSweepMs, wakesPerHour, hosting, toolTimeoutMs, runLimits, streamTimeouts, runRetentionSeconds, idleMs,
    leaseTtlMs: Number(env.AGENT_LEASE_TTL_MS ?? 90_000),
    runtime: env.AGENT_RUNTIME,
    serviceName: env.AGENT_SERVICE_NAME,
    // js_exec: the node's v8-exec runner, its executions at once for tenants with a limit, and whether startup requires
    // agent-launcher's confinement (AGENT_SANDBOX_REQUIRED=1; the image sets it).
    v8: v8Settings(env),
    codeCapacity: codeCapacity(env),
    sandboxRequired: env.AGENT_SANDBOX_REQUIRED === "1",
    // The most of an agent's history its host keeps in memory (AGENT_HISTORY_BACKLOG_BYTES).
    historyBacklogBytes: Number(env.AGENT_HISTORY_BACKLOG_BYTES) || BACKLOG_BYTES,
    // What its agent processes are told of these settings.
    agentEnv: agentProcessEnv(env),
    systemPrompt: env.AGENT_SYSTEM_PROMPT,
    schedulerIntervalMs: Number(env.AGENT_SCHEDULER_INTERVAL_MS ?? 5_000),
    consoleDir: resolve(env.AGENT_CONSOLE_DIR ?? fileURLToPath(new URL("../console/dist", import.meta.url))),
    docsDir: resolve(env.AGENT_DOCS_DIR ?? fileURLToPath(new URL("../docs", import.meta.url))),
    registryDir: resolve(env.AGENT_REGISTRY_DIR ?? fileURLToPath(new URL("../packages/registry/public/r", import.meta.url))),
    openAiAppsChallenge: env.AGENT_OPENAI_APPS_CHALLENGE?.trim(),
    // A self-hosted runtime configured by its environment (AGENT_TENANT) takes model keys there too.
    selfHostedTenant: !!env.AGENT_TENANT,
    stripe: { apiUrl: env.AGENT_STRIPE_API_URL, portalConfiguration: env.AGENT_STRIPE_PORTAL_CONFIGURATION },
    minAccountDays,
    openSignup: env.AGENT_OPEN_SIGNUP === "true",
    github: { org: env.GITHUB_ORG ?? "qaml-ai", webUrl: env.AGENT_GITHUB_WEB_URL, apiUrl: env.AGENT_GITHUB_API_URL },
    googleIssuer: env.AGENT_GOOGLE_ISSUER || undefined,
    searchTimeoutMs,
    firecrawlUrl: env.AGENT_FIRECRAWL_SCRAPE_URL,
    telemetry: { intervalMs: optional("AGENT_TELEMETRY_INTERVAL_MS"), retryBaseMs: optional("AGENT_TELEMETRY_RETRY_MS") },
    usageWebhookRetryMs: optional("AGENT_USAGE_WEBHOOK_RETRY_MS"),
    channelRetryMs: optional("AGENT_CHANNEL_RETRY_MS"),
    runOverrunMs: optional("AGENT_RUN_OVERRUN_MS"),
    snapshotBytes: optional("AGENT_SNAPSHOT_BYTES"),
    idempotencyLockMs: optional("AGENT_IDEMPOTENCY_LOCK_MS"),
    // Email channels, when the runtime has a domain SES receives for.
    email: env.AGENT_EMAIL_DOMAIN ? {
      domain: env.AGENT_EMAIL_DOMAIN, topics: (env.AGENT_EMAIL_SNS_TOPICS ?? "").split(",").map(topic => topic.trim()).filter(Boolean),
      ...(env.AGENT_EMAIL_BUCKET ? { bucket: env.AGENT_EMAIL_BUCKET } : {}), region: env.AGENT_EMAIL_REGION ?? env.AWS_REGION,
    } : undefined,
    channelApis: { telegram: env.AGENT_TELEGRAM_API_URL, slack: env.AGENT_SLACK_API_URL, discord: env.AGENT_DISCORD_API_URL, github: env.AGENT_GITHUB_API_URL },
    // Managed Discord servers a tenant may connect, on free credit and otherwise, unless its tenants entry says.
    discordServers: { free: Number(env.AGENT_DISCORD_MANAGED_FREE_SERVERS ?? 1), paid: Number(env.AGENT_DISCORD_MANAGED_SERVERS ?? 10) },
    verifyKeys: env.AGENT_VERIFY_KEYS !== "false",
    billingAdmins: (env.AGENT_BILLING_ADMINS ?? "").split(",").map(value => value.trim()).filter(Boolean),
    purgeMs, billingMs, reconcileDays,
    gc: {
      enabled: env.AGENT_GC_ENABLED === "true", dryRun: env.AGENT_GC_DRY_RUN === "true", pollMs: Number(env.AGENT_GC_POLL_MS ?? 60_000),
      graceMs: Number(env.AGENT_GC_GRACE_MS ?? 24 * 60 * 60_000), intervalMs: Number(env.AGENT_GC_INTERVAL_MS ?? 6 * 60 * 60_000),
    },
    ecs: { agentUri: env.ECS_AGENT_URI, protectionIdleMs: Number(env.AGENT_PROTECTION_IDLE_MS ?? 30_000), pollMs: Number(env.AGENT_ECS_POLL_MS ?? 30_000) },
  };
}
