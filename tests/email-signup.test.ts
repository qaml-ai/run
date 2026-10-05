import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { listen, OPERATOR, runtime, sleep, until, type T } from "./runtime-server.ts";
import { accountMailConfig } from "../src/account-mail.ts";

/**
 * Self-serve email accounts (src/email-accounts.ts) through a runtime whose account mail goes to a fake Amazon SES
 * (the SDK's AWS_ENDPOINT_URL_SESV2): sign-up, verification, sign-in, reset, adding a password, the OAuth page, limits.
 */
const PUBLIC = "https://agents.example.test";
const BROWSER = { "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin" };
const PASSWORD = "a long and unusual passphrase";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

type Mail = { to: string; from: string; subject: string; text: string; html: string; tags: Record<string, string>; configurationSet?: string; link?: { page: string; token: string } };

/** An SES v2 SendEmail endpoint that keeps each message. */
async function fakeSes(t: T) {
  const mails: Mail[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST" || req.url !== "/v2/email/outbound-emails") { res.writeHead(404).end(); return; }
    const body = JSON.parse(text);
    const simple = body.Content.Simple;
    const plain = simple.Body.Text.Data as string;
    const found = /https:\/\/agents\.example\.test\/console\/(verify|reset)#([A-Za-z0-9_-]{43})/.exec(plain);
    mails.push({ to: body.Destination.ToAddresses.join(","), from: body.FromEmailAddress, subject: simple.Subject.Data, text: plain, html: simple.Body.Html.Data,
      configurationSet: body.ConfigurationSetName,
      tags: Object.fromEntries((body.EmailTags ?? []).map((tag: { Name: string; Value: string }) => [tag.Name, tag.Value])),
      ...(found ? { link: { page: found[1], token: found[2] } } : {}) });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ MessageId: `m-${mails.length}` }));
  });
  return { url, mails, mail: (count: number) => until(() => mails.length >= count && mails[count - 1], `mail ${count}`) };
}

async function emailRuntime(t: T, env: Record<string, string> = {}) {
  const ses = await fakeSes(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), {
    AGENT_ACCOUNT_EMAIL_FROM: "accounts@mail.example.test", AGENT_ACCOUNT_EMAIL_CONFIGURATION_SET: "camelai-agent-runtime-mail", AGENT_OPEN_SIGNUP: "true",
    AWS_ENDPOINT_URL_SESV2: ses.url, AWS_REGION: "us-west-2", AWS_ACCESS_KEY_ID: "fixture-access-key", AWS_SECRET_ACCESS_KEY: "fixture-secret-key", ...env,
  });
  /** A browser's request: JSON in, the body and the session cookie it set out. */
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(r.base + path, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/json", ...BROWSER, ...headers }, body: JSON.stringify(body) });
    const text = await response.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, cookie: response.headers.getSetCookie().find(value => value.startsWith("ar_session="))?.split(";")[0] };
  };
  const me = async (cookie: string) => (await r.call("/v1/me", { token: null, headers: { Cookie: cookie } }));
  const signIn = (email: string, password: string) => post("/console/auth/password", { email, password });
  return { ...r, ses, post, me, signIn };
}

test("email sign-up: a link to finish it with the chosen password makes the tenant and signs in; nothing before that", async t => {
  const r = await emailRuntime(t);
  assert.deepEqual((await r.call("/console/auth/methods", { token: null })).json, { github: false, google: false, password: true, signup: true, reset: true });

  // The password: long enough, not a common one, not the address; no rules on its characters.
  for (const password of ["too short", "password1234", "qwertyuiop123", "ada@example.test"]) {
    const refused = await r.post("/console/auth/signup", { email: "ada@example.test", password });
    assert.equal(refused.status, 400, password);
  }
  assert.equal((await r.post("/console/auth/signup", { email: "not an address", password: PASSWORD })).status, 400);
  assert.equal((await r.post("/console/auth/signup", { email: "ada@example.test", password: PASSWORD }, { "X-Agent-Runtime-Console": "" })).status, 403, "only the console's own requests");

  const signedUp = await r.post("/console/auth/signup", { email: "  Ada@Example.TEST ", password: PASSWORD });
  assert.deepEqual([signedUp.status, signedUp.json, signedUp.cookie], [202, { sent: true }, undefined]);
  const mail = await r.ses.mail(1);
  assert.equal(mail.to, "ada@example.test", "the address is trimmed and lowercased");
  assert.match(mail.from, /<accounts@mail\.example\.test>$/);
  assert.equal(mail.subject, "Confirm your email for camelRun");
  assert.deepEqual(mail.tags, { product: "camelrun-account", kind: "verify" });
  assert.equal(mail.configurationSet, "camelai-agent-runtime-mail", "through the configuration set that publishes bounces and complaints");
  assert.equal(mail.link?.page, "verify");
  assert.ok(mail.html.includes(`${PUBLIC}/console/verify#${mail.link!.token}`));
  const token = mail.link!.token;

  // Unverified: no tenant, no sign-in, and only the token's hash is stored.
  assert.equal((await r.db.query("select count(*)::int as n from tenants")).rows[0].n, 0);
  assert.deepEqual((await r.signIn("ada@example.test", PASSWORD)).json, { error: "Wrong email or password" });
  const stored = (await r.db.query("select sha256, purpose, email, tenant, hash, expires_at - created_at as ttl from account_email_links")).rows;
  assert.deepEqual(stored.map(row => [row.sha256, row.purpose, row.email, row.tenant, Number(row.ttl)]), [[sha(token), "verify", "ada@example.test", null, 86_400_000]]);
  assert.match(stored[0].hash, /^scrypt\$/);

  assert.deepEqual((await r.post("/console/auth/link", { token })).json, { purpose: "verify", email: "ada@example.test" });
  // The wrong password neither finishes it nor uses up the link.
  assert.deepEqual([(await r.post("/console/auth/verify", { token, password: "someone else's password" })).status], [401]);
  const verified = await r.post("/console/auth/verify", { token, password: PASSWORD });
  assert.equal(verified.status, 200);
  const tenant = verified.json.tenant as string;
  assert.match(tenant, /^u-[a-f0-9]{16}$/, "a neutral id, nothing of the address in it");
  const { adminStats } = await import("../src/admin-stats.ts");
  const stats = await adminStats(r.db, { days: 1, recent: 5 });
  assert.deepEqual([stats.signups.email, stats.signups.operator, stats.recent[0].signIn], [1, 0, "email"], "the admin site counts it as an email sign-up");
  const who = (await r.me(verified.cookie!)).json;
  assert.deepEqual([who.tenant, who.via, who.login, who.signIn], [tenant, "console", "ada@example.test", "password"]);

  // A prepaid tenant like a Google sign-up's: no automatic starting credit (a card check unlocks it where Stripe is set up).
  const billing = (await r.call("/v1/billing", { token: null, headers: { Cookie: verified.cookie! } })).json;
  assert.equal(billing.billing, "prepaid");
  assert.equal(billing.startingCredit.status, "not_granted");
  assert.equal((await r.db.query("select count(*)::int as n from credit_ledger where tenant = $1", [tenant])).rows[0].n, 0);

  // The link worked once; the address and password sign in from now on.
  assert.deepEqual((await r.post("/console/auth/verify", { token, password: PASSWORD })).json.error, "This link has expired or was already used");
  assert.equal((await r.post("/console/auth/link", { token })).status, 404);
  const again = await r.signIn("ADA@example.test", PASSWORD);
  assert.equal(again.json.tenant, tenant);
  assert.equal((await r.call("/v1/account/password", { token: null, headers: { Cookie: again.cookie! } })).json.email, "ada@example.test");
});

test("sign-up links: tampered, expired and used links fail alike; a second sign-up for an address with an account gets the same answer and a different mail", async t => {
  const r = await emailRuntime(t);
  await r.post("/console/auth/signup", { email: "grace@example.test", password: PASSWORD });
  const { token } = (await r.ses.mail(1)).link!;
  const gone = { error: "This link has expired or was already used" };
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  for (const bad of [tampered, "short", "", undefined]) {
    const response = await r.post("/console/auth/verify", { token: bad, password: PASSWORD });
    assert.deepEqual([response.status, response.json.error], [400, gone.error], String(bad));
  }
  // Expired.
  await r.db.query("update account_email_links set expires_at = $1", [Date.now() - 1]);
  assert.equal((await r.post("/console/auth/verify", { token, password: PASSWORD })).json.error, gone.error);
  assert.equal((await r.post("/console/auth/link", { token })).status, 404);

  // Sign up again, verify, then a third sign-up for the same address: the same answer, a mail saying so, no link.
  await r.post("/console/auth/signup", { email: "grace@example.test", password: PASSWORD });
  const second = (await r.ses.mail(2)).link!.token;
  const verified = await r.post("/console/auth/verify", { token: second, password: PASSWORD });
  assert.equal(verified.status, 200);
  const duplicate = await r.post("/console/auth/signup", { email: "grace@example.test", password: "another long passphrase" });
  const fresh = await r.post("/console/auth/signup", { email: "nobody-yet@example.test", password: "another long passphrase" });
  assert.deepEqual([duplicate.status, duplicate.json], [fresh.status, fresh.json], "the same answer whether or not the address has an account");
  const mails = [await r.ses.mail(3), await r.ses.mail(4)];
  const existing = mails.find(mail => mail.to === "grace@example.test")!;
  assert.equal(existing.subject, "Someone tried to sign up for camelRun with your email");
  assert.equal(existing.link, undefined, "no link that would make a second account");
  assert.equal(existing.tags.kind, "exists");
  assert.equal((await r.db.query("select count(*)::int as n from tenant_passwords where email = 'grace@example.test'")).rows[0].n, 1);
  // Its password is unchanged.
  assert.equal((await r.signIn("grace@example.test", PASSWORD)).json.tenant, verified.json.tenant);
});

test("an address a Google account signed up with is not joined, taken over or given a second account: its owner is told to use Google", async t => {
  const r = await emailRuntime(t);
  await r.db.query("insert into tenants (id, google_sub, google_email, created_at) values ('u-google0000000001', 'google-sub-1', 'Lin@Example.test', $1)", [Date.now()]);
  assert.deepEqual((await r.post("/console/auth/signup", { email: "lin@example.test", password: PASSWORD })).json, { sent: true });
  const mail = await r.ses.mail(1);
  assert.deepEqual([mail.to, mail.tags.kind, mail.link], ["lin@example.test", "google", undefined]);
  assert.match(mail.text, /signs in with Google/);
  // A reset for it says the same.
  assert.equal((await r.post("/console/auth/reset/request", { email: "lin@example.test" })).status, 202);
  assert.equal((await r.ses.mail(2)).tags.kind, "google");
  assert.equal((await r.db.query("select count(*)::int as n from tenants")).rows[0].n, 1, "no second account");
  assert.equal((await r.db.query("select count(*)::int as n from account_email_links")).rows[0].n, 0);
  assert.equal((await r.db.query("select count(*)::int as n from tenant_passwords")).rows[0].n, 0);
});

test("password reset: the same answer for any address; the link sets a new password once and ends every password session", async t => {
  const r = await emailRuntime(t);
  await r.post("/console/auth/signup", { email: "kay@example.test", password: PASSWORD });
  const verified = await r.post("/console/auth/verify", { token: (await r.ses.mail(1)).link!.token, password: PASSWORD });
  const tenant = verified.json.tenant;
  const sessions = [verified.cookie!, (await r.signIn("kay@example.test", PASSWORD)).cookie!, (await r.signIn("kay@example.test", PASSWORD)).cookie!];

  const unknown = await r.post("/console/auth/reset/request", { email: "nobody@example.test" });
  const known = await r.post("/console/auth/reset/request", { email: " KAY@example.test" });
  assert.deepEqual([unknown.status, unknown.json], [202, { sent: true }]);
  assert.deepEqual([known.status, known.json], [unknown.status, unknown.json]);
  const mail = await r.ses.mail(2);
  await sleep(200);
  assert.equal(r.ses.mails.length, 2, "an address without an account gets no mail");
  assert.deepEqual([mail.to, mail.subject, mail.link?.page], ["kay@example.test", "Reset your camelRun password", "reset"]);
  const { token } = mail.link!;
  assert.equal(Number((await r.db.query("select expires_at - created_at as ttl from account_email_links where purpose = 'reset'")).rows[0].ttl), 3_600_000);
  // A newer link replaces it.
  await r.post("/console/auth/reset/request", { email: "kay@example.test" });
  const newest = (await r.ses.mail(3)).link!.token;
  assert.equal((await r.post("/console/auth/reset", { token, password: "the newer passphrase here" })).status, 400, "only the newest reset link works");

  assert.equal((await r.post("/console/auth/reset", { token: newest, password: "password1234" })).status, 400, "not a common password");
  assert.deepEqual((await r.post("/console/auth/link", { token: newest })).json, { purpose: "reset", email: "kay@example.test" });
  const reset = await r.post("/console/auth/reset", { token: newest, password: "the newer passphrase here" });
  assert.deepEqual([reset.status, reset.json], [200, { tenant, signedOut: 3 }]);
  for (const cookie of sessions) assert.equal((await r.me(cookie)).status, 401, "every password session ended");
  assert.equal((await r.me(reset.cookie!)).json.tenant, tenant, "and the reset signs in afresh");
  assert.equal((await r.signIn("kay@example.test", PASSWORD)).status, 401);
  assert.equal((await r.signIn("kay@example.test", "the newer passphrase here")).json.tenant, tenant);
  assert.equal((await r.post("/console/auth/reset", { token: newest, password: "yet another passphrase" })).status, 400, "used once");
  assert.ok(r.logs.some(line => line.includes(`"type":"password_reset","tenant":"${tenant}","signedOut":3`)));
});

test("mailing a link is limited per source and per address, whether or not the address has an account", async t => {
  const r = await emailRuntime(t, { AGENT_RATE_LIMIT_EMAILS_PER_ADDRESS: "2", AGENT_RATE_LIMIT_EMAIL_REQUESTS_PER_IP: "4" });
  const from = (ip: string) => ({ "X-Forwarded-For": ip });
  // A password refused costs nothing against the address.
  for (let i = 0; i < 3; i++) assert.equal((await r.post("/console/auth/signup", { email: "max@example.test", password: "password1234" }, from("203.0.113.9"))).status, 400);
  assert.equal((await r.post("/console/auth/signup", { email: "max@example.test", password: PASSWORD }, from("203.0.113.1"))).status, 202);
  assert.equal((await r.post("/console/auth/reset/request", { email: "max@example.test" }, from("203.0.113.2"))).status, 202);
  const capped = await r.post("/console/auth/signup", { email: "MAX@example.test", password: PASSWORD }, from("203.0.113.3"));
  assert.deepEqual([capped.status, capped.json.code, capped.json.limit], [429, "RATE_LIMITED", { name: "emails", scope: "email", max: 2, windowSeconds: 86_400 }]);
  assert.equal((await r.post("/console/auth/reset/request", { email: "max@example.test" }, from("203.0.113.4"))).status, 429, "resets count too");
  // One source: four an hour, across addresses.
  for (let i = 0; i < 4; i++) assert.equal((await r.post("/console/auth/reset/request", { email: `user${i}@example.test` }, from("198.51.100.7"))).status, 202);
  const source = await r.post("/console/auth/signup", { email: "fresh@example.test", password: PASSWORD }, from("198.51.100.7"));
  assert.deepEqual([source.status, source.json.limit?.name], [429, "email_requests"]);
  await r.ses.mail(1);
  await sleep(200);
  assert.equal(r.ses.mails.length, 1, "only the first sign-up mailed anything");
});

test("without account mail, or with sign-up closed, the forms are not offered and their routes refuse", async t => {
  const none = await emailRuntime(t, { AGENT_ACCOUNT_EMAIL_FROM: "" });
  assert.deepEqual((await none.call("/console/auth/methods", { token: null })).json, { github: false, google: false, password: true });
  assert.equal((await none.post("/console/auth/signup", { email: "a@example.test", password: PASSWORD })).status, 404);
  assert.equal((await none.post("/console/auth/reset/request", { email: "a@example.test" })).status, 404);
  assert.equal((await none.post("/console/auth/verify", { token: "x".repeat(43), password: PASSWORD })).status, 404);

  const closed = await emailRuntime(t, { AGENT_OPEN_SIGNUP: "false" });
  assert.deepEqual((await closed.call("/console/auth/methods", { token: null })).json, { github: false, google: false, password: true, reset: true });
  const refused = await closed.post("/console/auth/signup", { email: "a@example.test", password: PASSWORD });
  assert.equal(refused.status, 404);
  await sleep(200);
  assert.equal(closed.ses.mails.length, 0);
});

test("the log names tenants and kinds of mail, never addresses, links or passwords", async t => {
  const r = await emailRuntime(t);
  await r.post("/console/auth/signup", { email: "quiet@example.test", password: PASSWORD });
  const verifyToken = (await r.ses.mail(1)).link!.token;
  await r.post("/console/auth/verify", { token: verifyToken, password: "wrong passphrase entirely" });
  await r.post("/console/auth/verify", { token: verifyToken, password: PASSWORD });
  await r.post("/console/auth/signup", { email: "quiet@example.test", password: "second long passphrase" });
  await r.post("/console/auth/reset/request", { email: "quiet@example.test" });
  const resetToken = (await until(() => r.ses.mails.find(mail => mail.link?.page === "reset"), "the reset mail")).link!.token;
  await r.post("/console/auth/reset", { token: resetToken, password: "third long passphrase" });
  await sleep(200);
  const logs = r.logs.join("\n");
  for (const secret of ["quiet@example.test", "quiet", verifyToken, resetToken, PASSWORD, "second long passphrase", "third long passphrase", "wrong passphrase entirely", "/console/verify", "/console/reset"]) {
    assert.ok(!logs.includes(secret), `the log leaves out ${secret}`);
  }
  assert.match(logs, /"type":"email_signup_verified","tenant":"u-[a-f0-9]{16}"/);
});

test("account mail configuration: SES by default; the log provider only where nobody else signs up, or on this machine", () => {
  const env = { AGENT_ACCOUNT_EMAIL_FROM: "accounts@mail.example.test", AWS_REGION: "us-west-2" };
  assert.equal(accountMailConfig({}, PUBLIC, true), undefined, "off without a sender");
  assert.deepEqual(accountMailConfig(env, `${PUBLIC}/`, true), { provider: "ses", from: "accounts@mail.example.test", displayName: "camelRun", origin: PUBLIC, region: "us-west-2", configurationSet: undefined });
  const log = { ...env, AGENT_ACCOUNT_EMAIL_PROVIDER: "log" };
  assert.throws(() => accountMailConfig(log, PUBLIC, true), /not with AGENT_OPEN_SIGNUP=true on a public URL/);
  assert.equal(accountMailConfig(log, PUBLIC, false)?.provider, "log", "resets for an operator to pass on");
  assert.equal(accountMailConfig(log, "http://localhost:8080", true)?.provider, "log", "development on this machine");
  assert.throws(() => accountMailConfig(env, "http://agents.example.test", true), /HTTPS/);
  assert.throws(() => accountMailConfig({ ...env, AGENT_ACCOUNT_EMAIL_FROM: "not an address" }, PUBLIC, true), /must be an email address/);
  assert.throws(() => accountMailConfig({ ...env, AGENT_ACCOUNT_EMAIL_PROVIDER: "smtp" }, PUBLIC, true), /ses or log/);
});

test("the log provider is for a runtime of one's own: refused with open sign-up on a public URL", async t => {
  const failed = runtime(t, () => ({}), { AGENT_ACCOUNT_EMAIL_FROM: "accounts@example.test", AGENT_ACCOUNT_EMAIL_PROVIDER: "log", AGENT_OPEN_SIGNUP: "true" });
  await assert.rejects(failed, /Server exited/);
});

test("adding a password: a Google account's own address at once, any other address through a link confirmed with the password", async t => {
  const r = await emailRuntime(t);
  const now = Date.now();
  // Two accounts signed in with Google and with GitHub, as their sessions are.
  await r.db.query("insert into tenants (id, google_sub, google_email, created_at) values ('u-google0000000002', 'google-sub-2', 'Ren@Example.test', $1)", [now]);
  await r.db.query("insert into tenants (id, github, github_id, created_at) values ('octo', 'octo', 42, $1)", [now]);
  const session = async (tenant: string, method: string) => {
    const raw = randomBytes(32).toString("base64url");
    await r.db.query("insert into console_sessions (sha256, tenant, login, method, created_at, expires_at) values ($1, $2, $3, $4, $5, $6)", [sha(raw), tenant, tenant, method, now, now + 3600_000]);
    return `ar_session=${raw}`;
  };
  const google = await session("u-google0000000002", "google"), github = await session("octo", "github");
  const as = (cookie: string) => (path: string, init: { method?: string; body?: unknown } = {}) => r.call(path, { token: null, ...init, headers: { Cookie: cookie, ...BROWSER } });

  assert.deepEqual((await as(google)("/v1/account/password")).json, { email: null, googleEmail: "Ren@Example.test", canAdd: true });
  const set = await as(google)("/v1/account/password", { method: "POST", body: { email: "ren@example.test", password: PASSWORD } });
  assert.deepEqual([set.status, set.json], [200, { set: true, email: "ren@example.test" }]);
  assert.equal((await r.signIn("ren@example.test", PASSWORD)).json.tenant, "u-google0000000002");
  assert.deepEqual((await as(google)("/v1/account/password")).json, { email: "ren@example.test", googleEmail: "Ren@Example.test", canAdd: false });
  assert.equal((await as(google)("/v1/account/password", { method: "POST", body: { email: "ren2@example.test", password: PASSWORD } })).status, 409, "it has a password: change it instead");

  // GitHub: the address must be confirmed. A token may not do it, nor may anyone else's password confirm it.
  assert.equal((await r.call("/v1/account/password", { method: "POST", token: OPERATOR, body: { email: "a@example.test", password: PASSWORD } })).status, 403);
  const sent = await as(github)("/v1/account/password", { method: "POST", body: { email: "octo@example.test", password: "octo's own passphrase" } });
  assert.deepEqual([sent.status, sent.json], [202, { sent: true }]);
  const mail = await r.ses.mail(1);
  assert.deepEqual([mail.to, mail.tags.kind, mail.link?.page], ["octo@example.test", "add", "verify"]);
  assert.equal((await r.signIn("octo@example.test", "octo's own passphrase")).status, 401, "not before it is confirmed");
  assert.deepEqual((await r.post("/console/auth/link", { token: mail.link!.token })).json, { purpose: "add", email: "octo@example.test" });
  assert.equal((await r.post("/console/auth/verify", { token: mail.link!.token, password: PASSWORD })).status, 401);
  const confirmed = await r.post("/console/auth/verify", { token: mail.link!.token, password: "octo's own passphrase" });
  assert.deepEqual([confirmed.status, confirmed.json.tenant], [200, "octo"]);
  assert.equal((await r.signIn("octo@example.test", "octo's own passphrase")).json.tenant, "octo");
  assert.equal((await r.me(github)).json.tenant, "octo", "its GitHub session stays");

  // An address another account signs in with: the same answer, and its owner is told.
  await r.db.query("insert into tenants (id, github, github_id, created_at) values ('third', 'third', 43, $1)", [now]);
  const third = await session("third", "github");
  const taken = await as(third)("/v1/account/password", { method: "POST", body: { email: "octo@example.test", password: "third's own passphrase" } });
  assert.deepEqual([taken.status, taken.json], [202, { sent: true }]);
  const told = await r.ses.mail(2);
  assert.deepEqual([told.to, told.tags.kind, told.link], ["octo@example.test", "taken", undefined]);
});

test("the MCP consent page: sign up there, follow the link, and come back signed in to consent", async t => {
  const r = await emailRuntime(t);
  const REDIRECT = "http://127.0.0.1:9/callback";
  const client = await (await fetch(`${r.base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Test Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) })).json();
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "s-1", resource: `${PUBLIC}/mcp` });
  const here = `/oauth/authorize?${query}`;
  const page = await (await fetch(r.base + here)).text();
  assert.match(page, /<form method="post" action="\/oauth\/signup">/);
  assert.ok(page.includes(`href="/console/reset?next=${encodeURIComponent(here)}"`), "a link to reset a password, coming back here");

  const form = (body: Record<string, string>, headers: Record<string, string> = { Origin: r.base }) =>
    fetch(`${r.base}/oauth/signup`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
  assert.equal((await form({ email: "mo@example.test", password: PASSWORD, next: here }, { Origin: "https://evil.example" })).status, 403);
  const weak = await form({ email: "mo@example.test", password: "short", next: here });
  assert.equal(weak.status, 400);
  assert.match(await weak.text(), /A password is 12 to 256 characters/);
  const sent = await form({ email: "mo@example.test", password: PASSWORD, next: here });
  assert.equal(sent.status, 200);
  assert.match(await sent.text(), /Check your email/);

  const { token } = (await r.ses.mail(1)).link!;
  const verified = await r.post("/console/auth/verify", { token, password: PASSWORD });
  assert.equal(verified.json.next, here, "back to the consent page");
  const consent = await (await fetch(r.base + here, { headers: { Cookie: verified.cookie! } })).text();
  assert.match(consent, /Connect an application\?/);
  assert.match(consent, /Signed in as <strong>mo@example\.test<\/strong>/);
});
