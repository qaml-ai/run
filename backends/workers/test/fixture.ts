import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { LocalWorker, unusedPort } from "./local-worker.ts";
import { migrate } from "../scripts/migrate.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
export async function startFixture(
  options: {
    token?: string;
    tenant?: string;
    modelURL?: string;
    schema?: string;
    config?: string;
    tenants?: { id: string; token?: string; tokenSha256?: string }[];
    vars?: Record<string, string>;
  } = {},
) {
  const token =
      options.token ??
      "local-integration-only-token-with-at-least-32-characters",
    tenant = options.tenant ?? "camelrun-proto-local";
  const storage = await mkdtemp(join(tmpdir(), "camelrun-proto-workers-test-"));
  const schema = options.schema ?? `workers_${randomBytes(8).toString("hex")}`;
  if (!/^[a-z][a-z0-9_]+$/.test(schema))
    throw new Error("Unsafe local test schema");
  const base =
    process.env.AGENT_TEST_DATABASE_URL ??
    "postgresql://postgres:local-only-unused@127.0.0.1:55434/camelrun_proto";
  const parsed = new URL(base);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname))
    throw new Error("Local test Postgres required");
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${schema}`);
  parsed.pathname = `/${schema}`;
  parsed.search = "";
  const databaseUrl = parsed.toString(),
    db = new pg.Pool({ connectionString: databaseUrl });
  await migrate(db);
  for (const item of options.tenants ?? [{ id: tenant, token }]) {
    await db.query(
      "insert into tenants(id,created_at,billing) values($1,$2,'prepaid') on conflict do nothing",
      [item.id, Date.now()],
    );
    await db.query(
      "with input as (insert into credit_ledger(tenant,kind,amount,idempotency_key,created_at) values($1,'purchase',100000000,'workers:fixture:seed',$2) on conflict do nothing returning tenant,amount) insert into credit_accounts(tenant,balance,purchased) select tenant,amount,amount from input on conflict(tenant) do update set balance=credit_accounts.balance+excluded.balance,purchased=credit_accounts.purchased+excluded.purchased",
      [item.id, Date.now()],
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
  const config = JSON.parse(
    await readFile(join(root, options.config ?? "wrangler.test.jsonc"), "utf8"),
  );
  config.main = join(root, "src/index.ts");
  config.$schema = join(root, "node_modules/wrangler/config-schema.json");
  for (const container of config.containers ?? [])
    for (const image of Object.values(container.images ?? {}) as { dockerfile?: string }[])
      if (image.dockerfile) image.dockerfile = join(root, image.dockerfile);
  config.hyperdrive[0].localConnectionString = databaseUrl;
  config.vars = {
    ...config.vars,
    API_TOKEN: token,
    DEFAULT_TENANT: tenant,
    AGENT_SECRETS_KEY: "0".repeat(64),
    AGENT_OUTBOUND_ALLOW_HTTP: "true",
    AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.0/8,::1/128",
    ...options.vars,
    ...(options.modelURL ? { TEST_MODEL_BASE_URL: options.modelURL } : {}),
  };
  const configPath = join(storage, "wrangler.json");
  await writeFile(configPath, JSON.stringify(config));
  const worker = new LocalWorker(
    await unusedPort(),
    storage,
    configPath,
    token,
  );
  try {
    await worker.start();
  } catch (error) {
    await db.end();
    await admin.query(`drop database ${schema} with (force)`);
    await admin.end();
    await rm(storage, { recursive: true, force: true });
    throw error;
  }
  let stopped = false;
  return {
    url: worker.url,
    databaseUrl,
    db,
    worker,
    token,
    async stop() {
      if (stopped) return;
      stopped = true;
      await worker.stop();
      await db.end();
      await admin.query(`drop database ${schema} with (force)`);
      await admin.end();
      await rm(storage, { recursive: true, force: true });
    },
  };
}
