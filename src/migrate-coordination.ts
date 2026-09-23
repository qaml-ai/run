import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type pg from "pg";
import { openStorage, storageFromEnvironment, type StorageDescriptor } from "../shared/storage-config.ts";
import type { Storage } from "../shared/storage.ts";
import { databaseFromEnvironment, migrate, transaction, type Db } from "./db.ts";

/**
 * One-time move of coordination state from the Storage documents the runtime used
 * before Postgres (`<key>.json` files, or S3 objects) into Postgres. Logs and blobs
 * stay where they are. Every insert skips rows that exist, so re-running is safe;
 * run it before starting the new runtime, which then owns the rows.
 *
 *   AGENT_DATABASE_URL=... AGENT_STORAGE=s3 AGENT_S3_BUCKET=... AGENT_S3_PREFIX=... \
 *     node --experimental-strip-types src/migrate-coordination.ts
 */
const PREFIXES = ["tenants/", "client-sessions/", "schedules/", "channels/", "channel-conversations/", "channel-agents/", "channel-items/", "channel-seen/", "channel-counts/", "volumes/"];
type Documents = Map<string, any>;
type Totals = { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

/** Every legacy document under the prefixes above. */
export async function readLegacyDocuments(descriptor: StorageDescriptor): Promise<Documents> {
  const documents: Documents = new Map();
  if (descriptor.kind === "file") {
    const walk = async (directory: string) => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".json")) documents.set(relative(descriptor.root, path).split(sep).join("/").slice(0, -".json".length), JSON.parse(await readFile(path, "utf8")));
      }
    };
    for (const prefix of PREFIXES) await walk(join(descriptor.root, prefix));
    return documents;
  }
  const { GetObjectCommand, ListObjectsV2Command, S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: descriptor.region });
  const base = (descriptor.prefix ?? "").replace(/^\/+|\/+$/g, "");
  for (const prefix of PREFIXES) {
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: descriptor.bucket, Prefix: base ? `${base}/${prefix}` : prefix, ContinuationToken: token }));
      for (const { Key } of page.Contents ?? []) {
        if (!Key?.endsWith(".json")) continue;
        const body = await (await client.send(new GetObjectCommand({ Bucket: descriptor.bucket, Key }))).Body!.transformToString("utf8");
        documents.set(Key.slice(base ? base.length + 1 : 0, -".json".length), JSON.parse(body));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  return documents;
}

export async function migrateCoordination(documents: Documents, db: Db, storage: Storage) {
  const counts: Record<string, number> = {};
  const matching = (pattern: RegExp) => [...documents].flatMap(([key, value]) => { const match = pattern.exec(key); return match ? [{ match, value }] : []; });
  // Rewritten first: a converted journal or snapshot file map must exist before a row points at it.
  const staged: (() => Promise<void>)[] = [];
  const rows: { table: string; sql: string; values: unknown[] }[] = [];
  const insert = (table: string, columns: string[], values: unknown[], conflict: string) => rows.push({
    table, values,
    sql: `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, index) => `$${index + 1}`).join(", ")}) on conflict (${conflict}) do nothing`,
  });
  const json = (value: unknown) => JSON.stringify(value);

  for (const { match, value } of matching(/^tenants\/([a-z0-9-]+)\/tenant$/)) insert("tenants", ["id", "github", "created_at"], [match[1], value.github ?? null, value.createdAt ?? Date.now()], "id");
  for (const { match, value } of matching(/^tenants\/([a-z0-9-]+)\/keys$/)) {
    for (const [provider, key] of Object.entries(value as Record<string, any>)) {
      insert("provider_keys", ["tenant", "provider", "sealed", "last4", "set_at"], [match[1], provider, json({ iv: key.iv, tag: key.tag, ciphertext: key.ciphertext }), key.last4, key.setAt], "tenant, provider");
    }
  }
  for (const { match, value } of matching(/^tenants\/([a-z0-9-]+)\/tokens$/)) {
    for (const token of value) insert("api_tokens", ["sha256", "id", "tenant", "name", "prefix", "created_at"], [token.sha256, token.id, match[1], token.name, token.prefix, token.createdAt], "sha256");
  }
  // Usage: per-node daily documents, and the single-host log that preceded them, summed per tenant, day and model.
  const usage = new Map<string, Totals>();
  const count = (tenant: string, day: string, model: string, value: Totals) => {
    const key = json([tenant, day, model]);
    const totals = usage.get(key) ?? { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const field of Object.keys(totals) as (keyof Totals)[]) totals[field] += value[field] ?? 0;
    usage.set(key, totals);
  };
  for (const { match, value } of matching(/^tenants\/([a-z0-9-]+)\/usage\/(\d{4}-\d{2}-\d{2})\/[^/]+$/)) {
    for (const [model, totals] of Object.entries(value.models ?? {})) count(match[1], match[2], model, totals as Totals);
  }
  const tenants = new Set([...documents.keys()].flatMap(key => /^tenants\/([a-z0-9-]+)\//.exec(key)?.[1] ?? []));
  for (const tenant of tenants) {
    if (!await storage.hasLog(`tenants/${tenant}/usage`)) continue;
    for (const record of await storage.log<any>(`tenants/${tenant}/usage`).read()) {
      count(tenant, new Date(record.at).toISOString().slice(0, 10), `${record.provider}/${record.model}`, { ...record, responses: 1 });
    }
  }
  for (const [key, totals] of usage) {
    const [tenant, day, model] = JSON.parse(key);
    insert("usage", ["tenant", "day", "model", "responses", "input", "output", "cache_read", "cache_write", "cost"],
      [tenant, day, model, totals.responses, totals.input, totals.output, totals.cacheRead, totals.cacheWrite, totals.cost], "tenant, day, model");
  }

  for (const { match, value } of matching(/^client-sessions\/(client_[a-f0-9]{40})$/)) {
    let header = value;
    if (header.version === 2) {
      // Version 2 kept requests and calls in the header; they belong in the journal.
      const { requests = {}, calls = {}, events: _events, cursor: _cursor, ...rest } = header;
      header = { ...rest, version: 3 };
      const records = [...Object.values(requests).map(record => ({ t: "request", record })), ...Object.values(calls).map(record => ({ t: "call", record }))];
      staged.push(async () => { if (!await storage.hasLog(`client-sessions/${match[1]}.journal`)) await storage.log(`client-sessions/${match[1]}.journal`).rewrite(() => records); });
    }
    insert("agents", ["id", "tenant", "header", "revision", "name", "type", "model", "expires_at", "revoked"], [
      match[1], header.tenant ?? "default", json(header), 1, header.metadata?.name ?? match[1], header.metadata?.type ?? "general",
      `${header.config.model.provider}/${header.config.model.id}`, header.expiresAt ?? null, !!header.revoked,
    ], "id");
  }

  for (const { value } of matching(/^schedules\/[^/]+\/[0-9a-f-]{36}$/)) {
    insert("schedules", ["id", "agent", "tenant", "text", "code", "due_at", "every_seconds", "created_at"],
      [value.id, value.agent, value.tenant, value.text ?? null, value.code ?? null, Math.round(value.dueAt), value.everySeconds ?? null, value.createdAt], "id");
  }

  for (const { value } of matching(/^channels\/(ch_[a-f0-9]{20})$/)) insert("channels", ["id", "tenant", "channel", "created_at"], [value.id, value.tenant, json(value), value.createdAt], "id");
  for (const { match, value } of matching(/^channel-conversations\/([^/]+)\/([^/]+)$/)) {
    insert("channel_conversations", ["channel", "conversation", "agent", "generation"], [match[1], match[2], value.agent, value.generation], "channel, conversation");
  }
  for (const { match, value } of matching(/^channel-agents\/([^/]+)$/)) {
    insert("channel_agents", ["agent", "channel", "tenant", "conversation"], [match[1], value.channel, value.tenant, value.conversationId], "agent");
  }
  for (const { value } of matching(/^channel-items\/[^/]+$/)) {
    // Claims are dropped: any node picks the item up once it is due.
    const { claim: _claim, due, ...item } = value;
    insert("channel_items", ["id", "item", "due"], [item.id, json(item), due], "id");
  }
  for (const { match } of matching(/^channel-seen\/([^/]+)\/([a-f0-9]{40})$/)) insert("channel_seen", ["channel", "message"], [match[1], match[2]], "channel, message");
  for (const { match, value } of matching(/^channel-counts\/([^/]+)\/(.+)$/)) insert("channel_counts", ["channel", "window_key", "count"], [match[1], match[2], value.count], "channel, window_key");

  for (const { match, value } of matching(/^volumes\/(vol_[a-f0-9]{24})$/)) {
    insert("volumes", ["id", "tenant", "name", "created_at", "origin", "deleted_at"], [match[1], value.tenant, value.name, value.createdAt, value.origin ? json(value.origin) : null, value.deleted ?? null], "id");
  }
  for (const { match, value } of matching(/^volumes\/(vol_[a-f0-9]{24})\/snapshots\/(snap_[a-f0-9]{16})$/)) {
    const files = documents.get(`volumes/${match[1]}/snapshot-files/${match[2]}`);
    if (!files) continue;
    staged.push(() => storage.writeBlob(`volumes/${match[1]}/snapshots/${match[2]}`, Buffer.from(json(files))));
    insert("volume_snapshots", ["id", "volume", "name", "seq", "created_at", "files", "bytes"], [value.id, match[1], value.name, value.seq, value.createdAt, value.files, value.bytes], "id");
  }
  for (const { match, value } of matching(/^volumes\/(vol_[a-f0-9]{24})\/watchers\/([^/]+)$/)) {
    insert("volume_watchers", ["volume", "agent", "tenant", "mounts"], [match[1], match[2], value.tenant, json(value.mounts)], "volume, agent");
  }

  for (const stage of staged) await stage();
  await transaction(db, async (sql: pg.PoolClient) => {
    for (const row of rows) counts[row.table] = (counts[row.table] ?? 0) + ((await sql.query(row.sql, row.values)).rowCount ?? 0);
  });
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const descriptor = storageFromEnvironment(resolve(process.env.AGENT_DATA_DIR ?? ".agent-runtime"));
  const db = databaseFromEnvironment();
  try {
    await migrate(db);
    const documents = await readLegacyDocuments(descriptor);
    const inserted = await migrateCoordination(documents, db, await openStorage(descriptor));
    console.log(JSON.stringify({ type: "coordination_migrated", from: descriptor.kind, documents: documents.size, inserted }));
  } finally { await db.end(); }
}
