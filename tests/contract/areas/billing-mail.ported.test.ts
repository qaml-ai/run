import {portedTest} from "../ported.ts";
const test=portedTest("billing", "tests/billing-mail.test.ts");
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runtime,listen,until,OPERATOR,OTHER_OPERATOR} from "../support.ts";

const TOPIC = "arn:aws:sns:us-west-2:123456789012:billing";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const NONE = { low: false, depleted: false, problems: false, receipts: false };

const tenantsFile = { tenants: { alice: { tokenSha256: sha(OPERATOR), billing: "prepaid", apiKeys: {} }, bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: {} } } };

const MAIL = { AGENT_BILLING_EMAIL_FROM: "billing@example.test", AGENT_BILLING_EMAIL_CONFIGURATION_SET: "billing", AGENT_BILLING_EMAIL_SNS_TOPICS: TOPIC,
  AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture" };

test("billing recipient API, scanner-safe confirmation, and SES delivery work together", async t => {
  // Test the scanner-safe GET without relying on an ignored local console build.
  const consoleDir = mkdtempSync(join(tmpdir(), "billing-mail-console-"));
  writeFileSync(join(consoleDir, "index.html"), "<!doctype html><title>Billing confirmation fixture</title>");
  t.after(() => rmSync(consoleDir, { recursive: true, force: true }));
  const sent: any[] = [];
  const ses = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    sent.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ MessageId: `ses-${sent.length}` }));
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { ...MAIL, AWS_ENDPOINT_URL_SESV2: ses, AGENT_CONSOLE_DIR: consoleDir, AGENT_BILLING_ADMINS: "alice" }, tenantsFile);
  const path = "/v1/billing/alerts";
  assert.equal((await r.call(path, { token: null })).status, 401);
  assert.equal((await r.call(path, { token: OTHER_OPERATOR })).status, 400, "unbilled accounts cannot create billing rows");
  assert.deepEqual((await r.call(path)).json, { threshold: 2e6, recipients: [], emailEnabled: true });
  assert.equal((await r.call(path, { method: "PUT", body: { thresholdUsd: 1.001 } })).status, 400);
  assert.equal((await r.call(path, { method: "PUT", body: { thresholdUsd: 3 } })).json.threshold, 3e6);
  const created = await r.call(`${path}/recipients`, { body: { email: "billing@example.test" } });
  assert.equal(created.status, 201, created.text);
  const recipient = created.json;
  assert.equal(recipient.status, "pending");
  assert.equal(JSON.stringify(recipient).includes("token"), false);
  assert.equal((await r.call(`${path}/recipients/bad-id`, { method: "DELETE" })).status, 400);
  await until(() => sent.length === 1, "confirmation sent through local SES fixture");
  assert.deepEqual(sent[0].Destination.ToAddresses, ["billing@example.test"]);
  assert.equal(sent[0].ConfigurationSetName, "billing");
  assert.equal(sent[0].EmailTags[0].Value, "camelrun-billing");
  assert.match(sent[0].FromEmailAddress, /<billing@example.test>$/);
  assert.match(sent[0].FromEmailAddress, new RegExp(Buffer.from("camelRun Billing").toString("base64")));
  assert.equal(sent[0].Content.Simple.Headers[1].Value, "List-Unsubscribe=One-Click");
  const stopToken = /\/one-click\/([\w-]{43})/.exec(sent[0].Content.Simple.Headers[0].Value)![1];
  const token = /\/console\/billing\/confirm#([\w-]{43})/.exec(sent[0].Content.Simple.Body.Text.Data)![1];
  const inspect = () => r.call(`${path}/confirmation/inspect`, { token: null, body: { token } });
  assert.deepEqual((await inspect()).json, { status: "ready", tenant: "alice", email: "billing@example.test" });
  assert.equal((await r.call(path)).json.recipients[0].status, "pending", "inspection never confirms");
  const landing = await fetch(`${r.base}/console/billing/confirm#${token}`);
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Billing confirmation fixture/);
  assert.equal((await r.call(path)).json.recipients[0].status, "pending", "scanner GET never confirms");
  const confirmed = await fetch(`${r.base}${path}/confirmation/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal((await confirmed.json()).status, "confirmed");
  assert.equal(confirmed.headers.get("set-cookie"), null, "mailbox proof does not create a signed-in session");
  assert.equal((await inspect()).json.status, "confirmed");
  assert.deepEqual((await r.call(`${path}/confirmation/inspect`, { token: null, body: { token: "bad" } })).json, { status: "unavailable" });
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "alice", amount: 5e6, reason: "test", idempotencyKey: "fund" } })).status, 201);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "alice", amount: -4e6, reason: "test", idempotencyKey: "use" } })).status, 201);
  await until(() => sent.length === 2, "low balance sent");
  assert.match(sent[1].Content.Simple.Subject.Data, /balance is low: \$1.00/);
  assert.match(sent[1].Content.Simple.Body.Html.Data, /billing-banner.gif/);
  const oneClick = `${r.base}${path}/one-click/${stopToken}`;
  assert.equal((await fetch(oneClick, { redirect: "manual" })).status, 302);
  assert.equal((await r.call(path)).json.recipients[0].status, "verified", "scanner GET never unsubscribes");
  const previewStop = await r.call(`${path}/unsubscribe/inspect`, { token: null, body: { token: stopToken } });
  assert.equal(previewStop.json.status, "ready");
  const stopped = await fetch(oneClick, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(stopped.status, 204); assert.equal(stopped.headers.get("set-cookie"), null);
  assert.equal((await r.call(path)).json.recipients[0].status, "unsubscribed");
  const multipart = new FormData(); multipart.set("List-Unsubscribe", "One-Click");
  assert.equal((await fetch(oneClick, { method: "POST", body: multipart })).status, 204, "multipart repeat is harmless");
  assert.equal((await r.call(`${path}/unsubscribe/inspect`, { token: null, body: { token: stopToken } })).json.status, "unsubscribed");
  assert.equal((await r.call(`${path}/recipients/${recipient.id}`, { method: "PUT", body: NONE })).status, 200);
  assert.equal((await r.call(`${path}/recipients/${recipient.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(path)).json.recipients.length, 0);
});

test("disabled email is explicit and never queues a recipient", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), {}, tenantsFile);
  assert.equal((await r.call("/v1/billing/alerts")).json.emailEnabled, false);
  assert.equal((await r.call("/v1/billing/alerts/recipients", { body: { email: "test@example.test" } })).status, 503);
  // The original also inspects the private billing_recipients table. Its public equivalent remains empty.
  assert.equal((await r.call("/v1/billing/alerts")).json.recipients.length, 0);
});
