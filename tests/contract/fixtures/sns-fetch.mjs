// Test-only preload for the Node runtime in email channel cases: SNS's signing certificate and its subscription
// confirmations come from the fixture instead of AWS. Every other fetch is the runtime's own.
import { readFileSync } from "node:fs";

const certificate = readFileSync(process.env.TEST_SNS_CERT_FILE, "utf8");
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname)) {
    if (url.pathname.endsWith(".pem")) return new Response(certificate);
    if (url.searchParams.get("Action") === "ConfirmSubscription") return new Response("<ConfirmSubscriptionResponse/>");
    return new Response("not found", { status: 404 });
  }
  return original(input, init);
};
