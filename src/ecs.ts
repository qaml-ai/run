/**
 * How peers reach this node, which is also the name its heartbeat and ownership
 * rows carry: AGENT_NODE_URL, else on ECS the task's private IPv4 from the container
 * metadata endpoint, else loopback.
 */
export async function nodeUrl(env = process.env, port = Number(env.PORT ?? 8790)) {
  if (env.AGENT_NODE_URL) return env.AGENT_NODE_URL.replace(/\/+$/, "");
  if (!env.ECS_CONTAINER_METADATA_URI_V4) return `http://127.0.0.1:${port}`;
  const response = await fetch(env.ECS_CONTAINER_METADATA_URI_V4, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`ECS container metadata answered HTTP ${response.status}`);
  const { Networks } = await response.json() as { Networks?: { IPv4Addresses?: string[] }[] };
  const address = Networks?.find(network => network.IPv4Addresses?.length)?.IPv4Addresses![0];
  // Peers would forward to loopback and reach themselves; better not to start.
  if (!address) throw new Error("ECS container metadata has no private IPv4 address; set AGENT_NODE_URL");
  return `http://${address}:${port}`;
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
