// Keep the stock VM implementation in a separate Worker from every caller DO.
import { authorized } from "../src/validation.ts";
export { CodemodeSandboxDurableObject as "camelrun-proto-codemode-sandbox" } from "@earendil-works/pi-codemode/cloudflare";
export default {
  async fetch(request: Request, env: { API_TOKEN: string }) {
    return await authorized(request, env.API_TOKEN)
      ? new Response("Not found", { status: 404 })
      : new Response("Unauthorized", { status: 401 });
  },
};
