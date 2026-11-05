import {portedTest} from "../ported.ts";
const test = portedTest("auth", "tests/email-signup.test.ts");
import assert from "node:assert/strict";
import {freshWindow,listen,OPERATOR,runtime,sleep,until,type T} from "../support.ts";

const PUBLIC = "https://agents.example.test";

const BROWSER = { "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin" };

const PASSWORD = "a long and unusual passphrase";

type Mail = { to: string; from: string; subject: string; text: string; html: string; tags: Record<string, string>; configurationSet?: string; link?: { page: string; token: string } };

async function fakeSes(t: T) {
  const mails: Mail[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST" || req.url !== "/v2/email/outbound-emails") { res.writeHead(404).end(); return; }
    const body = JSON.parse(text);
    const simple = body.Content?.Simple;
    if (!simple) {
      // A backend using a different mail envelope still reached the sink. Keep
      // its payload unchanged so the original assertions report the mismatch.
      mails.push(body as Mail);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ MessageId: `m-${mails.length}` }));
      return;
    }
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
  // The source additionally checks private pre-verification tenant and link rows.
  assert.deepEqual((await r.signIn("ada@example.test", PASSWORD)).json, { error: "Wrong email or password" });


  assert.deepEqual((await r.post("/console/auth/link", { token })).json, { purpose: "verify", email: "ada@example.test" });
  // The wrong password neither finishes it nor uses up the link.
  assert.deepEqual([(await r.post("/console/auth/verify", { token, password: "someone else's password" })).status], [401]);
  const verified = await r.post("/console/auth/verify", { token, password: PASSWORD });
  assert.equal(verified.status, 200);
  const tenant = verified.json.tenant as string;
  assert.match(tenant, /^u-[a-f0-9]{16}$/, "a neutral id, nothing of the address in it");
  // Admin-statistics SQL is covered by the original implementation test.
  const who = (await r.me(verified.cookie!)).json;
  assert.deepEqual([who.tenant, who.via, who.login, who.signIn], [tenant, "console", "ada@example.test", "password"]);

  // A prepaid tenant like a Google sign-up's: no automatic starting credit (a card check unlocks it where Stripe is set up).
  const billing = (await r.call("/v1/billing", { token: null, headers: { Cookie: verified.cookie! } })).json;
  assert.equal(billing.billing, "prepaid");
  assert.equal(billing.startingCredit.status, "not_granted");
  assert.equal((await r.call("/v1/billing/ledger", { token: null, headers: { Cookie: verified.cookie! } })).json.entries.length, 0);

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
  await r.expireAccountEmailLinks();
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
  // The private password-row count remains in the source; sign-in below retains ownership.
  // Its password is unchanged.
  assert.equal((await r.signIn("grace@example.test", PASSWORD)).json.tenant, verified.json.tenant);
});

test("an address a Google account signed up with is not joined, taken over or given a second account: its owner is told to use Google", async t => {
  const r = await emailRuntime(t);
  await r.seedConsoleIdentity("u-google0000000001", { method: "google", subject: "google-sub-1", email: "Lin@Example.test", login: "Lin@Example.test" });
  assert.deepEqual((await r.post("/console/auth/signup", { email: "lin@example.test", password: PASSWORD })).json, { sent: true });
  const mail = await r.ses.mail(1);
  assert.deepEqual([mail.to, mail.tags.kind, mail.link], ["lin@example.test", "google", undefined]);
  assert.match(mail.text, /signs in with Google/);
  // A reset for it says the same.
  assert.equal((await r.post("/console/auth/reset/request", { email: "lin@example.test" })).status, 202);
  assert.equal((await r.ses.mail(2)).tags.kind, "google");
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
  // The reset-link storage TTL remains an implementation assertion.
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
  // The original also checks its private log event.
});

test("mailing a link is limited per source and per address, whether or not the address has an account", async t => {
  const r = await emailRuntime(t, { AGENT_RATE_LIMIT_EMAILS_PER_ADDRESS: "2", AGENT_RATE_LIMIT_EMAIL_REQUESTS_PER_IP: "4" });
  const from = (ip: string) => ({ "X-Forwarded-For": ip });
  // Requests are counted per clock hour (per source) and per UTC day (per address): the counting below stays in one hour.
  await freshWindow(3600, 30_000);
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

test("adding a password: a Google account's own address at once, any other address through a link confirmed with the password", async t => {
  const r = await emailRuntime(t);
  const google = await r.seedConsoleIdentity("u-google0000000002", { method: "google", subject: "google-sub-2", email: "Ren@Example.test", login: "Ren@Example.test" });
  const github = await r.seedConsoleIdentity("octo", { method: "github", subject: 42, login: "octo" });
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
  const third = await r.seedConsoleIdentity("third", { method: "github", subject: 43, login: "third" });
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
