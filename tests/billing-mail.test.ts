import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, sign, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accounts } from "../src/accounts.ts";
import { BillingAlerts } from "../src/billing-alerts.ts";
import { billingEmail } from "../src/billing-emails.ts";
import { BillingMailer, billingMailConfig } from "../src/billing-mailer.ts";
import { postLedger } from "../src/billing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { runtime, listen, until, OPERATOR, OTHER_OPERATOR } from "./runtime-server.ts";

const TOPIC = "arn:aws:sns:us-west-2:123456789012:billing";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ALL = { low: true, depleted: true, problems: true, receipts: true };
const NONE = { low: false, depleted: false, problems: false, receipts: false };
const tenantsFile = { tenants: { alice: { tokenSha256: sha(OPERATOR), billing: "prepaid", apiKeys: {} }, bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: {} } } };
const MAIL = { AGENT_BILLING_EMAIL_FROM: "billing@example.test", AGENT_BILLING_EMAIL_CONFIGURATION_SET: "billing", AGENT_BILLING_EMAIL_SNS_TOPICS: TOPIC,
  AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture" };
async function fixture() {
  const { db } = await testDatabase();
  const accounts = new Accounts({ db, tenants: new Tenants({ read: async () => JSON.stringify(tenantsFile) }), secretsKey: "ab".repeat(32) });
  const alerts = new BillingAlerts(db, accounts);
  return { db, accounts, alerts };
}

test("billing recipient API, scanner-safe confirmation, and SES delivery work together", async t => {
  const sent: any[] = [];
  const ses = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    sent.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ MessageId: `ses-${sent.length}` }));
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { ...MAIL, AWS_ENDPOINT_URL_SESV2: ses }, tenantsFile);
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
  const token = /\/console\/billing\/confirm#([\w-]{43})/.exec(sent[0].Content.Simple.Body.Text.Data)![1];
  const inspect = () => r.call(`${path}/confirmation/inspect`, { token: null, body: { token } });
  assert.deepEqual((await inspect()).json, { status: "ready", tenant: "alice", email: "billing@example.test" });
  assert.equal((await r.call(path)).json.recipients[0].status, "pending", "inspection never confirms");
  assert.equal((await fetch(`${r.base}/console/billing/confirm#${token}`)).status, 200);
  assert.equal((await r.call(path)).json.recipients[0].status, "pending", "scanner GET never confirms");
  const confirmed = await fetch(`${r.base}${path}/confirmation/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal((await confirmed.json()).status, "confirmed");
  assert.equal(confirmed.headers.get("set-cookie"), null, "mailbox proof does not create a signed-in session");
  assert.equal((await inspect()).json.status, "confirmed");
  assert.deepEqual((await r.call(`${path}/confirmation/inspect`, { token: null, body: { token: "bad" } })).json, { status: "unavailable" });
  await postLedger(r.db, [{ tenant: "alice", kind: "grant", amount: 5e6, key: "fund" }]);
  await postLedger(r.db, [{ tenant: "alice", kind: "usage", amount: -4e6, key: "use" }]);
  await until(() => sent.length === 2, "low balance sent");
  assert.match(sent[1].Content.Simple.Subject.Data, /balance is low: \$1.00/);
  assert.match(sent[1].Content.Simple.Body.Html.Data, /billing-banner.gif/);
  assert.equal((await r.call(`${path}/recipients/${recipient.id}`, { method: "PUT", body: NONE })).status, 200);
  assert.equal((await r.call(`${path}/recipients/${recipient.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(path)).json.recipients.length, 0);
});

test("disabled email is explicit and never queues a recipient", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), {}, tenantsFile);
  assert.equal((await r.call("/v1/billing/alerts")).json.emailEnabled, false);
  assert.equal((await r.call("/v1/billing/alerts/recipients", { body: { email: "test@example.test" } })).status, 503);
  assert.equal((await r.db.query("select count(*) from billing_recipients")).rows[0].count, 0);
});

test("current-state re-enabling is quiet for 24 hours after a sent notice", async () => {
  const { db, accounts, alerts } = await fixture();
  await postLedger(db, [{ tenant: "alice", kind: "grant", amount: 1e6, key: "fund" }]);
  const r = await alerts.add("alice", "notify@example.test", ALL);
  const first = (await alerts.claim())[0];
  assert.equal(await alerts.inspectConfirmation(first.token!).then(v => v.status), "ready");
  await alerts.sent(first.id, first.lease);
  await alerts.confirm(first.token!);
  const current = (await alerts.claim())[0];
  assert.equal(current.kind, "low");
  await alerts.sent(current.id, current.lease);
  for (let i = 0; i < 3; i++) { await alerts.update("alice", r.id, NONE); await alerts.update("alice", r.id, ALL); }
  assert.equal((await alerts.claim()).length, 0);
  await db.query("update billing_email_outbox set created_at=created_at-86400001 where id=$1", [current.id]);
  await alerts.update("alice", r.id, NONE); await alerts.update("alice", r.id, ALL);
  assert.equal((await alerts.claim()).length, 1);
  assert.ok(accounts);
});

test("mailer retries failures, sends one recipient per request, and keeps encrypted tokens until success", async () => {
  const { db, alerts } = await fixture();
  await alerts.add("alice", "notify@example.test");
  let attempts = 0;
  const mailer = new BillingMailer({ db, alerts, origin: "https://example.test", from: "billing@example.test", configurationSet: "billing", topics: [TOPIC],
    send: async (mail, signal) => { assert.equal(signal.aborted, false); assert.equal(mail.to, "notify@example.test"); if (++attempts === 1) throw new Error("network lost"); return "sent-2"; } });
  await mailer.pump();
  let row = (await db.query("select * from billing_email_outbox")).rows[0];
  assert.equal(row.state, "pending"); assert.ok(row.secret);
  await db.query("update billing_email_outbox set due=0");
  await Promise.all([mailer.pump(), mailer.pump()]);
  row = (await db.query("select * from billing_email_outbox")).rows[0];
  assert.equal(attempts, 2); assert.equal(row.state, "sent"); assert.equal(row.secret, null); assert.equal(row.provider_message_id, "sent-2");
  await mailer.stop();
});

test("billing templates escape content and include HTML, plain text, fallbacks and first-party assets", () => {
  for (const kind of ["confirmation", "low", "depleted"] as const) {
    const rendered = billingEmail({ kind, tenant: '<img src=x onerror="x">', email: "a@example.test", origin: "https://example.test", token: "a".repeat(43), balance: -1e6 });
    assert.ok(rendered.text.length > 100);
    assert.equal(rendered.html.includes('<img src=x'), false);
    assert.match(rendered.html, /&lt;img src=x/);
    assert.match(rendered.html, /\[if mso\]/);
    assert.match(rendered.html, /color-scheme/);
    assert.match(rendered.html, /https:\/\/example.test\/console\/email\/logo.png/);
    assert.match(rendered.html, /copy and paste/);
  }
  assert.equal(billingMailConfig({}), undefined);
  assert.throws(() => billingMailConfig({ AGENT_BILLING_EMAIL_FROM: "a@example.test" }), /requires/);
  assert.throws(() => billingMailConfig({ ...MAIL, AGENT_PUBLIC_URL: "http://example.test" }), /HTTPS/);
});

test("only signed, configured and correlated SES feedback suppresses a billing recipient", async () => {
  const { db, alerts } = await fixture();
  const recipient = await alerts.add("alice", "notify@example.test");
  const [delivery] = await alerts.claim();
  const dir = mkdtempSync(join(tmpdir(), "billing-sns-"));
  let key, cert;
  try { execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir,"key.pem"), "-out", join(dir,"cert.pem"), "-subj", "/CN=sns.amazonaws.com", "-days", "2"], { stdio:"ignore" }); key = createPrivateKey(readFileSync(join(dir,"key.pem"))); cert = readFileSync(join(dir,"cert.pem"),"utf8"); }
  finally { rmSync(dir, { recursive:true, force:true }); }
  const certUrl = `https://sns.us-west-2.amazonaws.com/billing-${randomUUID()}.pem`;
  const mailer = new BillingMailer({ db, alerts, origin:"https://example.test", from:MAIL.AGENT_BILLING_EMAIL_FROM, configurationSet:"billing", topics:[TOPIC], fetch: (async (url: string | URL) => new Response(String(url) === certUrl ? cert : "unknown")) as typeof fetch });
  const app = mailer.feedback();
  function message(event: any, extra: Record<string,string> = {}) {
    const m: Record<string,string> = { Type:"Notification", Message: JSON.stringify(event), MessageId:randomUUID(), Timestamp:new Date().toISOString(), TopicArn:TOPIC, ...extra };
    const signed = ["Message","MessageId","Timestamp","TopicArn","Type"].map(k=>`${k}\n${m[k]}\n`).join("");
    return {...m, SigningCertURL:certUrl, SignatureVersion:"2", Signature:sign("sha256",Buffer.from(signed),key!).toString("base64")};
  }
  const event = { eventType:"Bounce", mail:{source:MAIL.AGENT_BILLING_EMAIL_FROM, destination:[recipient.email], tags:{product:["camelrun-billing"],billing_delivery:[delivery.id]}},bounce:{bounceType:"Permanent",bouncedRecipients:[{emailAddress:recipient.email}]}};
  const send = (m:any) => app.request("/v1/billing/email/feedback",{method:"POST",body:JSON.stringify(m)});
  assert.equal((await send(message(event,{TopicArn:TOPIC+"-other"}))).status,403);
  assert.equal((await send({...message(event),Signature:"bad"})).status,401);
  assert.equal((await send(message({...event,bounce:{...event.bounce,bounceType:"Transient"}}))).status,200);
  assert.equal((await alerts.get("alice")).recipients[0].status,"pending");
  assert.equal((await send(message(event))).status,200);
  assert.equal((await alerts.get("alice")).recipients[0].status,"bounced");
  assert.deepEqual(await alerts.inspectConfirmation(delivery.token!),{status:"unavailable"});
  const second = await alerts.add("alice", "complaint@example.test");
  const [secondDelivery] = await alerts.claim();
  const complaint = { eventType: "Complaint", mail: { ...event.mail, destination: [second.email], tags: { ...event.mail.tags, billing_delivery: [secondDelivery.id] } },
    complaint: { complainedRecipients: [{ emailAddress: second.email }] } };
  assert.equal((await send(message({ ...complaint, mail: { ...complaint.mail, tags: { ...complaint.mail.tags, billing_delivery: [randomUUID()] } } }))).status, 200);
  assert.equal((await alerts.get("alice")).recipients.find(r => r.id === second.id)!.status, "pending", "unrelated deliveries cannot suppress a recipient");
  assert.equal((await send(message(complaint))).status, 200);
  assert.equal((await alerts.get("alice")).recipients.find(r => r.id === second.id)!.status, "bounced");
  assert.equal((await db.query("select state from billing_email_outbox where id=$1", [secondDelivery.id])).rows[0].state, "cancelled");
});
