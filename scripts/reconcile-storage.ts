/**
 * Correct the tracked storage totals (`storage_usage`, see src/storage-usage.ts) with a
 * full listing of Storage, as the daily storage job does every
 * AGENT_STORAGE_RECONCILE_DAYS. Run it with the runtime's database and storage settings
 * (AGENT_DATABASE_URL, AGENT_STORAGE, AGENT_S3_BUCKET, AGENT_S3_PREFIX, AWS_REGION, AGENT_DATA_DIR):
 *
 *   node --experimental-strip-types scripts/reconcile-storage.ts [--dry-run]
 *
 * It prints each tenant whose tracked bytes the listing changes; with --dry-run it
 * changes nothing.
 */
import { resolve } from "node:path";
import { databaseFromEnvironment, migrate } from "../src/db.ts";
import { postgresTail } from "../src/log-tail.ts";
import { StorageUsage } from "../src/storage-usage.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";

const dryRun = process.argv.includes("--dry-run");
const db = await databaseFromEnvironment();
try {
  await migrate(db);
  const storage = await openStorage(storageFromEnvironment(resolve(process.env.AGENT_DATA_DIR ?? ".agent-runtime")), postgresTail(db));
  const { owners, bytes, before, after } = await new StorageUsage(db).reconcile(storage, { dryRun });
  for (const tenant of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const [tracked, listed] = [before.get(tenant) ?? 0, after.get(tenant) ?? 0];
    if (tracked !== listed) console.log(JSON.stringify({ tenant, tracked, listed }));
  }
  console.log(JSON.stringify({ dryRun, owners, bytes, tenants: after.size }));
} finally {
  await db.end();
}
