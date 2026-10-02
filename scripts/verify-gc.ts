/**
 * Check storage collection's candidates against everything that can refer to a chunk, read independently of the
 * collector (src/gc-verify.ts): before AGENT_GC_DRY_RUN is turned off, no due candidate may be referred to. Read-only.
 * Run it with the runtime's database and storage settings (AGENT_DATABASE_URL or AGENT_DATABASE_HOST/…_SECRET_ARN,
 * AGENT_STORAGE, AGENT_S3_BUCKET, AGENT_S3_PREFIX, AWS_REGION, AGENT_DATA_DIR):
 *
 *   node --experimental-strip-types scripts/verify-gc.ts [--tenant <id>] [--sample <n>] [--logged <tenant:hash,hash;tenant:hash>]
 *
 * `--logged` (or GC_VERIFY_LOGGED) passes the hashes storage_gc_dry_run lines said would be removed. It prints one line
 * per tenant (gc_verify_tenant) and a total (gc_verify_total), and exits 1 if a due candidate is held by an unpinned
 * FileRef, a logged hash is referred to, or anything could not be read. AGENT_GC_GRACE_MS as the runtime's.
 */
import { resolve } from "node:path";
import { databaseFromEnvironment } from "../src/db.ts";
import { postgresTail } from "../src/log-tail.ts";
import { verifyGcCandidates } from "../src/gc-verify.ts";
import { safeError } from "../src/metrics.ts";
import { openStorage, storageFromEnvironment } from "../shared/storage-config.ts";

const option = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const loggedText = option("--logged") ?? process.env.GC_VERIFY_LOGGED ?? "";
const logged = new Map(loggedText.split(";").filter(Boolean).map(part => {
  const [tenant, hashes = ""] = part.split(":");
  return [tenant, hashes.split(",").filter(hash => /^[a-f0-9]{64}$/.test(hash))] as [string, string[]];
}));
const db = await databaseFromEnvironment();
let failed = false;
try {
  const storage = await openStorage(storageFromEnvironment(resolve(process.env.AGENT_DATA_DIR ?? ".agent-runtime")), postgresTail(db));
  const results = await verifyGcCandidates({
    db, storage, tenant: option("--tenant"), sample: Number(option("--sample") ?? 5), logged,
    graceMs: Number(process.env.AGENT_GC_GRACE_MS ?? 24 * 60 * 60_000),
    onError: (what, error) => console.error(JSON.stringify({ type: "gc_verify_unreadable", what, error: safeError(error) })),
  });
  const total = { tenants: results.length, candidates: 0, due: 0, unpinnedAgentRefs: 0, loggedChecked: [...logged.values()].reduce((sum, hashes) => sum + hashes.length, 0), loggedReferenced: 0, dueInVolumes: 0, referencedAgain: 0, unreadable: 0 };
  for (const row of results) {
    console.log(JSON.stringify({ type: "gc_verify_tenant", ...row }));
    total.candidates += row.candidates; total.due += row.due; total.referencedAgain += row.referencedAgain; total.unreadable += row.unreadable;
    total.unpinnedAgentRefs += row.unpinnedAgentRefs.length; total.loggedReferenced += row.loggedReferenced.length; total.dueInVolumes += row.dueInVolumes;
  }
  failed = total.unpinnedAgentRefs > 0 || total.loggedReferenced > 0 || total.unreadable > 0;
  console.log(JSON.stringify({ type: "gc_verify_total", safe: !failed, ...total }));
} finally {
  await db.end();
}
if (failed) process.exitCode = 1;
