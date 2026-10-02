/**
 * Pin the chunks of every FileRef each live agent holds (src/pin-backfill.ts), so storage collection
 * (AGENT_GC_ENABLED) never takes bytes an agent from before pins existed still refers to. Run it once,
 * before enabling collection, with the runtime's database and storage settings (AGENT_DATABASE_URL or
 * AGENT_DATABASE_HOST/…_SECRET_ARN, AGENT_STORAGE, AGENT_S3_BUCKET, AGENT_S3_PREFIX, AWS_REGION, AGENT_DATA_DIR):
 *
 *   node --experimental-strip-types scripts/backfill-pins.ts [--dry-run] [--tenant <id>]
 *
 * It prints one line per tenant ({tenant, agents, refs, chunks, missing, inserted, unreadable}) and a
 * total; --dry-run counts the pins that are missing and inserts none. Running it again inserts nothing
 * new. Anything it could not read is reported as `backfill_pins_unreadable` and counted in `unreadable`.
 */
import { resolve } from "node:path";
import { databaseFromEnvironment } from "../src/db.ts";
import { postgresTail } from "../src/log-tail.ts";
import { backfillPins } from "../src/pin-backfill.ts";
import { safeError } from "../src/metrics.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";

const dryRun = process.argv.includes("--dry-run");
const tenantAt = process.argv.indexOf("--tenant");
const tenant = tenantAt > 0 ? process.argv[tenantAt + 1] : undefined;
const db = await databaseFromEnvironment();
try {
  if (!(await db.query("select to_regclass('chunk_pins') as found")).rows[0].found) throw new Error("This database has no chunk_pins table (migration 026): run the runtime once to migrate it first");
  const storage = await openStorage(storageFromEnvironment(resolve(process.env.AGENT_DATA_DIR ?? ".agent-runtime")), postgresTail(db));
  const tenants = await backfillPins({
    db, storage, dryRun, tenant,
    onError: (agent, what, error) => console.error(JSON.stringify({ type: "backfill_pins_unreadable", agent, what, error: safeError(error) })),
  });
  const total = { agents: 0, refs: 0, chunks: 0, missing: 0, inserted: 0, unreadable: 0 };
  for (const row of tenants) {
    console.log(JSON.stringify({ type: "backfill_pins_tenant", dryRun, ...row }));
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += row[key];
  }
  console.log(JSON.stringify({ type: "backfill_pins_total", dryRun, tenants: tenants.length, ...total }));
} finally {
  await db.end();
}
