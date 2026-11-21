/**
 * Fetch with redirect mode "error", on Node and on Workers alike.
 *
 * Workers' fetch throws on redirect mode "error" (it takes only "follow" and "manual"); Node accepts it. So every
 * caller that must not follow a redirect asks with "manual" here, and a redirect is refused with a
 * `TypeError("fetch failed")` whose cause says why, with the redirect's body discarded.
 */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export async function fetchWithoutRedirects(fetcher: Fetcher, input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const response = await fetcher(input, { ...init, redirect: "manual" });
  if ((response.type as string) !== "opaqueredirect" && !REDIRECT_STATUSES.has(response.status)) return response;
  await response.body?.cancel().catch(() => {});
  throw new TypeError("fetch failed", { cause: new Error(`unexpected redirect (HTTP ${response.status})`) });
}
