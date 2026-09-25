import { fileStorage, type LogTail, type Storage, type StorageMeter } from "./storage.ts";

/** Which storage the runtime uses. */
export type StorageDescriptor =
  | { kind: "file"; root: string; shared?: boolean }
  | { kind: "s3"; bucket: string; prefix?: string; region?: string };

/** Shared storage keeps each log's recent records in `tail`; single-host files do not need one. `meter` hears of every object created or deleted. */
export async function openStorage(descriptor: StorageDescriptor, tail: LogTail, meter?: StorageMeter): Promise<Storage> {
  if (descriptor.kind === "file") return fileStorage(descriptor.root, descriptor.shared ? { tail, meter } : { meter });
  const { s3Storage } = await import("./s3-storage.ts");
  return s3Storage({ ...descriptor, tail, meter });
}

/** Storage from AGENT_STORAGE (file | shared-file | s3) with AGENT_S3_BUCKET / AGENT_S3_PREFIX / AWS_REGION. */
export function storageFromEnvironment(dataDirectory: string, env = process.env): StorageDescriptor {
  const kind = env.AGENT_STORAGE ?? "file";
  if (kind === "file") return { kind: "file", root: dataDirectory };
  if (kind === "shared-file") return { kind: "file", root: dataDirectory, shared: true };
  if (kind === "s3") {
    if (!env.AGENT_S3_BUCKET) throw new Error("AGENT_STORAGE=s3 needs AGENT_S3_BUCKET");
    return { kind: "s3", bucket: env.AGENT_S3_BUCKET, prefix: env.AGENT_S3_PREFIX, region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION };
  }
  throw new Error(`Unknown AGENT_STORAGE: ${kind}`);
}
