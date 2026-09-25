import {
  DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException,
} from "@aws-sdk/client-s3";
import { meteredSegments, PreconditionFailed, removeSegments, segmentLog, validKey, type LogTail, type SegmentStore, type Storage, type StorageMeter } from "./storage.ts";

/**
 * Storage on S3. Logs are `<prefix>/<key>.log/` holding immutable segment objects,
 * with their recent records in `tail` (see `segmentLog`). Blobs are `<prefix>/<key>`,
 * created with If-None-Match. Credentials come from the default AWS chain. With a
 * `meter`, every object created or deleted is reported to it, with its size.
 */
export function s3Storage(options: { bucket: string; prefix?: string; region?: string; client?: S3Client; tail: LogTail; meter?: StorageMeter }): Storage {
  const client = options.client ?? new S3Client({ region: options.region });
  const bucket = options.bucket;
  const base = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const objectKey = (key: string) => (base ? `${base}/${key}` : key);
  // The same key rules as the file backend, so a key valid in development is valid here and nothing else is.
  const at = (key: string) => objectKey(validKey(key));
  const conditionFailed = (error: unknown) => error instanceof S3ServiceException &&
    (error.$metadata.httpStatusCode === 412 || error.$metadata.httpStatusCode === 409 || error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict");
  const missing = (error: unknown) => error instanceof S3ServiceException && (error.name === "NoSuchKey" || error.$metadata.httpStatusCode === 404);

  async function list(prefix: string) {
    const objects: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: objectKey(prefix), ContinuationToken: token }));
      for (const item of page.Contents ?? []) if (item.Key) objects.push({ key: item.Key, size: item.Size ?? 0 });
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return objects;
  }
  async function getText(key: string) {
    try { return await (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToString("utf8"); }
    catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async function create(key: string, body: string, label: string) {
    try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json", IfNoneMatch: "*" })); }
    catch (error) { if (conditionFailed(error)) throw new PreconditionFailed(label); throw error; }
  }

  function segments(key: string): SegmentStore {
    const directory = `${at(key)}.log/`;
    return {
      async list() {
        const objects = (await list(`${key}.log/`)).map(object => ({ name: object.key.slice(directory.length), size: object.size }));
        const names = objects.map(object => object.name);
        return {
          segments: names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b),
          bytes: new Map(objects.map(object => [object.name, object.size])),
          snapshots: names.filter(name => /^snapshot-\d+$/.test(name)).map(name => Number(name.slice(9))).sort((a, b) => a - b),
        };
      },
      async read(name) {
        const text = await getText(directory + name);
        if (text === undefined) throw new Error(`Missing log object ${directory}${name}`);
        return text;
      },
      async create(name, body) { await create(directory + name, body, `${key}/${name}`); },
      async remove(names) {
        for (let index = 0; index < names.length; index += 1000) {
          const batch = names.slice(index, index + 1000);
          if (batch.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map(name => ({ Key: directory + name })), Quiet: true } }));
        }
      },
    };
  }

  const metered = (key: string) => meteredSegments(segments(key), key, options.meter);
  return {
    metered: !!options.meter,
    log: (key, claim) => segmentLog(metered(key), key, options.tail, claim),
    removeLog: key => removeSegments(metered(key)),
    async readBlob(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: at(key) }));
        return await object.Body!.transformToByteArray();
      } catch (error) { if (missing(error)) return undefined; throw error; }
    },
    async writeBlob(key, data) {
      // A HEAD is cheaper than re-uploading a chunk that is already stored.
      try { await client.send(new HeadObjectCommand({ Bucket: bucket, Key: at(key) })); return; }
      catch (error) { if (!missing(error)) throw error; }
      try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: at(key), Body: data, ContentType: "application/octet-stream", IfNoneMatch: "*" })); }
      catch (error) { if (!conditionFailed(error)) throw error; return; }
      options.meter?.(key, data.byteLength);
    },
    async *objects(prefix) {
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: objectKey(prefix), ContinuationToken: token }));
        for (const item of page.Contents ?? []) if (item.Key) yield { key: base ? item.Key.slice(base.length + 1) : item.Key, bytes: item.Size ?? 0 };
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
  };
}
