#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { PILOT_HYPERDRIVE, withTemporaryWorker } from "./pilot-operator.mjs";

const worker = fileURLToPath(new URL("./pilot-l90-worker.ts", import.meta.url));

function errorCategory(error) {
  const match = error instanceof Error && /; category=(L90 request failed|Refused key|Not found|Bootstrap expired|Unauthorized|unclassified);/.exec(error.message);
  return match ? match[1] : "L90 request failed";
}

export async function sweep(request, drop) {
  const r2 = { keys: 0, bytes: 0, perTenant: Object.create(null) };
  const tables = {
    storage_objects: { tenants: 0, rows: 0 },
    storage_total: { tenants: 0, rows: 0 },
    storage_listing: { tenants: 0, rows: 0 },
  };
  let pendingAlarms = 0;
  const errors = [];
  const record = (tenant, error) => errors.push({ tenant, category: errorCategory(error) });

  let cursor;
  let useCursor = !drop;
  do {
    let page;
    try {
      page = await request(cursor ? `/l90/r2?${new URLSearchParams({ cursor })}` : "/l90/r2");
    } catch (error) {
      record(null, error);
      break;
    }
    r2.keys += page.keys.length;
    r2.bytes += page.bytes;
    for (const [tenant, counts] of Object.entries(page.perTenant)) {
      const totals = r2.perTenant[tenant] ??= { keys: 0, bytes: 0 };
      totals.keys += counts.keys;
      totals.bytes += counts.bytes;
    }
    if (drop && page.keys.length) {
      try {
        await request("/l90/r2/delete", { body: { keys: page.keys } });
      } catch (error) {
        const tenants = Object.keys(page.perTenant);
        for (const tenant of tenants.length ? tenants : [null]) record(tenant, error);
        // Move past the failed page so a refused key cannot block the rest of the sweep.
        useCursor = true;
      }
    }
    if (!page.cursor) break;
    // After deleting a page, start again at the prefix while there are no failed pages to skip.
    cursor = useCursor || !page.keys.length ? page.cursor : undefined;
  } while (true);

  let after = "";
  while (true) {
    let tenants;
    try {
      ({ tenants } = await request(`/l90/tenants?${new URLSearchParams({ after })}`));
    } catch (error) {
      record(null, error);
      break;
    }
    for (const tenant of tenants) {
      try {
        const result = await request("/l90/tables", { body: { tenant, drop } });
        for (const { name, rows } of result.tables) {
          tables[name].tenants++;
          tables[name].rows += rows;
        }
        if (result.alarm !== null) pendingAlarms++;
      } catch (error) {
        record(tenant, error);
      }
    }
    if (tenants.length < 200) break;
    after = tenants.at(-1);
  }
  return { r2, tables, pendingAlarms, failures: errors.length, errors };
}

async function run(confirm) {
  return withTemporaryWorker({
    prefix: "camelrun-pilot-l90",
    label: "Pilot L90 sweep",
    entry: (tokenHash, expiresAt) => `import createSweep from ${JSON.stringify(worker)};\nexport default createSweep(${JSON.stringify({ tokenHash, expiresAt })});\n`,
    bindings: {
      hyperdrive: [{ binding: "HYPERDRIVE", id: PILOT_HYPERDRIVE }],
      r2_buckets: [{ binding: "BUCKET", bucket_name: "camelrun-pilot-files" }],
      durable_objects: { bindings: [{ name: "TENANTS", class_name: "TenantAdmission", script_name: "camelrun-pilot" }] },
    },
    warm: ["/healthz", "/l90/tenants"],
  }, async ({ request }) => {
    let failures = 0;
    if (confirm) {
      const totals = await sweep(request, true);
      console.log(JSON.stringify({ mode: "confirm", ...totals }));
      failures += totals.failures;
    }
    const totals = await sweep(request, false);
    console.log(JSON.stringify({ mode: "dry-run", ...totals }));
    const remaining = confirm && (totals.r2.keys || Object.values(totals.tables).some(table => table.tenants));
    return failures || totals.failures || remaining ? 1 : 0;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "--confirm" && arg !== "--dry-run")) {
    console.error("usage: pilot-l90-sweep.mjs [--dry-run | --confirm]");
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await run(args[0] === "--confirm");
    } catch (error) {
      console.error(JSON.stringify({ failures: 1, errors: [{ tenant: null, category: errorCategory(error) }] }));
      process.exitCode = 1;
    }
  }
}
