import { HttpError } from "./errors.ts";
import type { FileBindings } from "./files.ts";
import { database } from "./postgres.ts";
import { keyServices } from "./security-services.ts";
import { StorageUsage } from "./storage-usage.ts";

/** The source storage policy, with native immutable file objects included in usage. */
export async function storageQuota(env: FileBindings, tenant: string) {
  const { accounts } = await keyServices(env);
  const limit = await accounts.billing.storageLimit(tenant);
  if (limit === undefined) return undefined;
  let used = await new StorageUsage(database(env)).tenantUsed(tenant);
  // Files retain replaced contents until volume GC, just as source chunks retain
  // their bytes until collection. Include those objects as well as the live tree.
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({
      prefix: `files/${encodeURIComponent(tenant)}/`,
      ...(cursor ? { cursor } : {}),
    });
    used += page.objects.reduce((sum, object) => sum + object.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { limit, used };
}

/** Keep the source status, message and structured storage-limit fields. */
export function storageFull(quota: { limit: number; used: number }) {
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
  return new HttpError(507, `This account stores ${gb(quota.used)} of its ${gb(quota.limit)} storage limit, so it cannot store more; delete files or volumes to make room`, "STORAGE_LIMIT", { limit: quota.limit, used: quota.used });
}
