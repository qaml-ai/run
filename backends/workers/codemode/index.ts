// A separate Worker is required to keep synchronous QuickJS off the agent thread.
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";
export default { fetch: () => new Response("Not found", { status: 404 }) };
