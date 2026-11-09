// Fixture-only entrypoint: no production server loads this file.
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps } from "../src/node.ts";
const config = nodeConfig(process.env);
const node = await createNode(config, await nodeDeps(config));
node.app.post("/__test/shared/:agent/:member", async c => {
  const input = await c.req.json();
  return c.json(await node.clients.submit(c.req.param("agent"), "alice", { id: crypto.randomUUID(), method: "prompt", params: input }, undefined, c.req.param("member")), 202);
});
process.on("SIGHUP", () => void node.reloadTenants());
process.on("SIGTERM", () => void node.drain("SIGTERM"));
await node.start();
