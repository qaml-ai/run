import { camelfsStorage, StorageError, type CamelfsEnv, type StoragePlane } from "../repos/storage.ts";
import { tierConfigured, tierFetch, TierError, type TierEnv } from "./tier.ts";

/** The §9 storage plane for a principal: the tier with a camelfs+jwt per call when CAMELFS_URL is set, else the VPC
 * daemon with its bearer (TEMPORARY(R5)). Lives apart from storage.ts so that file stays free of Workers-only types. */
export function repoStorage(env: CamelfsEnv & Partial<TierEnv>, sub?: string): StoragePlane {
  if (!tierConfigured(env)) return camelfsStorage(env, sub);
  return camelfsStorage(env, sub, async (request, init) => {
    try { return await tierFetch(env as TierEnv, request, init); }
    catch (error) {
      if (error instanceof TierError) throw new StorageError(error.status, error.code, error.message, error.details, error);
      throw error;
    }
  });
}
