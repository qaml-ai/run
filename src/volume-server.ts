import { serve } from "@hono/node-server";
import { Accounts } from "./accounts.ts";
import { ConsoleAuth } from "./console-auth.ts";
import { applyDatabase, databaseFromEnvironment, migrate } from "./db.ts";
import { FileLinks } from "./files.ts";
import { postgresTail } from "./log-tail.ts";
import { Ownership, probeNode } from "./ownership.ts";
import { Passwords } from "./passwords.ts";
import { secretReader } from "./secrets.ts";
import { StorageUsage } from "./storage-usage.ts";
import { tenantsFromEnvironment } from "./tenants.ts";
import { clusterVolumes, sweepVolumeReceipts, volumeApp } from "./volume-app.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";

const env = process.env;
const port = Number(env.PORT ?? 8792);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a TCP port");
const host = env.HOST ?? "127.0.0.1";
const node = env.AGENT_NODE_URL ?? `http://127.0.0.1:${port}`;
const peerUrl = new URL(node);
if (!["http:", "https:"].includes(peerUrl.protocol) || peerUrl.origin !== node) throw new Error("AGENT_NODE_URL must be the origin peers use for this volume node");

const originToken = env.LEGACY_VOLUMES_ORIGIN_TOKEN;
if (!originToken || originToken.length < 32) throw new Error("Set LEGACY_VOLUMES_ORIGIN_TOKEN to at least 32 random characters");
const publicUrl = (env.AGENT_PUBLIC_URL ?? "https://run.camelai.com").replace(/\/+$/, "");
if (env.AGENT_SESSION_SECRET && env.AGENT_SESSION_SECRET_ARN) throw new Error("Set AGENT_SESSION_SECRET or AGENT_SESSION_SECRET_ARN, but not both");
const sessionSecret = env.AGENT_SESSION_SECRET_ARN ? await (await secretReader(env.AGENT_SESSION_SECRET_ARN))() : env.AGENT_SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) throw new Error("Set the existing runtime's session secret (AGENT_SESSION_SECRET or AGENT_SESSION_SECRET_ARN)");

const descriptor = storageFromEnvironment(env.AGENT_DATA_DIR ?? "data");
if (descriptor.kind === "file" && !descriptor.shared) throw new Error("Volume nodes use the runtime's existing s3 or shared-file storage");
const tenants = await tenantsFromEnvironment();
const pool = await databaseFromEnvironment();
const db = applyDatabase(pool);
await migrate(db);
const storageUsage = new StorageUsage(db);
const storage = await openStorage(descriptor, postgresTail(db), storageUsage.meter);
const ownership = new Ownership(db, { node, volumeOnly: true, alive: probeNode });
const accounts = new Accounts({ tenants, db, publicUrl });
const consoleAuth = new ConsoleAuth({ accounts, publicUrl, passwords: new Passwords(db) });
const links = new FileLinks(sessionSecret, publicUrl);
const volumes = clusterVolumes({
  db, storage, ownership, sessionSecret,
  quota: async tenant => {
    const limit = await accounts.billing.storageLimit(tenant);
    return limit === undefined ? undefined : { limit, used: await storageUsage.tenantUsed(tenant) };
  },
});
const app = volumeApp({ accounts, consoleAuth, volumes, links, sessionSecret, originToken });
await ownership.start();
const receipts = sweepVolumeReceipts(db);
const server = serve({ hostname: host, port, fetch: app.fetch }, () => console.log(JSON.stringify({ type: "volume_listening", port })));
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  clearInterval(receipts);
  server.close(error => {
    void volumes.close().then(() => ownership.close()).then(() => pool.end()).then(() => {
      if (error) throw error;
    }).catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  });
});
process.on("SIGHUP", () => void tenants.reload().catch(error => console.error(error)));
