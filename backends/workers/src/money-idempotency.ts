import { Hono } from "hono";
import { database, type PostgresEnv } from "./postgres.ts";
import { idempotency, expireIdempotencyKeys } from "./idempotency.ts";
import { skipMoneyIdempotency, secretMoneyIdempotency } from "./idempotency-routes.ts";

export type IdempotencyEnv = PostgresEnv & { AGENT_IDEMPOTENCY_LOCK_MS?: string };

/** Extra experimental route aliases carry the same secret policy as their source route. */
const canonical = (path: string) => path.replace(/^\/v1\/api-keys(?=\/|$)/, "/v1/tokens").replace(/\/rotate-secret$/, "/secret");

/** Adapt Hono middleware without changing its locks, replay records or secret handling. */
export async function withMoneyIdempotency(request: Request, env: IdempotencyEnv, tenant: string, handler: (request: Request) => Promise<Response | undefined>): Promise<Response | undefined> {
  const lockMs = env.AGENT_IDEMPOTENCY_LOCK_MS === undefined ? undefined : Number(env.AGENT_IDEMPOTENCY_LOCK_MS);
  if (lockMs !== undefined && (!Number.isFinite(lockMs) || lockMs <= 0)) throw new Error("AGENT_IDEMPOTENCY_LOCK_MS must be positive");
  let handled = false, result: Response | undefined;
  const app = new Hono();
  app.onError(error => { throw error; });
  app.use("*", idempotency({ db: () => database(env), tenant: () => tenant,
    skip: path => skipMoneyIdempotency(canonical(path)), secret: path => secretMoneyIdempotency(canonical(path)), lockMs }));
  app.all("*", async c => {
    handled = true;
    result = await handler(c.req.raw);
    return result ?? c.notFound();
  });
  const response = await app.fetch(request);
  return handled && result === undefined ? undefined : response;
}

export async function expireMoneyIdempotency(env: PostgresEnv) {
  await expireIdempotencyKeys(database(env));
}
