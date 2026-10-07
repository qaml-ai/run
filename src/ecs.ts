import { network } from "./node-context.ts";
/** This task's private IPv4 from the ECS container metadata endpoint; undefined off ECS. */
export async function taskAddress(env = process.env): Promise<string | undefined> {
  if (!env.ECS_CONTAINER_METADATA_URI_V4) return undefined;
  const { Networks } = await metadata(env.ECS_CONTAINER_METADATA_URI_V4) as { Networks?: { IPv4Addresses?: string[] }[] };
  const address = Networks?.find(network => network.IPv4Addresses?.length)?.IPv4Addresses![0];
  // Peers would forward to loopback and reach themselves; better not to start.
  if (!address) throw new Error("ECS container metadata has no private IPv4 address; set AGENT_NODE_URL");
  return address;
}

async function metadata(url: string) {
  const response = await network().fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`ECS container metadata answered HTTP ${response.status}`);
  return response.json() as Promise<any>;
}

/**
 * How peers reach this node, which is also the name its heartbeat and ownership
 * rows carry: AGENT_NODE_URL, else on ECS the task's private IPv4, else loopback.
 */
export function nodeUrl(env: NodeJS.ProcessEnv, port: number, address?: string) {
  if (env.AGENT_NODE_URL) return env.AGENT_NODE_URL.replace(/\/+$/, "");
  return `http://${address ?? "127.0.0.1"}:${port}`;
}

type Deployment = { taskDefinition?: string; createdAt?: Date; runningCount?: number; desiredCount?: number };

/**
 * Whether a newer deployment of this task's ECS service has replaced it: the
 * primary deployment runs another task definition, or was created after this task
 * started (a forced deployment of the same revision). "waiting" while that deployment
 * does not yet run all its tasks, for at most AGENT_RETIRE_WAIT_MS (default 10 min),
 * so the task keeps serving until its replacements can; then "superseded". The
 * service is AGENT_ECS_SERVICE; the cluster is AGENT_ECS_CLUSTER or the task's own.
 * Undefined when this is not an ECS service task.
 */
export async function supersession(env = process.env, describe?: (cluster: string, service: string) => Promise<Deployment | undefined>, options: { now?: () => number } = {}) {
  if (!env.ECS_CONTAINER_METADATA_URI_V4 || !env.AGENT_ECS_SERVICE) return undefined;
  const waitMs = Number(env.AGENT_RETIRE_WAIT_MS ?? 10 * 60_000);
  if (!Number.isInteger(waitMs) || waitMs < 0) throw new Error("AGENT_RETIRE_WAIT_MS must be a non-negative integer");
  const now = options.now ?? Date.now;
  const task = await metadata(`${env.ECS_CONTAINER_METADATA_URI_V4}/task`);
  const cluster = env.AGENT_ECS_CLUSTER ?? task.Cluster;
  const service = env.AGENT_ECS_SERVICE;
  const own = `:task-definition/${task.Family}:${task.Revision}`;
  const started = task.PullStartedAt ? Date.parse(task.PullStartedAt) : undefined;
  if (!describe) {
    const { DescribeServicesCommand, ECSClient } = await import("@aws-sdk/client-ecs");
    const client = new ECSClient({ region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION });
    describe = async (cluster, service) => {
      const { services } = await client.send(new DescribeServicesCommand({ cluster, services: [service] }));
      return services?.[0]?.deployments?.find(deployment => deployment.status === "PRIMARY");
    };
  }
  // Since when, and by which deployment: a newer one starts the wait again.
  let since: { deployment: string; at: number } | undefined;
  return async (): Promise<"current" | "waiting" | "superseded"> => {
    const primary = await describe!(cluster, service);
    if (!primary?.taskDefinition) return "current";
    if (primary.taskDefinition.endsWith(own) && (started === undefined || !primary.createdAt || primary.createdAt.getTime() <= started)) {
      since = undefined;
      return "current";
    }
    const deployment = `${primary.taskDefinition}@${primary.createdAt?.getTime() ?? ""}`;
    if (since?.deployment !== deployment) since = { deployment, at: now() };
    const running = primary.runningCount === undefined || primary.desiredCount === undefined || primary.runningCount >= primary.desiredCount;
    return running || now() - since.at >= waitMs ? "superseded" : "waiting";
  };
}

/**
 * ECS task scale-in protection through the ECS agent endpoint (ECS_AGENT_URI), so
 * neither scale-in nor a deployment stops a task mid-turn. It is set as soon as
 * work runs, renewed well before it expires, and cleared only after `idleMs`
 * without work, so short gaps between turns do not flap it. A no-op off ECS.
 */
const BLOCKED_RETRY_MS = 5_000;
const BLOCKED_RETRY_MAX_MS = 5 * 60_000;

export class TaskProtection {
  private readonly uri?: string;
  private readonly idleMs: number;
  private readonly expiresMinutes: number;
  private readonly now: () => number;
  private enabledAt?: number;
  private lastBusy = -Infinity;
  private writing = false;
  /** ECS refuses protection to a task a deployment is replacing (DEPLOYMENT_BLOCKED): asks again only after this, backing off. */
  private blockedUntil = -Infinity;
  private blockedMs = 0;

  constructor(options: { uri?: string; idleMs?: number; expiresMinutes?: number; now?: () => number }) {
    this.uri = options.uri?.replace(/\/+$/, "");
    this.idleMs = options.idleMs ?? 30_000;
    this.expiresMinutes = options.expiresMinutes ?? 60;
    this.now = options.now ?? Date.now;
  }

  get enabled() { return this.enabledAt !== undefined; }

  /** Called on every tick with whether any turn is running. Failed writes retry on the next tick. */
  async update(busy: boolean) {
    if (!this.uri || this.writing) return;
    const now = this.now();
    if (busy) this.lastBusy = now;
    const renew = this.enabledAt !== undefined && now - this.enabledAt >= this.expiresMinutes * 60_000 / 4;
    if (busy && (this.enabledAt === undefined || renew)) { if (now >= this.blockedUntil) await this.write(true, now); }
    else if (!busy && this.enabledAt !== undefined && (renew || now - this.lastBusy >= this.idleMs)) await this.write(now - this.lastBusy < this.idleMs, now);
  }

  private async write(enabled: boolean, now: number) {
    this.writing = true;
    try {
      const response = await network().fetch(`${this.uri}/task-protection/v1/state`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify(enabled ? { ProtectionEnabled: true, ExpiresInMinutes: this.expiresMinutes } : { ProtectionEnabled: false }),
      });
      const body = await response.json().catch(() => ({})) as { failure?: { Reason?: string } };
      // Expected while a deployment drains this task: not a failure, logged once, asked again with backoff.
      if (enabled && body.failure?.Reason === "DEPLOYMENT_BLOCKED") {
        if (!this.blockedMs) console.log(JSON.stringify({ type: "task_protection_blocked", reason: "DEPLOYMENT_BLOCKED" }));
        this.blockedMs = Math.min(Math.max(this.blockedMs * 2, BLOCKED_RETRY_MS), BLOCKED_RETRY_MAX_MS);
        this.blockedUntil = now + this.blockedMs;
        return;
      }
      if (!response.ok || body.failure) throw new Error(body.failure?.Reason ?? `HTTP ${response.status}`);
      this.enabledAt = enabled ? now : undefined;
      console.log(JSON.stringify({ type: "task_protection", enabled }));
    } catch (error) {
      console.error(JSON.stringify({ type: "task_protection_failed", enabled, error: (error as Error).message }));
    } finally { this.writing = false; }
  }
}

/**
 * `hostedAgents`: agents started on the node (processes, or inline hosts), what
 * AGENT_MAX_AGENTS caps. `sessions`: agents loaded here (journal and stream in
 * memory), hosted or not. `watchers`: event stream subscribers held here (watchers and
 * waiting polls). `dbConnections`, `dbIdle`, `dbWaiting`: the database pool's
 * connections, idle ones, and queries waiting for one. `heapUsedBytes`,
 * `heapTotalBytes`, `externalBytes`, `arrayBuffersBytes`: the V8 heap and native
 * buffer memory inside `rssBytes`, to tell live objects from memory kept after use.
 */
export type NodeLoad = {
  hostedAgents: number; sessions: number; volumes: number; runningTurns: number; rssBytes: number;
  watchers?: number; dbConnections?: number; dbIdle?: number; dbWaiting?: number;
  heapUsedBytes?: number; heapTotalBytes?: number; externalBytes?: number; arrayBuffersBytes?: number;
};
const OPTIONAL_LOAD = ["watchers", "dbConnections", "dbIdle", "dbWaiting"] as const;
const OPTIONAL_BYTES = ["heapUsedBytes", "heapTotalBytes", "externalBytes", "arrayBuffersBytes"] as const;

/**
 * A `node_load` log line in CloudWatch Embedded Metric Format: CloudWatch Logs
 * extracts the metrics itself, so publishing needs no API calls or IAM.
 */
export function nodeLoadLine(load: NodeLoad, service?: string, extra: Record<string, unknown> = {}, now = Date.now()) {
  return JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [{
        Namespace: "AgentRuntime", Dimensions: [service ? ["ServiceName"] : []],
        Metrics: [
          { Name: "hostedAgents", Unit: "Count" }, { Name: "sessions", Unit: "Count" },
          { Name: "volumes", Unit: "Count" }, { Name: "runningTurns", Unit: "Count" }, { Name: "rssBytes", Unit: "Bytes" },
          ...OPTIONAL_LOAD.filter(name => load[name] !== undefined).map(name => ({ Name: name, Unit: "Count" })),
          ...OPTIONAL_BYTES.filter(name => load[name] !== undefined).map(name => ({ Name: name, Unit: "Bytes" })),
        ],
      }],
    },
    type: "node_load", ...extra, ...(service ? { ServiceName: service } : {}), ...load,
  });
}
