import { nodeConfig } from "./node-config.ts";
import { createNode, nodeDeps } from "./node.ts";

// The runtime server: one node (src/node.ts) configured by this process's environment. What belongs to the process is
// here: its signals, and exiting once the node has left the cluster.
const config = nodeConfig(process.env);
const node = await createNode(config, await nodeDeps(config));
process.on("SIGHUP", () => void node.reloadTenants());
// The first signal drains; a second one stops waiting for running turns.
let exiting = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (exiting) { void node.drain(signal); return; }
  exiting = true;
  node.drain(signal).then(() => process.exit(0), () => process.exit(1));
});
await node.start();
