import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { LocalWorker, unusedPort } from "./local-worker.ts";
import { migrate } from "../scripts/migrate.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
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
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Local Worker fixture cleanup failed");
  };
  const admin = new pg.Client({ connectionString: base });
  cleanups.push(() => admin.end());
  try {
  await admin.connect();
  await admin.query(`create database ${schema}`);
  cleanups.push(async () => { await admin.query(`drop database ${schema} with (force)`); });
  // Hyperdrive validates a password even when isolated local Postgres uses trust auth.
  if (!parsed.password) parsed.password = "local-only-unused";
  parsed.pathname = `/${schema}`;
  parsed.search = "";
  const databaseUrl = parsed.toString(),
    db = new pg.Pool({ connectionString: databaseUrl });
  cleanups.push(() => closePool(db));
  await migrate(db);
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
  const port = await unusedPort();
  const config = JSON.parse(
    await readFile(join(root, options.config ?? "wrangler.test.jsonc"), "utf8"),
  );
  config.main = options.entrypoint ?? join(root, "src/index.ts");
  config.$schema = join(root, "node_modules/wrangler/config-schema.json");
  for (const container of config.containers ?? [])
    for (const image of Object.values(container.images ?? {}) as {
      dockerfile?: string;
    }[])
      if (image.dockerfile) image.dockerfile = join(root, image.dockerfile);
  config.hyperdrive[0].localConnectionString = databaseUrl;
  const port = await unusedPort();
  config.vars = {
    ...config.vars,
    API_TOKEN: token,
    DEFAULT_TENANT: tenant,
    AGENT_PUBLIC_URL: `http://127.0.0.1:${port}`,
    AGENT_SECRETS_KEY: "0".repeat(64),
    AGENT_OUTBOUND_ALLOW_HTTP: "true",
    AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.0/8,::1/128",
    ...options.vars,
    ...(options.vars?.AGENT_PUBLIC_URL === "" ? { AGENT_PUBLIC_URL: `http://127.0.0.1:${port}`, PUBLIC_URL: `http://127.0.0.1:${port}` } : {}),
    ...(options.modelURL ? { TEST_MODEL_BASE_URL: options.modelURL } : {}),
  };
  const configPath = join(storage, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config));
  const worker = new LocalWorker(
    port,
    storage,
    configPath,
    token,
  );
  cleanups.push(() => worker.stop());
  await worker.start();
  return { url: worker.url, databaseUrl, db, worker, token, stop,
    async restart(vars: Record<string, string> = {}, crash = false) {
      await worker.stop(crash);
      Object.assign(config.vars, vars);
      await writeFile(configPath, JSON.stringify(config));
      await worker.start();
    },
  };
  } catch (error) {
    try { await stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Local Worker fixture startup and cleanup failed"); }
    throw error;
  }
}
