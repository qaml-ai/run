import type { Accounts } from "../accounts.ts";
import type { UsageRecord } from "../client-sessions/state.ts";

/**
 * What the capabilities a tenant can use through several providers have in common: the key each provider is called
 * with, trying them in order, and what a call costs. Each capability keeps its own adapters.
 */

/** A provider's key for a tenant, and whether it is the platform's: only then is a call charged to the tenant's credit. */
export type KeyedCredential = { key: string; platform: boolean };

/** Why a provider did not answer, and whether the next one should be tried. */
export class Attempt extends Error {
  readonly next: boolean;
  constructor(message: string, next: boolean) { super(message); this.next = next; }
}

/**
 * A provider's answer that was not a success. A key it refuses (401, 403), a refusal for payment (402), a timeout (408),
 * a rate limit (429) or a 5xx moves on to the next provider; any other 4xx is the request's fault, which another provider would not fix.
 */
export function httpAttempt(provider: string, status: number, what: { one: string; many: string }) {
  if (status === 401 || status === 403) return new Attempt(`${provider} rejected the ${what.one} API key (HTTP ${status})`, true);
  if (status === 402) return new Attempt(`${provider} refused the ${what.one} for payment (HTTP 402)`, true);
  if (status === 429) return new Attempt(`${provider} is rate limiting ${what.many} (HTTP 429)`, true);
  if (status === 408 || status >= 500) return new Attempt(`${provider} ${what.one} failed (HTTP ${status})`, true);
  return new Attempt(`${provider} refused the ${what.one} request (HTTP ${status})`, false);
}

/**
 * The key a tenant's calls to `provider` use: Accounts.providerKey's chain (the tenant's own, else an admin's, else the
 * platform's). Only the platform's own key is the platform's: an admin's key for the tenant (its apiKeys) is the
 * tenant's to account for. Spent or rate-limited credit throws here, at each call, as js_exec can make many calls
 * between two model requests.
 */
export async function resolveKey(accounts: Pick<Accounts, "providerKey" | "billing">, tenant: string, provider: string): Promise<KeyedCredential | undefined> {
  const resolved = await accounts.providerKey(tenant, provider);
  if (!resolved) return undefined;
  const platform = resolved.source === "platform";
  if (platform) { const limited = await accounts.billing.creditLimit(tenant); if (limited) throw limited; }
  return { key: resolved.key, platform };
}

/**
 * The first provider in `order` that has a key and answers. A provider without a key is skipped. A failed `attempt`
 * moves on when it throws Attempt with `next`, and stops when `next` is false; anything else it throws, or `key` throws,
 * ends the routing as it is, as does anything thrown once `signal` has aborted. With no answer, `exhausted` makes the
 * error from the failures so far and the providers skipped.
 */
export async function route<P extends string, T>(context: {
  kind: string; tenant: string; agent: string; order: readonly P[]; signal?: AbortSignal;
  key(provider: P): Promise<KeyedCredential | undefined>;
  attempt(provider: P, credential: KeyedCredential): Promise<T>;
  exhausted(failures: string[], unkeyed: P[]): Error;
}): Promise<{ provider: P; credential: KeyedCredential; value: T }> {
  const failures: string[] = [];
  const unkeyed: P[] = [];
  for (const provider of context.order) {
    const credential = await context.key(provider);
    if (!credential) { unkeyed.push(provider); continue; }
    try {
      const value = await context.attempt(provider, credential);
      if (failures.length) console.error(JSON.stringify({ type: `${context.kind}_fallback`, tenant: context.tenant, agent: context.agent, answered: provider, failed: failures }));
      return { provider, credential, value };
    } catch (error) {
      if (context.signal?.aborted) throw error;
      if (!(error instanceof Attempt)) throw error;
      failures.push(error.message);
      if (!error.next) break;
    }
  }
  throw context.exhausted(failures, unkeyed);
}

/** Record a call's usage for its tenant, charged to credit when it ran on the platform's key, and charge its end user where the tenant meters them (end-user-credits.ts). */
export function meter(accounts: Pick<Accounts, "recordUsage">, clients: { endUserCharge(agent: string, usage: UsageRecord): void }, tenant: string, agent: string, usage: UsageRecord) {
  accounts.recordUsage(tenant, agent, usage);
  clients.endUserCharge(agent, usage);
}
