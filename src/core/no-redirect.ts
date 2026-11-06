/**
 * Fetch with redirect mode "error", on Node and on Workers alike.
 *
 * Workers' fetch throws on redirect mode "error" (it takes only "follow" and "manual"); Node accepts it. So every
 * caller that must not follow a redirect (a credential, a signed body or a one-use assertion would go with it)
 * asks with "manual" here, and a redirect is refused as Node refuses it: a `TypeError("fetch failed")` whose cause
 * says why, with the redirect's body discarded. A redirect is never followed and never returned.
 *
 * A redirect is what fetch would follow (301, 302, 303, 307, 308), or a browser's opaque redirect. Other 3xx
 * (300, 304) are not redirects to fetch and come back as responses, as they do with mode "error" on Node.
 * The mode "error" itself is banned from this repo's code: tests/no-redirect-error.test.ts fails on it.
 */
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export async function fetchWithoutRedirects(fetcher: Fetcher, input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const response = await fetcher(input, { ...init, redirect: "manual" });
  // Workers' types leave "opaqueredirect" out of Response.type; a browser's fetch gives it.
  if ((response.type as string) !== "opaqueredirect" && !REDIRECT_STATUSES.has(response.status)) return response;
  await response.body?.cancel().catch(() => {});
  throw new TypeError("fetch failed", { cause: new Error(`unexpected redirect (HTTP ${response.status})`) });
}
