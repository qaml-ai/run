import { AsyncLocalStorage } from "node:async_hooks";
import { observePollingResponse } from "./polling.ts";
export const evidence = new AsyncLocalStorage<{ backend: string | null }>();

const origins = new Map<string, string>();
const publicFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const response = await publicFetch(input, init);
  const backend = origins.get(url.origin);
  if (backend) observePollingResponse(url.href, response.status, undefined, init?.method ?? (input instanceof Request ? input.method : "GET"));
  // Starting a fixture, preparing its state or waiting for health is not an
  // HTTP contract assertion. Count only a completed public API request.
  if (backend && url.pathname !== "/healthz" && !url.pathname.split("/").includes("__test")) {
    const current = evidence.getStore();
    if (current) current.backend = backend;
  }
  return response;
};

export function observeBackend(base: string, backend: string) {
  origins.set(new URL(base).origin, backend);
  return () => { origins.delete(new URL(base).origin); };
}
