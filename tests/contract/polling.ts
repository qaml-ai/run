import { AsyncLocalStorage } from "node:async_hooks";

export type PollingOptions = {
  /** Exact GET resource paths concurrently being created; only their 404s may be retried. */
  pendingResources?: readonly string[];
};
type Observation = { failures: string[]; pendingResources: Set<string> };
const polling = new AsyncLocalStorage<Observation>();
export const terminalRequestStates = new Set(["completed", "failed", "cancelled", "canceled", "aborted", "expired"]);
const missingStatuses = new Set([404, 405, 501]);

function pathname(value: string) {
  return new URL(value, "http://contract.invalid").pathname;
}

function unsupported(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const error = (json as { error?: unknown }).error;
  if (typeof error === "string") return /^(unsupported\b|not[_ -]implemented\b)/i.test(error);
  if (!error || typeof error !== "object") return false;
  const { code, type, message } = error as { code?: unknown; type?: unknown; message?: unknown };
  return [code, type].some(value => typeof value === "string" && /^(unsupported(?:[_ -].*)?|not[_ -]implemented)$/i.test(value))
    || (typeof message === "string" && /^(unsupported\b|not[_ -]implemented\b)/i.test(message));
}

/** Only an unsatisfied polling attempt treats these responses as fatal. */
export function observePollingResponse(url: string, status: number, json?: unknown, method = "GET") {
  const current = polling.getStore();
  if (!current) return;
  if (status === 404 && method.toUpperCase() === "GET" && current.pendingResources.has(pathname(url)) && !unsupported(json)) return;
  if (missingStatuses.has(status)) current.failures.push(`${pathname(url)} returned HTTP ${status}`);
  else if (unsupported(json)) current.failures.push(`${pathname(url)} returned an explicit unsupported error`);
}

export function observePollingFailure(reason: string) {
  polling.getStore()?.failures.push(reason);
}

export async function pollingAttempt<V>(check: () => V | Promise<V>, what: string, options: PollingOptions = {}): Promise<V> {
  const observation: Observation = { failures: [], pendingResources: new Set(options.pendingResources?.map(pathname)) };
  return polling.run(observation, async () => {
    const value = await check();
    // A negative-route assertion and a wait for completion remain valid: first
    // let the original predicate decide whether its expectation was satisfied.
    if (!value && observation.failures.length) {
      throw new Error(`Cannot wait for ${what}: ${observation.failures[0]}`);
    }
    return value;
  });
}

export function observeMissingStream(url: string, status: number, json?: unknown) {
  return () => observePollingResponse(url, status, json);
}
