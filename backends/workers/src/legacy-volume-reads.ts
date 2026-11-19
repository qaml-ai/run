import { S3Client } from "@aws-sdk/client-s3";
import { s3Storage } from "../../../shared/s3-storage.ts";
import type { LogTail, Storage, TailRow } from "../../../shared/storage.ts";
import { fileResponse } from "../../../src/files.ts";
import { HttpError } from "../../../src/http-error.ts";
import {
  Tree, VolumeFiles, labelsInput, listVolumeFiles, listVolumeSnapshots, normalizePath,
  snapshotTree, statVolumeFile, treeKey, validVolumeId, type TreeRecord,
} from "../../../src/volume-reads.ts";
import { database, type PostgresEnv, type Sql } from "./postgres.ts";

export interface LegacyVolumeReadEnv extends PostgresEnv {
  V1_VOLUME_S3_BUCKET?: string;
  V1_VOLUME_S3_REGION?: string;
  V1_VOLUME_S3_PREFIX?: string;
  V1_VOLUME_AWS_ACCESS_KEY_ID?: string;
  V1_VOLUME_AWS_SECRET_ACCESS_KEY?: string;
  V1_VOLUME_AWS_SESSION_TOKEN?: string;
}

export function legacyVolumeReadRoute(request: Request): boolean {
  return request.method === "GET" && /^\/v1\/volumes(?:\/[^/]+(?:\/snapshots|\/files(?:\/.+)?)?)?$/.test(new URL(request.url).pathname);
}

const readOnly = async (): Promise<never> => { throw new Error("Legacy volume storage is read-only"); };

function readTail(db: Sql): LogTail {
  return {
    async rows(key) { return (await db.query<TailRow>("select seq, snapshot, body, blob from log_records where log_key = $1 order by seq", [key])).rows; },
    async last(key) { return (await db.query<{ seq: number | null }>("select max(seq) as seq from log_records where log_key = $1", [key])).rows[0].seq ?? undefined; },
    append: readOnly,
    compact: readOnly,
    whileHeld: readOnly,
  };
}

export function handleLegacyVolumeRead(request: Request, env: LegacyVolumeReadEnv, tenant: string): Promise<Response> {
  const {
    V1_VOLUME_S3_BUCKET: bucket, V1_VOLUME_S3_REGION: region, V1_VOLUME_S3_PREFIX: prefix,
    V1_VOLUME_AWS_ACCESS_KEY_ID: accessKeyId, V1_VOLUME_AWS_SECRET_ACCESS_KEY: secretAccessKey,
    V1_VOLUME_AWS_SESSION_TOKEN: sessionToken,
  } = env;
  if (!bucket || !region || prefix === undefined || !accessKeyId || !secretAccessKey) throw new HttpError(503, "Legacy volume storage is unavailable");
  const db = database(env);
  const client = new S3Client({ region, credentials: { accessKeyId, secretAccessKey, sessionToken } });
  return serveLegacyVolumeRead(request, tenant, db, s3Storage({ bucket, prefix, client, tail: readTail(db) }));
}

type VolumeHeader = {
  id: string;
  name: string;
  createdAt: number;
  origin: { volume: string; snapshot?: string; seq: number } | null;
};

const json = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "no-store" } });

async function liveTree(storage: Storage, id: string) {
  const tree = new Tree();
  let seq = 0;
  for (const record of await storage.log<TreeRecord>(treeKey(id)).read()) {
    seq = Math.max(seq, record.seq);
    if (record.t === "put") tree.put(record.path, record.entry);
    else if (record.t === "del") tree.delete(record.path);
  }
  return { tree, seq };
}

export async function serveLegacyVolumeRead(request: Request, tenant: string, db: Sql, storage: Storage): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);
  const [, , , encodedId, section, ...fileParts] = pathname.split("/");
  const header = async (id: string) => {
    const row = validVolumeId(id) && (await db.query<VolumeHeader>(
      'select id, name, created_at as "createdAt", origin from volumes where id = $1 and tenant = $2 and deleted_at is null',
      [id, tenant],
    )).rows[0];
    if (!row) throw new HttpError(404, "Unknown volume");
    return row;
  };
  const info = async ({ id, name, createdAt, origin }: VolumeHeader) => {
    const { seq, tree } = await liveTree(storage, id);
    return { id, name, createdAt, ...(origin ? { origin } : {}), seq, files: tree.files.size, bytes: tree.bytes };
  };
  if (encodedId === undefined) {
    const ids = searchParams.get("ids");
    if (ids === null) return json((await db.query(
      'select id, name, created_at as "createdAt" from volumes where tenant = $1 and deleted_at is null order by created_at, id',
      [tenant],
    )).rows);
    const wanted = [...new Set(ids.split(",").map(id => id.trim()).filter(Boolean))];
    if (wanted.length > 50) throw new HttpError(400, "ids names at most 50 volumes");
    return json(await Promise.all(wanted.map(async id => info(await header(id)))));
  }

  const id = decodeURIComponent(encodedId);
  if (section === "snapshots") {
    const asked = searchParams.getAll("label");
    const labels = Object.fromEntries(asked.map(label => {
      const colon = label.indexOf(":");
      if (colon < 1) throw new HttpError(400, "label is key:value");
      return [label.slice(0, colon), label.slice(colon + 1)];
    }));
    await header(id);
    return json(await listVolumeSnapshots(db, id, asked.length ? labelsInput(labels) : undefined));
  }
  const volume = await header(id);
  if (section === undefined) return json(await info(volume));

  const snapshot = searchParams.get("snapshot");
  const files = new VolumeFiles(storage);
  if (!fileParts.length) {
    const content = searchParams.get("content");
    if (content !== null && content !== "true") throw new HttpError(400, "content must be true");
    const path = searchParams.get("prefix") ?? "/";
    const glob = searchParams.get("glob") || undefined;
    const at = snapshot ? await snapshotTree(db, storage, id, snapshot) : await liveTree(storage, id);
    if (content === "true") return json(await files.readAll(tenant, at, { path, glob }));
    const after = searchParams.get("after") || undefined;
    const limit = Number(searchParams.get("limit"));
    const listing = listVolumeFiles(at.tree, { path, glob, after, limit });
    return json({ files: listing.files.map(({ chunks: _chunks, ...file }) => file), ...(listing.next ? { next: listing.next } : {}) });
  }
  let path: string;
  try { path = normalizePath(`/${fileParts.map(decodeURIComponent).join("/")}`); }
  catch { throw new HttpError(400, "Invalid file path"); }
  const at = snapshot ? await snapshotTree(db, storage, id, snapshot) : await liveTree(storage, id);
  const entry = statVolumeFile(at.tree, path);
  if (entry.type !== "file") throw new HttpError(404, `${path} is a directory`);
  return fileResponse(files, tenant, entry, request.headers.get("range") ?? undefined);
}
