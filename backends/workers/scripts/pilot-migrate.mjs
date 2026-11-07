#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { readMigrations } from "./migrate.mjs";
import { PILOT_HYPERDRIVE, withTemporaryWorker } from "./pilot-operator.mjs";

const worker = fileURLToPath(new URL("./pilot-migrate-worker.mjs", import.meta.url));

/** Bring the pilot Postgres up to this checkout's migrations, through Hyperdrive.
 * A short-lived Worker whose only binding is the pilot Hyperdrive runs
 * scripts/migrate.mjs (the same schema_migrations bookkeeping as every other
 * runner) over the repository's SQL files, bundled into it. Its bearer lives
 * only in this process (the Worker holds its hash), expires in one hour, and
 * the Worker is deleted in finally. No database password is handled anywhere.
 * Refuses when the database has applied migrations this checkout lacks. */
export async function migratePilot({ dryRun = false, log = console.log } = {}) {
  const migrations = await readMigrations();
  return withTemporaryWorker({
    prefix: "camelrun-pilot-migrate",
    label: "Pilot migration",
    entry: (tokenHash, expiresAt) => `import createMigrator from ${JSON.stringify(worker)};\nexport default createMigrator(${JSON.stringify({ tokenHash, expiresAt, migrations })});\n`,
    bindings: { hyperdrive: [{ binding: "HYPERDRIVE", id: PILOT_HYPERDRIVE }] },
    // The status read warms routing and Hyperdrive before any write.
    warm: ["/healthz", "/pilot/migrations"],
  }, async ({ request, workerName }) => {
    const status = await request("/pilot/migrations");
    if (status.unknown.length)
      throw new Error(`Refusing to migrate or deploy: the pilot database has applied migrations this checkout does not have (${status.unknown.join(", ")}). It is ahead of this commit, or a migration file was renamed after it ran. Deploy from an up-to-date main.`);
    const latest = status.applied.at(-1);
    log(`Pilot database: ${status.applied.length} migrations applied (latest ${latest ?? "none"}), ${status.pending.length} pending${status.pending.length ? ":" : "."}`);
    for (const name of status.pending) log(`  ${name}${latest && name < latest ? "  (numbered before an applied migration)" : ""}`);
    let applied = [];
    if (status.pending.length && !dryRun) {
      ({ applied } = await request("/pilot/migrations", { method: "POST", signal: AbortSignal.timeout(900_000) }));
      log(`Applied ${applied.length} migration${applied.length === 1 ? "" : "s"}${applied.length ? `: ${applied.join(", ")}` : " (another runner applied them first)"}.`);
    }
    return { pending: status.pending, applied, workerName };
  }).then(result => {
    log(`Temporary migration Worker ${result.workerName} deleted.`);
    return result;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter(arg => arg !== "--dry-run");
  if (unknown.length) { console.error("usage: pilot-migrate.mjs [--dry-run]"); process.exit(2); }
  await migratePilot({ dryRun: args.includes("--dry-run") });
}
