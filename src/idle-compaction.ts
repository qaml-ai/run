/** Leave time to dispatch while the provider still holds the cached prompt. */
export const IDLE_COMPACTION_DISPATCH_BUFFER_MS = 5_000;

/** Start before either the provider cache expires or the node unloads the idle host. */
export function idleCompactionWindow(requestAt: number, ttlMs: number, idleAt: number, idleTimeoutMs: number) {
  const expiresAt = requestAt + ttlMs;
  const cacheDue = expiresAt - Math.max(60_000, Math.ceil(ttlMs / 10));
  const unloadDue = idleAt + idleTimeoutMs - Math.min(60_000, Math.ceil(idleTimeoutMs / 5));
  return { dueAt: Math.min(cacheDue, unloadDue), expiresAt };
}

export function idleCompactionFresh(expiresAt: number) {
  return Date.now() + IDLE_COMPACTION_DISPATCH_BUFFER_MS < expiresAt;
}
