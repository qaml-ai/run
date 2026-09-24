import { createHash, timingSafeEqual } from "node:crypto";

/** What the executor accepts as `Authorization: Bearer <token>` from the runtime. */
export type ExecutorToken = { matches(presented: string): Promise<boolean>; close?(): void };

const hash = (token: string) => createHash("sha256").update(token).digest();
const valid = (token: unknown): token is string => typeof token === "string" && token.length >= 32;

export function staticToken(token: string): ExecutorToken {
  if (!valid(token)) throw new Error("AGENT_EXECUTOR_TOKEN must be at least 32 characters");
  const expected = hash(token);
  return { matches: async presented => timingSafeEqual(hash(presented), expected) };
}

/**
 * A token re-read from `read` (Secrets Manager on executor hosts) every
 * `refreshMs`, and early when an unknown token arrives, at most once per
 * `retryMs` so unauthenticated requests cannot drive reads. After a rotation the
 * previous value is still accepted for `graceMs`: the runtime and the executors
 * never switch at the same instant.
 */
export async function rotatingToken(read: () => Promise<string>, options: { refreshMs?: number; retryMs?: number; graceMs?: number } = {}): Promise<ExecutorToken> {
  const { refreshMs = 5 * 60_000, retryMs = 30_000, graceMs = 15 * 60_000 } = options;
  const first = await read();
  if (!valid(first)) throw new Error("The executor token secret must be at least 32 characters");
  let current = hash(first);
  let previous: { hash: Buffer; until: number } | undefined;
  let lastRead = Date.now();
  let refreshing: Promise<void> | undefined;
  const refresh = () => refreshing ??= read().then(next => {
    if (!valid(next)) throw new Error("The executor token secret must be at least 32 characters");
    const updated = hash(next);
    if (!timingSafeEqual(updated, current)) { previous = { hash: current, until: Date.now() + graceMs }; current = updated; }
  }).finally(() => { lastRead = Date.now(); refreshing = undefined; });
  const logged = () => refresh().catch(error => console.error(JSON.stringify({ type: "executor_token_refresh_failed", error: (error as Error).message })));
  const timer = setInterval(logged, refreshMs);
  timer.unref();
  const known = (presented: Buffer) => timingSafeEqual(presented, current) || !!previous && Date.now() < previous.until && timingSafeEqual(presented, previous.hash);
  return {
    async matches(token) {
      const presented = hash(token);
      if (known(presented)) return true;
      if (Date.now() - lastRead < retryMs) return false;
      await logged();
      return known(presented);
    },
    close: () => clearInterval(timer),
  };
}
