import { serveFakeCamelfsd } from "./fake-camelfsd.ts";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto";
import pg from "pg";
import { LocalWorker, unusedPort } from "./local-worker.ts";
import { checkFixtureLifecycle, registerFixture } from "./fixture-lifecycle.ts";
import { createMigratedDatabase } from "./migrated-database.ts";
import { publicAssets } from "../scripts/public-assets.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
/** The alarm guard's lines in a worker's log (src/alarm-guard.ts): hot loops, and immediate re-arms counted per object. */
export function alarmFindings(logs: string) {
  const hot: string[] = [], due: Record<string, number> = {};
  for (const match of logs.matchAll(/\{"type":"alarm_(hot_loop|rearm_due)"[^\n]*?\}(?=\s|$)/g)) {
    try {
      const line = JSON.parse(match[0]) as { type: string; object: string; fires?: number };
      if (line.type === "alarm_hot_loop") hot.push(`${line.object} (${line.fires} fires)`);
      else due[line.object] = (due[line.object] ?? 0) + 1;
    } catch { /* a line cut by the log limit */ }
  }
  return { hot, due: Object.entries(due).map(([object, count]) => ({ object, count })) };
}

/** pg-pool removes idle clients from its count before their socket-end callback.
 * Wait for those callbacks too before DROP DATABASE can terminate the sockets. */
async function closePool(db: pg.Pool) {
  let remaining = db.totalCount;
  if (!remaining) return db.end();
  let closed!: () => void;
  const socketsClosed = new Promise<void>(resolve => { closed = resolve; });
  const removed = () => { if (--remaining === 0) closed(); };
  db.on("remove", removed);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([db.end(), socketsClosed]),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Local test pool did not close ${remaining} connection(s); its database was not dropped`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    db.off("remove", removed);
  }
}
export async function startFixture(
  options: {
    token?: string;
    tenant?: string;
    modelURL?: string;
    config?: string;
    schema?: string;
    tenants?: { id: string; token?: string; tokenSha256?: string; billing?: 'prepaid' | 'none'; seedCredit?: boolean }[];
    vars?: Record<string, string>;
    /** A local-test entrypoint, e.g. the backend-neutral contract fixture wrapper. */
    entrypoint?: string;
    /** Bind camelFS to the test-only CamelfsStub named entrypoint (default: on, served by an in-process fake
     * camelfsd unless `vars.TEST_CAMELFS_URL` names one). Every agent's workspace is a repo, so agents need it. */
    camelfsStub?: boolean;
    camelfsTier?: boolean;
    scheduled?: boolean;
    signal?: AbortSignal;
    /** No AGENT_PUBLIC_URL, as a local `wrangler dev` or a self-host without one: origins come from requests. */
    noPublicUrl?: boolean;
  } = {},
) {
  const token =
      options.token ??
      "local-integration-only-token-with-at-least-32-characters",
    tenant = options.tenant ?? "camelrun-proto-local";
  const schema = options.schema ?? `workers_${randomBytes(8).toString("hex")}`;
  if (!/^[a-z][a-z0-9_]+$/.test(schema))
    throw new Error("Unsafe local test schema");
  const base =
    process.env.AGENT_TEST_DATABASE_URL ??
    "postgresql://postgres:local-only-unused@127.0.0.1:55434/camelrun_proto";
  const parsed = new URL(base);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname))
    throw new Error("Local test Postgres required");
  const storage = await mkdtemp(join(tmpdir(), "camelrun-proto-workers-test-"));
  const cleanups: Array<() => Promise<void>> = [() => rm(storage, { recursive: true, force: true })];
  let stopped = false;
  let startingWorker: LocalWorker | undefined;
  let finishStartup!: () => void;
  const startupDone = new Promise<void>(resolve => { finishStartup = resolve; });
  let stopScheduled: (() => Promise<void>) | undefined;
  let stopPromise: Promise<void> | undefined;
  const stop = () => stopPromise ??= (async () => {
    stopped = true;
    const failures: unknown[] = [];
    // An admitted Cron request needs the Worker until it finishes. Preserve a
    // failure from that request, but still stop the processes and database.
    if (stopScheduled) try { await stopScheduled(); } catch (error) { failures.push(error); }
    // Stop owned processes immediately, but let an in-flight CREATE DATABASE
    // finish registering its cleanup before closing the admin connection.
    const workerStopped = startingWorker?.stop();
    await startupDone;
    if (workerStopped) try { await workerStopped; } catch (error) { failures.push(error); }
    // A Durable Object whose alarm spun (src/alarm-guard.ts logged alarm_hot_loop) fails the test that ran it; an alarm
    // left due at once by its own handler (alarm_rearm_due, test mode) is listed, for the guard's report.
    const findings = alarmFindings(startingWorker?.alarmLogs() ?? "");
    if (findings.hot.length) failures.push(new Error(`A Durable Object alarm looped (alarm_hot_loop): ${findings.hot.slice(0, 5).join("; ")}`));
    if (findings.due.length) console.log(`ALARM_REARM_DUE ${JSON.stringify(findings.due)}`);
    try {
      for (const cleanup of cleanups.reverse()) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
    } finally {
      unregister();
      options.signal?.removeEventListener("abort", aborted);
    }
    if (failures.length) throw new AggregateError(failures, "Local Worker fixture cleanup failed");
  })();
  // Register before database migration or workerd startup can be interrupted.
  const unregister = registerFixture(stop);
  const aborted = () => { void stop().catch(error => {
    console.error(`Local Worker abort cleanup failed: ${error.message}`);
  }); };
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const admin = new pg.Client({ connectionString: base });
  cleanups.push(() => admin.end());
  try {
  checkFixtureLifecycle();
  if (stopped) throw new Error("Local Worker fixture startup was cancelled");
  await admin.connect();
  await createMigratedDatabase(admin, base, schema);
  // Keep migration and teardown alive while they use the maintenance connection.
  // Between them an abandoned fixture must be able to exit.
  const adminSocket = admin.connection.stream as Socket;
  cleanups.push(async () => {
    adminSocket.ref();
    await admin.query(`drop database ${schema} with (force)`);
  });
  // Hyperdrive validates a password even when isolated local Postgres uses trust auth.
  if (!parsed.password) parsed.password = "local-only-unused";
  parsed.pathname = `/${schema}`;
  parsed.search = "";
  const databaseUrl = parsed.toString(),
    db = new pg.Pool({ connectionString: databaseUrl, allowExitOnIdle: true });
  cleanups.push(() => closePool(db));
  for (const item of options.tenants ?? [{ id: tenant, token }]) {
    await db.query(
      "insert into tenants(id,created_at,billing) values($1,$2,$3) on conflict do nothing",
      [item.id, Date.now(), item.billing ?? 'prepaid'],
    );
    if (item.seedCredit !== false) await db.query(
      "with input as (insert into credit_ledger(tenant,kind,amount,idempotency_key,created_at) values($1,'purchase',100000000,$3,$2) on conflict do nothing returning tenant,amount) insert into credit_accounts(tenant,balance,purchased) select tenant,amount,amount from input on conflict(tenant) do update set balance=credit_accounts.balance+excluded.balance,purchased=credit_accounts.purchased+excluded.purchased",
      [item.id, Date.now(), `workers:fixture:seed:${item.id}`],
    );
    await db.query(
      "insert into api_tokens(sha256,id,tenant,name,prefix,created_at) values($1,$2,$3,'fixture','fixture',$4) on conflict do nothing",
      [
        item.tokenSha256 ??
          createHash("sha256").update(item.token!).digest("hex"),
        crypto.randomUUID(),
        item.id,
        Date.now(),
      ],
    );
  }
  // Public OAuth discovery tests select the listening port before building
  // their issuer and callback origins, as the Node fixture does.
  const requestedPort = options.vars?.PORT;
  const port = requestedPort === undefined ? await unusedPort() : Number(requestedPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Invalid fixture PORT");
  const config = JSON.parse(
    await readFile(join(root, options.config ?? "wrangler.test.jsonc"), "utf8"),
  );
  config.main = options.entrypoint ?? join(root, "test/worker-entry.ts");
  if (config.assets?.directory) config.assets.directory = join(root, config.assets.directory);
  if (options.vars?.AGENT_CONSOLE_DIR) config.assets = { directory: options.vars.AGENT_CONSOLE_DIR, binding: "ASSETS", run_worker_first: true, not_found_handling: "single-page-application" };
  config.$schema = join(root, "node_modules/wrangler/config-schema.json");
  for (const container of config.containers ?? [])
    for (const image of Object.values(container.images ?? {}) as {
      dockerfile?: string;
    }[])
      if (image.dockerfile) image.dockerfile = join(root, image.dockerfile);
  const camelfs = !options.camelfsTier && (options.camelfsStub ?? true);
  let camelfsVars: Record<string, string> = {};
  if (options.camelfsTier) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const kid = "fixture-camelfs", issuer = options.vars?.AGENT_PUBLIC_URL || `http://127.0.0.1:${port}`;
    const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" };
    const key = Buffer.from(options.vars?.AGENT_SECRETS_KEY ?? "0".repeat(64), "hex");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("runtime-signing:" + kid));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(privateKey.export({ format: "jwk" }))), cipher.final()]);
    await db.query("INSERT INTO signing_keys(kid,public_jwk,private_sealed,created_at) VALUES ($1,$2,$3,$4)",
      [kid, jwk, { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }, Date.now()]);
    const daemon = await serveFakeCamelfsd(randomBytes(24).toString("hex"), { issuer, jwks: { keys: [jwk] } });
    cleanups.push(() => daemon.close());
    camelfsVars = { CAMELFS_URL: daemon.url };
  }
  if (camelfs && !options.vars?.TEST_CAMELFS_URL) {
    const camelfsToken = `fixture-camelfs-${randomBytes(8).toString("hex")}`, daemon = await serveFakeCamelfsd(camelfsToken, { unref: true });
    cleanups.push(() => daemon.close());
    camelfsVars = { TEST_CAMELFS_URL: daemon.url, CAMELFS_API_TOKEN: camelfsToken };
  }
  if (camelfs) config.services = [
    ...(config.services ?? []),
    { binding: "CAMELFS", service: config.name, entrypoint: "CamelfsStub" },
  ];
  config.hyperdrive[0].localConnectionString = databaseUrl;
  config.vars = {
    ...config.vars,
    API_TOKEN: token,
    DEFAULT_TENANT: tenant,
    AGENT_PUBLIC_URL: `http://127.0.0.1:${port}`,
    AGENT_SECRETS_KEY: "0".repeat(64),
    AGENT_OUTBOUND_ALLOW_HTTP: "true",
    AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.0/8,::1/128",
    ...camelfsVars,
    ...(options.vars?.AGENT_ACCOUNT_EMAIL_FROM ? { SCHEDULE_EMAIL_FROM: options.vars.AGENT_ACCOUNT_EMAIL_FROM } : {}),
    ...options.vars,
    ...(options.vars?.AGENT_PUBLIC_URL === "" ? { AGENT_PUBLIC_URL: `http://127.0.0.1:${port}`, PUBLIC_URL: `http://127.0.0.1:${port}` } : {}),
    ...(options.modelURL ? { TEST_MODEL_BASE_URL: options.modelURL } : {}),
  };
  if (options.noPublicUrl) delete config.vars.AGENT_PUBLIC_URL;
  const configPath = join(storage, "wrangler.json");
  const assetDirectory = join(storage, "public");
  await publicAssets(assetDirectory, {
    docs: options.vars?.AGENT_DOCS_DIR,
    registry: options.vars?.AGENT_REGISTRY_DIR,
    console: options.vars?.AGENT_CONSOLE_DIR,
  });
  config.assets = { directory: assetDirectory, binding: "PUBLIC_ASSETS", run_worker_first: true, html_handling: "none", not_found_handling: "none" };
  await writeFile(configPath, JSON.stringify(config));
  if (stopped) throw new Error("Local Worker fixture startup was cancelled");
  const worker = new LocalWorker(
    port,
    storage,
    configPath,
    token,
  );
  startingWorker = worker;
  adminSocket.unref();
  await worker.start(options.signal);
  if (stopped) throw new Error("Local Worker fixture startup was cancelled");
  finishStartup();
  if ((config.vars.MAIL_TEST_URL || options.scheduled) && !stopped) {
    // Wrangler does not advance Cron Triggers itself. Tick the production job
    // for local mail fixtures, including notifications enqueued directly by SQL.
    let pending: Promise<void> | undefined;
    let failed: unknown;
    const timer = setInterval(() => {
      if (!pending) pending = worker.scheduled().catch(error => { failed = error; }).finally(() => { pending = undefined; });
    }, 1000).unref();
    stopScheduled = async () => {
      clearInterval(timer);
      await pending;
      if (failed) throw failed;
    };
  }
  return { url: worker.url, databaseUrl, db, worker, token, stop,
    async restart(vars: Record<string, string> = {}, crash = false) {
      await worker.stop(crash);
      Object.assign(config.vars, vars);
      await writeFile(configPath, JSON.stringify(config));
      await worker.start(options.signal);
    },
  };
  } catch (error) {
    finishStartup();
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Local Worker fixture startup and cleanup failed"); }
    throw error;
  }
}
