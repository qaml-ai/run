// Each path that must not follow a redirect, run in workerd: workerd's fetch throws on redirect mode "error" (Node's
// accepts it), so these paths ask through fetchWithoutRedirects (src/core/no-redirect.ts). Against fake services on
// loopback, each must work on a 200 and refuse a 302 cleanly: as Node's "fetch failed", never followed.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { signWebhook } from "../src/stripe.ts";
import { unusedPort } from "./local-worker.ts";

const seen: string[] = [];
let redirecting = false, fake = "", worker: Unstable_DevWorker, storage = "";
const read = async (request: IncomingMessage) => { let text = ""; for await (const chunk of request) text += chunk; return text; };
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, "http://fake").pathname, body = await read(request);
  seen.push(`${request.method} ${path}`);
  const json = (value: unknown) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
  // The STS signer is the runtime's own; only the services a credential or signed body goes to redirect.
  if (path === "/sts") return json({ WebIdentityToken: "web-identity-token" });
  if (redirecting) return response.writeHead(302, { location: `${fake}/trap` }).end("moved");
  if (path === "/trap") return response.writeHead(500).end("followed a redirect");
  if (path === "/v1/checkout/sessions") return json({ id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.test/c/cs_test_1", sent: Object.fromEntries(new URLSearchParams(body)) });
  if (path === "/v1/checkout/sessions/cs_test_1") return json({ id: "cs_test_1", object: "checkout.session", payment_status: "paid" });
  if (path === "/v1/oauth/token") return json({ access_token: "sk-ant-oat01-federated", expires_in: 600, assertion: JSON.parse(body).assertion });
  if (path === "/items/7") return json({ id: "7" });
  if (path === "/api/journey/account-export") return json({ status: "ok", kind: "events", account: null, consent: null, events: [{ name: "run_account_created" }], next_cursor: null });
  if (path === "/api/journey/server-events") return json({ accepted: [request.headers["webhook-id"]], duplicates: [] });
  response.writeHead(404).end();
});

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fake = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  storage = await mkdtemp(join(tmpdir(), "no-redirect-"));
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"]) delete process.env[key];
  Object.assign(process.env, { CI: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(storage, "logs"), CLOUDFLARE_DEV_REGISTRY_PATH: join(storage, "registry") });
  worker = await unstable_dev(fileURLToPath(new URL("./no-redirect/worker.ts", import.meta.url)), {
    config: fileURLToPath(new URL("./no-redirect/wrangler.jsonc", import.meta.url)),
    local: true, port: await unusedPort(), inspectorPort: await unusedPort(), persistTo: storage,
    experimental: { disableExperimentalWarning: true, showInteractiveDevSession: false },
  });
});
after(async () => {
  await worker?.stop();
  server.closeAllConnections();
  server.close();
  await rm(storage, { recursive: true, force: true });
});

let tags = 0;
async function call(path: string, redirect: boolean, init: RequestInit = {}) {
  redirecting = redirect;
  seen.length = 0;
  const response = await worker.fetch(`${path}?fake=${encodeURIComponent(fake)}&tag=${++tags}`, init as never);
  assert.equal(response.status, 200);
  return await response.json() as { ok: boolean; value?: any; name?: string; message?: string; cause?: string };
}
/** Refused as Node refuses redirect mode "error", without following it or failing on the mode itself. */
function refused(result: Awaited<ReturnType<typeof call>>) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.deepEqual([result.name, result.message], ["TypeError", "fetch failed"], JSON.stringify(result));
  assert.equal(result.cause, "unexpected redirect (HTTP 302)");
  assert.ok(!seen.includes("GET /trap") && !seen.includes("POST /trap"), `a redirect was followed: ${seen.join(", ")}`);
}

test("workerd's own fetch refuses redirect mode \"error\": what these paths must never ask", async () => {
  const result = await call("/native", false);
  assert.equal(result.ok, false, "workerd now takes redirect mode \"error\"; fetchWithoutRedirects is still correct, but this test's premise changed");
  assert.match(result.message ?? "", /redirect/i);
  assert.deepEqual(seen, [], "nothing was sent");
});

test("Stripe: a checkout session is created, and refused, not followed, when Stripe redirects", async () => {
  const created = await call("/stripe/checkout", false);
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.value.id, "cs_test_1");
  assert.equal(created.value.sent["line_items[0][price_data][unit_amount]"], "1000");
  assert.deepEqual(seen, ["POST /v1/checkout/sessions"]);
  refused(await call("/stripe/checkout", true));
  assert.deepEqual(seen, ["POST /v1/checkout/sessions"]);
});

test("Stripe: a signed webhook verifies and its session is fetched; a redirect on that fetch is refused", async () => {
  const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_1" } } });
  const init = () => ({ method: "POST", body: payload, headers: { "stripe-signature": signWebhook("whsec_redirects", payload) } });
  const verified = await call("/stripe/webhook", false, init());
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.deepEqual([verified.value.event, verified.value.session.payment_status], ["evt_1", "paid"]);
  assert.deepEqual(seen, ["GET /v1/checkout/sessions/cs_test_1"]);
  refused(await call("/stripe/webhook", true, init()));
  const forged = await call("/stripe/webhook", false, { ...init(), headers: { "stripe-signature": signWebhook("whsec_other", payload) } });
  assert.deepEqual([forged.ok, forged.message, seen], [false, "signature refused", []]);
});

test("Anthropic federation: the token exchange works, and a redirect is refused without forwarding the assertion", async () => {
  const exchanged = await call("/federation", false);
  assert.deepEqual(exchanged, { ok: true, value: { apiKey: "sk-ant-oat01-federated", bearer: true } });
  assert.deepEqual(seen, ["POST /sts", "POST /v1/oauth/token"]);
  // The policy's fallback is the static key; what matters is that the one-use assertion went nowhere else.
  const redirected = await call("/federation", true);
  assert.deepEqual(redirected, { ok: true, value: { apiKey: "static-key" } });
  assert.deepEqual(seen, ["POST /sts", "POST /v1/oauth/token"]);
});

test("OpenAPI tool sources: an operation answers, and a redirecting API is refused", async () => {
  const answered = await call("/tools", false);
  assert.equal(answered.ok, true, JSON.stringify(answered));
  assert.deepEqual(answered.value, [{ type: "text", text: '{"id":"7"}' }]);
  assert.deepEqual(seen, ["GET /items/7"]);
  const redirected = await call("/tools", true);
  // A tool's failure may come back as its result or as a throw; either way it is Node's refusal, not workerd's.
  const text = JSON.stringify(redirected);
  assert.match(text, /fetch failed/);
  assert.doesNotMatch(text, /Invalid redirect|must be one of/i);
  assert.deepEqual(seen, ["GET /items/7"]);
});

test("journey: an account's export and an outbox delivery reach the store, and a redirecting store is refused", async () => {
  const exported = await call("/journey/export", false);
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.deepEqual(exported.value[0].records, [{ name: "run_account_created" }]);
  refused(await call("/journey/export", true));
  assert.deepEqual(seen, ["POST /api/journey/account-export"]);
  const sent = await call("/journey/send", false);
  assert.deepEqual(sent, { ok: true, value: [{ delivered: "8d0e6f7a-1b2c-4d3e-8f90-0a1b2c3d4e5f" }] });
  const failed = await call("/journey/send", true);
  // A delivery that fails is kept with its error and tried again later.
  assert.deepEqual(failed, { ok: true, value: [{ failed: "fetch failed" }] });
  assert.deepEqual(seen, ["POST /api/journey/server-events"]);
});
