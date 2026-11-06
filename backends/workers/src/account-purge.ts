type PurgeStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list(options: { limit: number }): Promise<Map<string, unknown>>;
};

/**
 * Whether an agent's account purge may erase its storage: only once shutdown has marked it deleted, and only the agent
 * the purge names. "done" when an earlier purge was cut short between erasing the storage and marking it deleted again:
 * it is marked now, so a retried deletion pass does not fail on it forever. (Shutdown marks every deleted agent,
 * configured or not, so storage left empty was never a live agent's.)
 */
export async function purgeStart(storage: PurgeStorage, tenant: string, id: string): Promise<"erase" | "done"> {
  const config = await storage.get<{ tenantId: string; id: string }>("configuration");
  const deleted = await storage.get<boolean>("deleted");
  if (!deleted && !config && (await storage.list({ limit: 1 })).size === 0) {
    await storage.put("deleted", true);
    return "done";
  }
  if (!deleted || config && (config.tenantId !== tenant || config.id !== id))
    throw new Error("Account purge requires the owned, deleted agent");
  return "erase";
}
