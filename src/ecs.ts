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
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
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

/** Where executors call tools back: AGENT_EXECUTOR_CALLBACK_URL, else on ECS this task, which holds the execution's capabilities. */
export function callbackUrl(env: NodeJS.ProcessEnv, port: number, address?: string) {
  return (env.AGENT_EXECUTOR_CALLBACK_URL ?? (address ? `http://${address}:${port}` : "")).replace(/\/+$/, "");
}

export type NodeLoad = { agents: number; volumes: number; runningTurns: number; rssBytes: number };

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
        Metrics: [{ Name: "agents", Unit: "Count" }, { Name: "volumes", Unit: "Count" }, { Name: "runningTurns", Unit: "Count" }, { Name: "rssBytes", Unit: "Bytes" }],
      }],
    },
    type: "node_load", ...extra, ...(service ? { ServiceName: service } : {}), ...load,
  });
}
