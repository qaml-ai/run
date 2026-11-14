import { camelfsStorage, StorageError, type StoragePlane } from "../repos/storage.ts";
import { tierConfigured, tierFetch, TierError, type TierEnv } from "./tier.ts";

export function requireCamelfs(env: TierEnv) {
  if (!tierConfigured(env)) throw new StorageError(503, "storage_unavailable", "CAMELFS_URL is required for repos");
}

/** The §9 storage plane signs each request for the calling principal. */
export function repoStorage(env: TierEnv, sub: string): StoragePlane {
  requireCamelfs(env);
  return camelfsStorage(sub, async (request, init) => {
    try { return await tierFetch(env, request, init); }
    catch (error) {
      if (error instanceof TierError) throw new StorageError(error.status, error.code, error.message, error.details, error);
      throw error;
    }
  });
}
