import { nodeConfig } from "./node-config.ts";
import { createNode, nodeDeps } from "./node.ts";
import { setMetricService } from "./metrics.ts";

// The runtime server: one node (src/node.ts) configured by this process's environment. What belongs to the process is
// here: its signals, and exiting once the node has left the cluster.
const config = nodeConfig(process.env);
setMetricService(config.serviceName);
const node = await createNode(config, await nodeDeps(config));
process.on("SIGHUP", () => void node.reloadTenants());
// The first signal drains; a second one stops waiting for running turns.
let exiting = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (exiting) { void node.drain(signal); return; }
  exiting = true;
  node.drain(signal).then(() => process.exit(0), () => process.exit(1));
});
// An error nothing caught, or a rejection nothing handled: logged with its stack, then the node drains, waiting at most
// FATAL_DRAIN_MS for running turns (with a peer they are handed off at their next step), and the process exits 1. Its
// state is not trusted for longer: past FATAL_EXIT_MS it exits whatever the drain is doing. Without this, Node ended the
// process at once, every turn on it cut mid-step and its unflushed usage lost.
const FATAL_DRAIN_MS = 15_000, FATAL_EXIT_MS = 45_000;
let fatal = false;
const fatally = (kind: "uncaughtException" | "unhandledRejection") => (error: unknown) => {
  const { message, stack } = error instanceof Error ? error : { message: String(error), stack: undefined };
  console.error(JSON.stringify({ type: "process_fatal", kind, error: message.slice(0, 1_000), ...(stack ? { stack: stack.slice(0, 4_000) } : {}), again: fatal }));
  if (fatal) return;
  fatal = exiting = true;
  setTimeout(() => process.exit(1), FATAL_EXIT_MS);
  node.drainWithin(kind, FATAL_DRAIN_MS).finally(() => process.exit(1));
};
process.on("uncaughtException", fatally("uncaughtException"));
process.on("unhandledRejection", fatally("unhandledRejection"));
await node.start();
