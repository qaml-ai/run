import { rm } from "node:fs/promises";
import type { RuntimeNode } from "../src/node.ts";
import { until } from "./runtime-server.ts";

export function ownNodes(t: { after(fn: () => Promise<void>): void }, root: string) {
  const nodes: RuntimeNode[] = [];
  t.after(async () => {
    const failures: { step: string; error: unknown }[] = [];
    for (const node of nodes) {
      try { await node.close(); }
      catch (error) { failures.push({ step: `close node ${node.node}`, error }); }
    }
    try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    catch (error) { failures.push({ step: `remove ${root}`, error }); }
    if (failures.length === 1) throw failures[0].error;
    if (failures.length > 1) {
      throw new AggregateError(failures.map(({ error }) => error), `Node fixture teardown failed: ${failures.map(({ step }) => step).join(", ")}`);
    }
  });
  return { nodes };
}

export async function agentStarted(node: RuntimeNode, agentId: string, what = `agent ${agentId} to start`) {
  const { sessions, supervisor } = node.clients;
  await until(() => !sessions.get(agentId)?.starting && supervisor.agents.has(agentId), what);
}
