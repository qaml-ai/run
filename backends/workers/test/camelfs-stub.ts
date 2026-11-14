import { WorkerEntrypoint } from "cloudflare:workers";

/** Test-only camelFS transport. Never exported by the production entrypoint; only the test entrypoints export it,
 * so it does not also require TEST_MODE (some fixtures run the Worker with TEST_MODE "0"). */
export class CamelfsStub extends WorkerEntrypoint<{ TEST_CAMELFS_URL?: string }> {
  async fetch(request: Request): Promise<Response> {
    if (!this.env.TEST_CAMELFS_URL) return new Response(null, { status: 403 });
    const url = new URL(request.url), target = new URL(this.env.TEST_CAMELFS_URL);
    url.protocol = target.protocol;
    url.host = target.host;
    return fetch(new Request(url, request));
  }
}
