/**
 * Whether every chunk something live refers to is still stored (src/storage-integrity.ts): every FileRef each live
 * agent holds, and every file in each live volume and its snapshots. Read-only; ids and hashes only, never contents.
 * Run it with the runtime's database and storage settings (AGENT_DATABASE_URL or AGENT_DATABASE_HOST/…_SECRET_ARN,
 * AGENT_STORAGE, AGENT_S3_BUCKET, AGENT_S3_PREFIX, AWS_REGION, AGENT_DATA_DIR):
 *
 *   node --experimental-strip-types scripts/check-storage.ts [--tenant <id>] [--sample <n>]
 *
 * It prints one line per tenant (storage_check_tenant) with up to --sample (20) missing hashes in all, each with an
 * agent or volume that refers to it, and a total (storage_check_total). It exits 1 if a chunk is missing or anything
 * could not be read.
 */
import { resolve } from "node:path";
import { databaseFromEnvironment } from "../src/db.ts";
import { postgresTail } from "../src/log-tail.ts";
import { checkStorageIntegrity } from "../src/storage-integrity.ts";
import { safeError } from "../src/metrics.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";

const option = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const db = await databaseFromEnvironment();
let failed = false;
try {
  const storage = await openStorage(storageFromEnvironment(resolve(process.env.AGENT_DATA_DIR ?? ".agent-runtime")), postgresTail(db));
  const results = await checkStorageIntegrity({
    db, storage, tenant: option("--tenant"), sample: Number(option("--sample") ?? 20),
    onError: (what, error) => console.error(JSON.stringify({ type: "storage_check_unreadable", what, error: safeError(error) })),
  });
  const total = { tenants: results.length, agents: 0, volumes: 0, snapshots: 0, referenced: 0, stored: 0, missing: 0, unreadable: 0 };
  for (const row of results) {
    console.log(JSON.stringify({ type: "storage_check_tenant", ...row }));
    for (const key of ["agents", "volumes", "snapshots", "referenced", "stored", "missing", "unreadable"] as const) total[key] += row[key];
  }
  failed = total.missing > 0 || total.unreadable > 0;
  console.log(JSON.stringify({ type: "storage_check_total", intact: !failed, ...total }));
} finally {
  await db.end();
}
if (failed) process.exitCode = 1;
