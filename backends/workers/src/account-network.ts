import { fetchWithoutRedirects } from "../../../src/core/no-redirect.ts";

/**
 * Console, payment and model providers retain the source timeouts and redirect policy. Our own callers use
 * fetchWithoutRedirects directly (redirect mode "error" is banned in this repo); a library's request for that mode
 * (model SDKs reach this through model-call-fetch.ts) is mapped to it here, since workerd would throw on it.
 */
async function workerFetch(input: RequestInfo | URL, init?: RequestInit) {
  const noRedirect = init?.redirect === "error" || (!init?.redirect && input instanceof Request && input.redirect === "error");
  return noRedirect ? fetchWithoutRedirects(globalThis.fetch, input, init) : globalThis.fetch(input, init);
}

export const network = () => ({ fetch: workerFetch });
