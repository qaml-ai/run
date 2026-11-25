#!/usr/bin/env node
/**
 * Zero-downtime AWS DynamoDB -> Cloudflare CamelfsLineageDO migration & parity verifier.
 *
 * Usage:
 *   # Bulk import all lineages & refs from DynamoDB into CamelfsLineageDO:
 *   node scripts/migrate-aws-camelfs.mjs import \
 *     --table camelfs-v2-prod-repos \
 *     --region us-west-2 \
 *     --worker-url https://run.camelai.com/v2 \
 *     --admin-key "$ADMIN_SECRET" \
 *     [--since-ms 1795500000000] \
 *     [--concurrency 12]
 *
 *   # Verify N random non-empty lineages match AWS DynamoDB + S3 byte-for-byte:
 *   node scripts/migrate-aws-camelfs.mjs verify \
 *     --table camelfs-v2-prod-repos \
 *     --bucket camelfs-v2-prod-904534089871-us-west-2 \
 *     --region us-west-2 \
 *     --worker-url https://run.camelai.com/v2 \
 *     --admin-key "$ADMIN_SECRET" \
 *     [--sample 25]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

function parseArgs(argv) {
  const cmd = argv[2];
  const opts = {};
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      opts[k] = v;
    }
  }
  return { cmd, opts };
}

function awsJson(args) {
  const out = execFileSync("aws", args, { maxBuffer: 128 * 1024 * 1024, encoding: "utf8" });
  return JSON.parse(out);
}

function ddbStr(item, k) {
  return item[k]?.S ?? "";
}

function ddbNum(item, k) {
  return item[k]?.N ? Number(item[k].N) : 0;
}

function scanAllLineages(table, region, sinceMs = 0) {
  const lineages = new Map();
  let lastKey = null;
  let pages = 0;
  let totalItems = 0;

  for (;;) {
    const args = [
      "dynamodb",
      "scan",
      "--region",
      region,
      "--table-name",
      table,
      "--output",
      "json",
    ];
    if (lastKey) {
      args.push("--exclusive-start-key", JSON.stringify(lastKey));
    }
    const page = awsJson(args);
    pages++;
    const items = page.Items ?? [];
    totalItems += items.length;

    for (const item of items) {
      const pk = ddbStr(item, "PK");
      const sk = ddbStr(item, "SK");
      if (!pk.startsWith("LIN#")) continue;
      const lin = pk.slice(4);
      let rec = lineages.get(lin);
      if (!rec) {
        rec = {
          lineage: lin,
          tenantId: "default",
          defaultRef: "refs/heads/main",
          createdAt: 0,
          refs: [],
        };
        lineages.set(lin, rec);
      }
      if (sk === "META") {
        rec.tenantId = ddbStr(item, "tenantId") || rec.tenantId;
        rec.defaultRef = ddbStr(item, "defaultRef") || rec.defaultRef;
        rec.createdAt = ddbNum(item, "createdAt") || rec.createdAt;
      } else if (sk.startsWith("REF#")) {
        const updatedAt = ddbNum(item, "updatedAt");
        rec.refs.push({
          name: ddbStr(item, "name") || sk.slice(4),
          commit: ddbStr(item, "commit"),
          tree: ddbStr(item, "tree"),
          updatedAt,
        });
      }
    }

    if (pages % 5 === 0 || !page.LastEvaluatedKey) {
      console.log(`  scanned ${pages} DynamoDB pages (${totalItems} items, ${lineages.size} lineages)...`);
    }
    if (!page.LastEvaluatedKey) break;
    lastKey = page.LastEvaluatedKey;
  }

  let list = [...lineages.values()].filter((l) => l.refs.length > 0);
  if (sinceMs > 0) {
    list = list.filter(
      (l) => l.createdAt >= sinceMs || l.refs.some((r) => r.updatedAt >= sinceMs),
    );
  }
  return list;
}

async function importBatch(workerUrl, adminKey, batch) {
  const base = workerUrl.replace(/\/+$/, "");
  const url = base.endsWith("/v2")
    ? `${base}/internal/camelfs/import-lineages`
    : `${base}/v2/internal/camelfs/import-lineages`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "X-Admin-Key": adminKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ lineages: batch }),
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) {
        return await res.json();
      }
      const txt = await res.text();
      if (res.status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
    } catch (err) {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

function fetchAndUnpackS3Object(bucket, region, hash) {
  const key = `objects/${hash.slice(0, 2)}/${hash}`;
  const raw = execFileSync(
    "aws",
    ["s3", "cp", "--region", region, `s3://${bucket}/${key}`, "-"],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const inflated = inflateSync(raw);
  const sep = inflated.indexOf(0);
  return {
    kind: inflated.subarray(0, sep).toString("utf8"),
    data: inflated.subarray(sep + 1),
  };
}

const { cmd, opts } = parseArgs(process.argv);
if (!cmd || !opts.table || !opts["worker-url"] || !opts["admin-key"]) {
  console.error("Usage: migrate-aws-camelfs.mjs <import|verify> --table <ddb> --worker-url <url> --admin-key <key>");
  process.exit(1);
}

const region = opts.region || "us-west-2";
const workerUrl = opts["worker-url"];
const adminKey = opts["admin-key"];

if (cmd === "import") {
  const sinceMs = Number(opts["since-ms"] || 0);
  const concurrency = Math.max(1, Number(opts.concurrency || 12));
  const batchSize = Math.min(50, Math.max(1, Number(opts["batch-size"] || 40)));
  const t0 = Date.now();
  console.log(`==> Scanning DynamoDB ${opts.table} (${region})${sinceMs ? ` sinceMs=${sinceMs}` : ""}...`);
  const lineages = scanAllLineages(opts.table, region, sinceMs);
  console.log(`==> Found ${lineages.length} lineages to import (batchSize=${batchSize}, concurrency=${concurrency})`);

  const batches = [];
  for (let i = 0; i < lineages.length; i += batchSize) {
    batches.push(lineages.slice(i, i + batchSize));
  }

  let idx = 0;
  let doneLineages = 0;
  let totalImportedRefs = 0;
  let totalSkippedRefs = 0;

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= batches.length) return;
      const b = batches[i];
      const out = await importBatch(workerUrl, adminKey, b);
      doneLineages += out.count;
      totalImportedRefs += out.importedRefs;
      totalSkippedRefs += out.skippedNewerRefs;
      if (doneLineages % 2000 < batchSize || doneLineages === lineages.length) {
        const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(
          `  [${elapsedS}s] imported ${doneLineages}/${lineages.length} lineages (refs imported=${totalImportedRefs}, skipped=${totalSkippedRefs})`,
        );
      }
    }
  });
  await Promise.all(workers);
  console.log(
    JSON.stringify({
      ok: true,
      lineages: doneLineages,
      importedRefs: totalImportedRefs,
      skippedNewerRefs: totalSkippedRefs,
      elapsedMs: Date.now() - t0,
    }),
  );
} else if (cmd === "verify") {
  const bucket = opts.bucket;
  if (!bucket) throw new Error("--bucket is required for verify");
  const sampleN = Number(opts.sample || 20);
  const EMPTY_TREE = "df066604fd95cc024cc4ab700db69a31617e3e6f47300248c4618e8cce080929";

  console.log(`==> Scanning ${opts.table} for non-empty lineages to verify (sample=${sampleN})...`);
  const all = scanAllLineages(opts.table, region, 0);
  const nonEmpty = all.filter((l) => l.refs.some((r) => r.tree && r.tree !== EMPTY_TREE));
  console.log(`==> Total lineages=${all.length}, non-empty=${nonEmpty.length}`);

  // Deterministic spread across the entire dataset
  const picks = [];
  const step = Math.max(1, Math.floor(nonEmpty.length / Math.max(1, sampleN)));
  for (let i = 0; i < nonEmpty.length && picks.length < sampleN; i += step) {
    picks.push(nonEmpty[i]);
  }

  const base = workerUrl.replace(/\/+$/, "");
  let passed = 0;
  let failed = 0;

  for (const lin of picks) {
    const ref = lin.refs.find((r) => r.tree && r.tree !== EMPTY_TREE) || lin.refs[0];
    try {
      const s3Tree = JSON.parse(fetchAndUnpackS3Object(bucket, region, ref.tree).data.toString("utf8"));
      const firstFile = s3Tree.find((e) => e.type === "file" && e.hash);
      const qs = new URLSearchParams({ at: ref.name });
      if (firstFile) qs.set("path", firstFile.path);
      const url = base.endsWith("/v2")
        ? `${base}/internal/camelfs/lineages/${encodeURIComponent(lin.lineage)}/verify?${qs}`
        : `${base}/v2/internal/camelfs/lineages/${encodeURIComponent(lin.lineage)}/verify?${qs}`;
      const res = await fetch(url, {
        headers: { "X-Admin-Key": adminKey },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`CF verify HTTP ${res.status}: ${await res.text()}`);
      const cf = await res.json();
      const cfRef = cf.refs.find((r) => r.name === ref.name);
      if (!cfRef) throw new Error(`missing ref ${ref.name} in CF`);
      if (cfRef.commit !== ref.commit && cfRef.updatedAt < ref.updatedAt) {
        throw new Error(`commit mismatch: cf=${cfRef.commit} aws=${ref.commit}`);
      }
      if (firstFile && cfRef.commit === ref.commit) {
        const s3Blob = fetchAndUnpackS3Object(bucket, region, firstFile.hash).data;
        const cfData = cf.file.binary
          ? Buffer.from(cf.file.base64 || "", "base64")
          : Buffer.from(cf.file.content || "", "utf8");
        const s3Sha = createHash("sha256").update(s3Blob).digest("hex");
        const cfSha = createHash("sha256").update(cfData).digest("hex");
        if (s3Sha !== cfSha) {
          throw new Error(`blob sha mismatch for ${firstFile.path}: cf=${cfSha} aws=${s3Sha}`);
        }
      }
      passed++;
    } catch (err) {
      failed++;
      console.error(`  FAIL ${lin.lineage}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(JSON.stringify({ verified: passed, failed, sampled: picks.length }));
  if (failed > 0) process.exit(1);
} else {
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}
