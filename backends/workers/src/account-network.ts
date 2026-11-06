/** workerd lacks redirect:error; manual plus rejection keeps the source credential boundary. */
async function workerFetch(input: RequestInfo | URL, init?: RequestInit) {
  const noRedirect = init?.redirect === "error" || (!init?.redirect && input instanceof Request && input.redirect === "error");
  const response = await globalThis.fetch(input, noRedirect ? { ...init, redirect: "manual" } : init);
  if (noRedirect && [301, 302, 303, 307, 308].includes(response.status) && response.headers.has("location")) {
    await response.body?.cancel();
    throw new TypeError("Fetch redirect refused");
  }
  return response;
}

/** Console and payment providers retain the source timeouts and redirect policy. */
export const network = () => ({ fetch: workerFetch });
