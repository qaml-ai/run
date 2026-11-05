import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "./migrate.mjs";
const here = dirname(fileURLToPath(import.meta.url));
const name = "camelrun-proto-workers-pg";
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
if (process.argv.includes("--stop")) {
  docker("rm", "-f", name);
  console.log("Removed isolated prototype Postgres");
  process.exit(0);
}
try {
  docker("inspect", name);
} catch {
  docker(
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_DB=camelrun_proto",
    "-p",
    "127.0.0.1:55434:5432",
    "postgres:16-alpine",
  );
}
let db;
for (let i = 0; ; i++) {
  db = new pg.Client({
    host: "127.0.0.1",
    port: 55434,
    user: "postgres",
    password: "local-only-unused",
    database: "camelrun_proto",
  });
  try {
    await db.connect();
    break;
  } catch (error) {
    await db.end().catch(() => {});
    if (i >= 30) throw error;
    await new Promise((r) => setTimeout(r, 250));
  }
}
try {
  const { migrations, newlyApplied } = await migrate(db);
  const tenant = "camelrun-proto-local";
  await db.query(
    "insert into tenants(id,created_at,billing) values($1,$2,'prepaid') on conflict do nothing",
    [tenant, Date.now()],
  );
  await db.query(
    "with input as (insert into credit_ledger(tenant,kind,amount,idempotency_key,created_at) values($1,'purchase',100000000,'workers:local:seed',$2) on conflict do nothing returning tenant,amount) insert into credit_accounts(tenant,balance,purchased) select tenant,amount,amount from input on conflict(tenant) do update set balance=credit_accounts.balance+excluded.balance,purchased=credit_accounts.purchased+excluded.purchased",
    [tenant, Date.now()],
  );
  console.log(
    JSON.stringify({
      container: name,
      port: 55434,
      migrations,
      newlyApplied,
      localOnly: true,
    }),
  );
} finally {
  await db.end();
}
