import { readFile } from "node:fs/promises";
import { unstable_dev, unstable_DevEnv } from "wrangler";

const [config, port, inspectorPort, persistTo] = process.argv.slice(2);
const { name } = JSON.parse(await readFile(config, "utf8"));
const dispatch = unstable_DevEnv.prototype.dispatch;

// Wrangler's browser-development proxy rewrites response URLs and waits for an
// upload before forwarding an early response. Contract clients need the raw
// workerd socket: the same HTTP headers and streaming behavior as production.
unstable_DevEnv.prototype.dispatch = function (event) {
  if (event.type === "reloadComplete" && event.config.name === name) {
    const { protocol, hostname, port } = event.proxyData.userWorkerUrl;
    if (protocol !== "http:" || hostname !== "127.0.0.1")
      throw new Error("Local fixture must use a loopback workerd socket");
    process.send?.({ type: "workerd", port: Number(port) });
  }
  return dispatch.call(this, event);
};

const worker = await unstable_dev(undefined, {
  config: [config, "codemode/wrangler.jsonc"],
  local: true,
  port: Number(port),
  inspectorPort: Number(inspectorPort),
  persistTo,
  experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false },
});
const stop = async () => { await worker.stop(); process.exit(0); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
