import { test, type TestContext } from "node:test";
import pg from "pg";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import worker, { type MailEnv } from "../infra/billing-email/worker.ts";
import { Accounts } from "../src/accounts.ts";
import { api } from "../src/api.ts";
import { BillingAlerts } from "../src/billing-alerts.ts";
import { billingMailConfig } from "../src/billing-mailer.ts";
import { ConsoleAuth } from "../src/console-auth.ts";
import { Help, helpConfig, helpReference, HELP_LIMITS_PER } from "../src/help.ts";
import { MailTransport, type MailResult, type OutgoingMail } from "../src/mail-transport.ts";
import { Tenants } from "../src/tenants.ts";
import type { Db } from "../src/db.ts";
import { helpRouteTemplate, type HelpSubmission } from "../shared/help-contract.ts";
import { testDatabase } from "./database.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = "ab".repeat(32);
const inbox = "support@camelai.test";
const origin = "https://agents.example.test";
const agentId = `client_${"a".repeat(40)}`;
const config = { inbox, from: "no-reply@mail.camelai.test", displayName: "camelRun", origin, release: "r42", logGroup: "/ecs/test-runtime",
  transport: { from: "no-reply@mail.camelai.test", displayName: "camelRun" } };

/** `verified` become alice's verified billing addresses, oldest first. */
async function setup(t: TestContext, options: { verified?: string[]; db?: (db: Db) => Db } = {}) {
  const { url } = await testDatabase();
  // A small pool per test, closed when it ends, so this file never holds many connections at once.
  const db = new pg.Pool({ connectionString: url, max: 3 });
  t.after(() => db.end());
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {
    alice: { tokenSha256: sha("alice-operator-token-at-least-24"), billing: "prepaid", apiKeys: {} },
    bob: { tokenSha256: sha("bob-operator-token-at-least-24-x"), billing: "prepaid", apiKeys: {} },
  } }) });
  await tenants.reload();
  const accounts = new Accounts({ db, secretsKey: secret, tenants });
  await db.query(`insert into agents (id, tenant, header, revision, name, type, model) values ($1, 'alice', $2, 1, 'Support triage', 'chat', 'anthropic/claude-sonnet-5-5')`,
    [agentId, JSON.stringify({ key: "support-triage", definition: { id: "triage", revision: 3 }, config: { systemPrompt: "SECRET SYSTEM PROMPT" } })]);
  await accounts.setKey("alice", "anthropic", "sk-ant-very-private-9876");
  for (const [i, email] of (options.verified ?? []).entries()) {
    await db.query(`insert into billing_recipients (id, tenant, email, status, confirmation_hash, confirmation_expires, created_at)
      values ($1, 'alice', $2, 'verified', $3, 0, $4)`, [randomUUID(), email, randomUUID(), 1_000 + i]);
  }
  const alerts = new BillingAlerts(db, accounts);
  const sent: OutgoingMail[] = [];
  const state = { respond: (_mail: OutgoingMail): MailResult | Promise<MailResult> => ({ messageId: `m-${sent.length}` }), now: Date.parse("2026-09-30T18:04:11Z") };
  const help = new Help({ ...config, db: options.db?.(db) ?? db, accounts, alerts, hashKey: "help-test-hash-key", now: () => state.now,
    send: async mail => { sent.push(mail); return state.respond(mail); } });
  return { db, accounts, alerts, help, sent, state };
}

const submission = (overrides: Partial<HelpSubmission> = {}): HelpSubmission => ({
  submissionId: randomUUID(), email: "User@Example.test", category: "bug", impact: "blocking",
  description: "Runs fail with a 402\nI added credit this morning but prompts still fail.", agentId, requestId: "req-123",
  context: { page: "/console/agents/client_x?tab=runs#history", viewport: "1440x900", timezone: "America/Los_Angeles", build: "abc123",
    failures: [{ method: "POST", path: "/v1/agents/:id/prompt", status: 402, at: "2026-09-30T18:03:58.120Z" }] },
  ...overrides,
});
const alice = { tenant: "alice", login: "octocat" };
const DAY = 86_400_000;
const code = (reply: { body: object }) => (reply.body as { code?: string }).code;

test("a submission sends the diagnostics to support alone and the shared thread to support and the user", async t => {
  const { help, sent, db } = await setup(t);
  const input = submission();
  const reply = await help.submit(alice, input, { userAgent: "Mozilla/5.0 Test", source: "203.0.113.9" });
  const reference = helpReference(input.submissionId);
  assert.deepEqual(reply, { status: 200, body: { success: true, reference } });
  assert.equal(sent.length, 2);
  const [internal, thread] = [sent.find(mail => !mail.cc)!, sent.find(mail => mail.cc)!];
  assert.equal(internal.to, inbox); assert.equal(internal.replyTo, inbox); assert.equal(internal.cc, undefined);
  assert.equal(thread.to, inbox); assert.equal(thread.cc, "User@Example.test"); assert.equal(thread.replyTo, inbox);
  assert.notEqual(internal.subject, thread.subject);
  for (const mail of sent) assert.ok(mail.subject.includes(reference) && !/[\r\n]/.test(mail.subject), mail.subject);
  assert.equal(internal.subject, `[HIGH] [Bug or error] Runs fail with a 402 · octocat · ${reference}`);
  assert.deepEqual(internal.tags, [{ Name: "product", Value: "camelrun-support" }, { Name: "help_request", Value: input.submissionId }]);

  // Support sees observed facts, kept apart from what the user supplied; never secrets or the agent's prompt.
  for (const expected of ["octocat", "Tenant: alice", `${agentId} · key support-triage · "Support triage" · type chat · model anthropic/claude-sonnet-5-5 · definition triage@3`,
    "req-123 (supplied by the user, not verified)", "anthropic (tenant)", "Page: /console/agents/client_x", "2026-09-30T18:03:58Z POST /v1/agents/:id/prompt → 402",
    "Mozilla/5.0 Test", "Release: r42", "/ecs/test-runtime", `filter tenant = "alice" or agent = "${agentId}" or requestId = "req-123"`,
    "Supplied by the user, not verified: request=req-123", "User@Example.test (typed in the form, not verified)", "Sep 30, 2026, 11:04 AM America/Los_Angeles",
    "Billing: prepaid · balance $", "New runs: ", "Auto top-up: off", "Agents: 1", "Agent state: no pending runs · no resume failures"]) {
    assert.ok(internal.text.includes(expected), `internal text lacks ${expected}`);
  }
  for (const secretText of ["sk-ant", "9876", "SECRET SYSTEM PROMPT", "tab=runs", "#history", "203.0.113.9"]) {
    assert.ok(!internal.text.includes(secretText) && !internal.html.includes(secretText), `internal mail leaks ${secretText}`);
  }
  // The thread has only what the user wrote.
  assert.match(thread.text, /I added credit this morning/);
  assert.match(thread.text, /Our support team will reply in this thread/);
  for (const internalOnly of ["alice", "balance", "anthropic", "/v1/agents", "Mozilla", "r42", "Support triage"]) {
    assert.ok(!thread.text.includes(internalOnly) && !thread.html.includes(internalOnly), `thread leaks ${internalOnly}`);
  }
  const row = (await db.query("select status, snapshot, email_hash, source_hash from help_requests")).rows[0];
  assert.equal(row.status, "delivered");
  assert.equal(row.snapshot, null, "a delivered request forgets its snapshot");
  assert.ok(!row.email_hash.includes("example") && row.source_hash && !row.source_hash.includes("203"));

  // Retrying a delivered submission sends nothing more.
  assert.deepEqual(await help.submit(alice, input), reply);
  assert.equal(sent.length, 2);
});

test("form validation, and console context reduced to what the contract allows", async t => {
  const { help, sent } = await setup(t);
  const invalid = async (overrides: Partial<HelpSubmission>) => (await help.submit(alice, submission(overrides))) as { status: number; body: { code: string; error: string } };
  assert.equal((await invalid({ impact: undefined })).body.error, "Choose how much this affects you");
  assert.equal((await invalid({ email: "not an address" })).body.error, "Enter a valid email address");
  assert.equal((await invalid({ description: "   " })).status, 400);
  assert.equal((await invalid({ agentId: 'bad "id"' })).status, 400);
  assert.equal((await invalid({ submissionId: "nope" })).body.code, "INVALID_REQUEST");
  assert.equal(sent.length, 0);

  const accepted = await help.submit(alice, submission({ category: "question", impact: "blocking", agentId: "support-triage", requestId: undefined, context: {
    page: "https://evil.example/console", viewport: "huge", timezone: "Not/AZone", build: "<script>",
    failures: [
      { method: "GET", path: `/v1/agents/${agentId}`, status: 500, at: "2026-09-30T18:00:00Z" },
      { method: "TRACE", path: "/v1/me", status: 500, at: "2026-09-30T18:00:00Z" },
      { method: "GET", path: "/v1/me", status: 500, at: "2020-01-01T00:00:00Z" },
      ...Array.from({ length: 7 }, (_, i) => ({ method: "GET", path: "/v1/billing", status: 503, at: `2026-09-30T18:0${i}:00Z` })),
    ] } }));
  assert.equal(accepted.status, 200);
  const internal = sent.find(mail => !mail.cc)!;
  assert.ok(internal.subject.startsWith("[How-to question] "), "only bugs carry an impact");
  assert.match(internal.text, new RegExp(`Agent: ${agentId} · key support-triage`), "an agent is found by its key too");
  const client = internal.text.slice(internal.text.indexOf("CLIENT"), internal.text.indexOf("RUNTIME"));
  // Five well-formed entries are kept; the one from 2020 took a slot and is too old to show.
  assert.equal(client.match(/GET \/v1\/billing → 503/g)?.length, 4, "at most five failures, each an allowlisted template");
  for (const dropped of [agentId + " → 500", "TRACE", "evil.example", "huge", "Not/AZone", "<script>", "2020-01-01"]) assert.ok(!internal.text.includes(dropped), dropped);
  assert.match(internal.text, /Console build: unknown/);
});

test("agents are looked up only within the tenant; others' agents read the same as missing ones", async t => {
  const { help, sent } = await setup(t);
  assert.equal((await help.submit({ tenant: "bob" }, submission())).status, 200);
  const internal = sent.find(mail => !mail.cc)!;
  assert.match(internal.text, new RegExp(`Agent: ${agentId} \\(not found in this tenant; supplied by the user\\)`));
  assert.ok(!internal.text.includes("Support triage"));
  assert.match(internal.text, /Signed in with: an operator or API token/);
  assert.match(internal.text, /Supplied by the user, not verified: request=req-123 agent_input=client_a/);
});

test("a failed email is retried alone, with the first attempt's context, and never twice once accepted", async t => {
  const { help, sent, state, db } = await setup(t);
  const input = submission();
  state.respond = mail => { if (mail.cc) throw new Error("provider down"); return { messageId: "internal-1" }; };
  const failed = await help.submit(alice, input, { userAgent: "First" });
  assert.deepEqual(failed, { status: 503, body: { error: "We couldn't send your help request. Please try again.", code: "HELP_DELIVERY_FAILED" }, retryAfter: 5 });
  assert.deepEqual((await db.query("select status, internal_message_id, thread_accepted_at from help_requests")).rows[0], { status: "failed", internal_message_id: "internal-1", thread_accepted_at: null });

  state.respond = () => ({ messageId: "thread-2" });
  state.now += 60_000;
  const retried = await help.submit(alice, input, { userAgent: "Second" });
  assert.equal(retried.status, 200);
  assert.equal(sent.filter(mail => !mail.cc).length, 1, "the accepted internal email is not sent again");
  assert.equal(sent.filter(mail => mail.cc).length, 2);

  // The same id with other content is refused; so is another tenant's use of it.
  assert.equal(code(await help.submit(alice, { ...input, description: "Something else" })), "HELP_PAYLOAD_MISMATCH");
  assert.equal(code(await help.submit({ tenant: "bob" }, input)), "HELP_PAYLOAD_MISMATCH");
});

test("a submission already sending answers in progress; a suppressed user address asks for another", async t => {
  const { help, state } = await setup(t);
  const input = submission();
  const release = Promise.withResolvers<void>();
  state.respond = async () => { await release.promise; return { messageId: "late" }; };
  const first = help.submit(alice, input);
  await new Promise(resolve => setTimeout(resolve, 100));
  const second = await help.submit(alice, input);
  assert.equal(second.status, 409);
  assert.equal(code(second), "HELP_IN_PROGRESS");
  assert.equal(second.retryAfter, 5);
  release.resolve();
  assert.equal((await first).status, 200);

  state.respond = mail => mail.cc ? { suppressed: true } : { messageId: "ok" };
  const suppressed = await help.submit(alice, submission({ email: "bounced@example.test" }));
  assert.equal(suppressed.status, 422);
  assert.equal(code(suppressed), "HELP_RECIPIENT_SUPPRESSED");
});

test("rate limits are per tenant, per reply address and per source; retries do not spend them", async t => {
  const { help, state } = await setup(t);
  const kept = submission();
  for (let i = 0; i < HELP_LIMITS_PER.tenant; i++) {
    const input = i === 0 ? kept : submission({ email: `user${i}@example.test` });
    assert.equal((await help.submit(alice, input, { source: "198.51.100.1" })).status, 200);
  }
  const limited = await help.submit(alice, submission({ email: "late@example.test" }));
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, 600);
  assert.equal((await help.submit(alice, kept)).status, 200, "a retry of a sent request still answers");

  // One reply address across tenants, per day.
  state.now += 11 * 60_000;
  for (let i = 0; i < 4; i++) assert.equal((await help.submit({ tenant: "bob" }, submission({ email: "user@example.test" }))).status, 200);
  assert.equal((await help.submit({ tenant: "bob" }, submission({ email: "USER@example.test" }))).status, 429, "addresses compare case-insensitively");

  // Many submissions at once cannot overrun a limit.
  state.now += 11 * 60_000;
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => help.submit({ tenant: "bob" }, submission({ email: `burst${i}@example.test` }))));
  assert.equal(burst.filter(reply => reply.status === 200).length, HELP_LIMITS_PER.tenant);
});

test("a reply address that is the support inbox is not copied twice", async t => {
  const { help, sent } = await setup(t);
  assert.equal((await help.submit(alice, submission({ email: inbox.toUpperCase() }))).status, 200);
  assert.ok(sent.every(mail => mail.cc === undefined));
});

test("POST /v1/help is the console's; GET /v1/help says whether the button shows", async t => {
  const { help, accounts, sent } = await setup(t);
  const consoleAuth = new ConsoleAuth({ accounts, secret: "console-session-secret-with-32-chars!", publicUrl: origin });
  const context = { accounts, consoleAuth, clients: {} as never, defaultModel: async () => "anthropic/claude-sonnet-5-5", createAgent: async () => ({}) };
  const cookie = consoleAuth.session("alice", "octocat").split(";")[0];
  const console = { cookie, "x-agent-runtime-console": "1", origin, "content-type": "application/json", "x-forwarded-for": "10.0.0.1, 203.0.113.7" };
  const operator = { authorization: "Bearer alice-operator-token-at-least-24", "content-type": "application/json" };
  const enabled = api({ ...context, help });
  const disabled = api(context);
  const body = JSON.stringify(submission());
  assert.deepEqual(await (await enabled.request("/v1/help", { headers: { cookie } })).json(), { enabled: true, replyEmails: [] });
  assert.deepEqual(await (await enabled.request("/v1/help", { headers: operator })).json(), { enabled: false, replyEmails: [] });
  assert.deepEqual(await (await disabled.request("/v1/help", { headers: { cookie } })).json(), { enabled: false, replyEmails: [] });
  assert.equal((await disabled.request("/v1/help", { method: "POST", headers: console, body })).status, 404);
  assert.equal((await enabled.request("/v1/help", { method: "POST", headers: operator, body })).status, 403);
  assert.equal((await enabled.request("/v1/help", { method: "POST", headers: { ...console, "x-agent-runtime-console": "" }, body })).status, 403);
  assert.equal(sent.length, 0);
  const response = await enabled.request("/v1/help", { method: "POST", headers: console, body });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const limited = await Promise.all(Array.from({ length: 6 }, () => enabled.request("/v1/help", { method: "POST", headers: console, body: JSON.stringify(submission()) })));
  const refused = limited.find(reply => reply.status === 429)!;
  assert.equal(refused.headers.get("retry-after"), "600");
  assert.equal((await refused.json()).code, "RATE_LIMITED");
});

test("Get Help is off unless the support inbox and its sender are configured", () => {
  const mail = billingMailConfig({ AGENT_BILLING_EMAIL_FROM: "billing@mail.camelai.test", AGENT_BILLING_EMAIL_PROVIDER: "cloudflare",
    AGENT_BILLING_EMAIL_URL: "https://mail.example.test/send", AGENT_PUBLIC_URL: origin }, secret);
  const env = { AGENT_SUPPORT_EMAIL: inbox, AGENT_SUPPORT_EMAIL_FROM: "no-reply@mail.camelai.test" };
  assert.equal(helpConfig({}, mail), undefined);
  assert.throws(() => helpConfig({ AGENT_SUPPORT_EMAIL: inbox }, mail), /both/);
  assert.throws(() => helpConfig(env, undefined), /billing email provider/);
  assert.throws(() => helpConfig({ ...env, AGENT_SUPPORT_EMAIL_FROM: "billing@mail.camelai.test" }, mail), /differ/);
  assert.throws(() => helpConfig({ ...env, AGENT_SUPPORT_EMAIL_NAME: "a\nb" }, mail), /display name/);
  const configured = helpConfig({ ...env, AGENT_RELEASE: "2026.09.30-abc", AGENT_SUPPORT_LOG_GROUP: "/ecs/camelai-agent-runtime" }, mail)!;
  assert.equal(configured.displayName, "camelRun");
  assert.equal(configured.origin, origin);
  assert.deepEqual(configured.transport.cloudflare, mail!.cloudflare);
  assert.equal(configured.release, "2026.09.30-abc");
});

const workerEnv = (send: MailEnv["EMAIL"]["send"], support = true): MailEnv => ({ MAIL_SECRET: secret, FROM: "billing@mail.camelai.test",
  FEEDBACK_URL: `${origin}/v1/billing/email/feedback`, ...(support ? { SUPPORT_FROM: "no-reply@mail.camelai.test", SUPPORT_TO: inbox } : {}), EMAIL: { send } });
const workerRequest = (body: unknown) => new Request("https://mail.example.test/send", { method: "POST",
  headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("the mail Worker sends support mail only to the support inbox, with at most one other address, replying there", async () => {
  let sent: any;
  const env = workerEnv(async value => { sent = value; return { messageId: "cf-support" }; });
  const mail = { from: "no-reply@mail.camelai.test", displayName: "camelRun", to: inbox, cc: "user@example.test", replyTo: inbox,
    subject: "We got your request", text: "Hi", html: "<p>Hi</p>", headers: [] };
  const response = await worker.fetch(workerRequest(mail), env);
  assert.deepEqual(await response.json(), { messageId: "cf-support" });
  assert.deepEqual(sent, { from: { email: "no-reply@mail.camelai.test", name: "camelRun" }, to: inbox, cc: "user@example.test", replyTo: inbox,
    subject: "We got your request", text: "Hi", html: "<p>Hi</p>", headers: {} });
  sent = undefined;
  for (const invalid of [
    { ...mail, to: "user@example.test", cc: "other@example.test" }, // no support inbox
    { ...mail, replyTo: "attacker@example.test" }, { ...mail, cc: ["a@example.test", "b@example.test"] }, { ...mail, cc: "a@example.test, b@example.test" },
    { ...mail, headers: [{ Name: "List-Unsubscribe", Value: "<https://example.test>" }] },
    { ...mail, from: "billing@mail.camelai.test", headers: [] }, // billing mail takes no cc or reply-to
  ]) assert.equal((await worker.fetch(workerRequest(invalid), env)).status, 400, JSON.stringify(invalid));
  assert.equal((await worker.fetch(workerRequest(mail), workerEnv(env.EMAIL.send, false))).status, 400, "no support mail unless configured");
  assert.equal(sent, undefined);
});

test("the transport posts cc and reply-to to the Worker and reports suppression", async () => {
  let sent: any;
  let suppress = false;
  const env = workerEnv(async value => {
    sent = value;
    if (suppress) throw Object.assign(new Error("suppressed"), { code: "E_RECIPIENT_SUPPRESSED" });
    return { messageId: "cf-7" };
  });
  const transport = new MailTransport({ from: "no-reply@mail.camelai.test", displayName: "camelRun", cloudflare: { url: "https://mail.example.test/send", secret },
    fetch: (async (url: string, options: RequestInit) => worker.fetch(new Request(url, options), env)) as typeof fetch });
  const mail = { to: inbox, cc: "user@example.test", replyTo: inbox, subject: "S", html: "<p>H</p>", text: "T" };
  assert.deepEqual(await transport.send(mail, AbortSignal.timeout(5_000)), { messageId: "cf-7" });
  assert.equal(sent.cc, "user@example.test");
  assert.equal(sent.replyTo, inbox);
  suppress = true;
  assert.deepEqual(await transport.send(mail, AbortSignal.timeout(5_000)), { suppressed: true });
});

test("console paths map to allowlisted templates; anything else is left out", () => {
  assert.equal(helpRouteTemplate(`/v1/agents/${agentId}/requests/abc?x=1`), "/v1/agents/:id/requests/:requestId");
  assert.equal(helpRouteTemplate("/v1/volumes/vol_1/files/a/b/c.txt"), "/v1/volumes/:id/files/*");
  assert.equal(helpRouteTemplate("/v1/billing/auto-topup/quote?id=1"), "/v1/billing/auto-topup/quote");
  assert.equal(helpRouteTemplate("/console/auth/token"), undefined);
  assert.equal(helpRouteTemplate("/v1/help"), undefined);
  assert.equal(helpRouteTemplate("/v1/links/secret-token/file.txt"), undefined);
});

test("a tenant with verified addresses replies to one of them; a retry keeps the address it started with", async t => {
  const { help, sent, state, db } = await setup(t, { verified: ["owner@example.test", "ops@example.test", "gone@example.test"] });
  await db.query("insert into billing_recipients (id, tenant, email, status, confirmation_hash, confirmation_expires, created_at) values ($1, 'alice', 'pending@example.test', 'pending', $2, 0, 5000)", [randomUUID(), randomUUID()]);
  await db.query("insert into billing_email_suppressions (email_hash, created_at) values ($1, 0)", [sha("gone@example.test")]);
  assert.deepEqual(await help.replyEmails("alice"), ["owner@example.test", "ops@example.test"], "verified, unsuppressed, oldest first");
  assert.deepEqual(await help.replyEmails("bob"), []);

  const typed = await help.submit(alice, submission({ email: "new@example.test" }));
  assert.deepEqual(typed, { status: 400, body: { error: "Choose one of the verified email addresses on file for this account.", code: "INVALID_REQUEST" } });
  assert.equal(code(await help.submit(alice, submission({ email: "pending@example.test" }))), "INVALID_REQUEST");
  assert.equal(sent.length, 0);

  const input = submission({ email: "OPS@example.test" });
  state.respond = mail => { if (mail.cc) throw new Error("provider down"); return { messageId: "internal" }; };
  assert.equal((await help.submit(alice, input)).status, 503);
  assert.match(sent[0].text, /Reply to: OPS@example\.test \(verified billing address on file\)/);
  // The address leaves the list; the request already reserved still finishes.
  await db.query("delete from billing_recipients where email = 'ops@example.test'");
  state.respond = () => ({ messageId: "thread" });
  assert.equal((await help.submit(alice, input)).status, 200);
  assert.equal(sent.filter(mail => mail.cc === "OPS@example.test").length, 2);
});

test("a saved address the provider refuses is forgotten, so the next request can use another", async t => {
  const { help, state, db } = await setup(t, { verified: ["owner@example.test", "ops@example.test"] });
  state.respond = mail => { if (mail.cc) throw new Error("provider down"); return { suppressed: true }; };
  // Both refused: which address is at fault is unknown, so nothing is forgotten.
  assert.equal((await help.submit(alice, submission({ email: "owner@example.test" }))).status, 503);
  state.respond = () => ({ suppressed: true });
  assert.equal((await help.submit(alice, submission({ email: "owner@example.test" }))).status, 503, "the internal mail was refused too");
  assert.deepEqual(await help.replyEmails("alice"), ["owner@example.test", "ops@example.test"]);

  state.respond = mail => mail.cc ? { suppressed: true } : { messageId: "internal" };
  const refused = await help.submit(alice, submission({ email: "owner@example.test", description: "Another problem" }));
  assert.equal(refused.status, 422);
  assert.equal(code(refused), "HELP_RECIPIENT_SUPPRESSED");
  assert.deepEqual(await help.replyEmails("alice"), ["ops@example.test"]);
  assert.equal((await db.query("select status from billing_recipients where email = 'owner@example.test'")).rows[0].status, "bounced");
});

test("a retry's payload does not change as its console failures age", async t => {
  const { help, sent, state } = await setup(t);
  const failure = { method: "GET", path: "/v1/billing", status: 503, at: new Date(state.now - DAY + 60_000).toISOString() };
  const input = submission({ context: { page: "/console/billing", failures: [failure] } });
  state.respond = mail => { if (mail.cc) throw new Error("provider down"); return { messageId: "internal" }; };
  assert.equal((await help.submit(alice, input)).status, 503);
  assert.match(sent[0].text, /GET \/v1\/billing → 503/, "shown as of the first attempt");
  state.now += 2 * 60_000; // the failure is now more than a day old
  state.respond = () => ({ messageId: "thread" });
  assert.equal((await help.submit(alice, input)).status, 200);
  assert.equal(sent.filter(mail => !mail.cc).length, 1);
});

test("lookups that fail read as unknown, never as none, zero or allowed", async t => {
  const failing = (db: Db) => new Proxy(db, { get(target, property) {
    if (property === "query") return (sql: string, params?: unknown[]) => /from agents where tenant = \$1 and (id|header)/.test(sql)
      ? Promise.reject(new Error("agents unavailable")) : target.query(sql, params);
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as Db;
  const { help, accounts, sent } = await setup(t, { db: failing });
  accounts.runLimit = async () => { throw new Error("billing unavailable"); };
  accounts.keyStatus = async () => { throw new Error("keys unavailable"); };
  assert.equal((await help.submit(alice, submission())).status, 200);
  const internal = sent.find(mail => !mail.cc)!.text;
  for (const expected of [`Agent: ${agentId} (lookup failed; supplied by the user)`, "New runs: unknown (lookup failed)", "Provider keys: unavailable (lookup failed)",
    "new_runs=unknown", "Lookups that failed (unknown, not empty): agent, keys, run_limit", "Agents: 1", "Custom providers: 0", "Channels: none"]) {
    assert.ok(internal.includes(expected), `internal text lacks ${expected}`);
  }
  assert.ok(!internal.includes("New runs: allowed") && !internal.includes("not found in this tenant") && !internal.includes("Provider keys: none"));
});

test("GET /v1/help offers the console its verified addresses; POST enforces them", async t => {
  const { help, accounts, sent } = await setup(t, { verified: ["owner@example.test"] });
  const consoleAuth = new ConsoleAuth({ accounts, secret: "console-session-secret-with-32-chars!", publicUrl: origin });
  const app = api({ accounts, consoleAuth, clients: {} as never, defaultModel: async () => "anthropic/claude-sonnet-5-5", createAgent: async () => ({}), help });
  const cookie = consoleAuth.session("alice", "octocat").split(";")[0];
  const headers = { cookie, "x-agent-runtime-console": "1", origin, "content-type": "application/json" };
  assert.deepEqual(await (await app.request("/v1/help", { headers: { cookie } })).json(), { enabled: true, replyEmails: ["owner@example.test"] });
  assert.deepEqual(await (await app.request("/v1/help", { headers: { authorization: "Bearer alice-operator-token-at-least-24" } })).json(), { enabled: false, replyEmails: [] });
  const typed = await app.request("/v1/help", { method: "POST", headers, body: JSON.stringify(submission({ email: "other@example.test" })) });
  assert.equal(typed.status, 400);
  assert.equal((await typed.json()).code, "INVALID_REQUEST");
  assert.equal((await app.request("/v1/help", { method: "POST", headers, body: JSON.stringify(submission({ email: "owner@example.test" })) })).status, 200);
  assert.equal(sent.find(mail => mail.cc)?.cc, "owner@example.test");
});
