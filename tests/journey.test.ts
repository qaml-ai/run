import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { ConsoleAuth, CONSOLE_HEADER } from "../src/console-auth.ts";
import { consoleRoute, deleteJourneyAccount, emailAt, Journey, journeyApp, journeyConfig, type JourneyEvent, type JourneyOptions } from "../src/journey.ts";
import { Passwords } from "../src/passwords.ts";
import { Tenants } from "../src/tenants.ts";
import { transaction } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { listen, type T } from "./runtime-server.ts";

const SECRET = `whsec_${Buffer.from("journey-test-signing-key-0123456789").toString("base64")}`;
const VISITOR = "3f2b8a6e-1c4d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_VISITOR = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORIGIN = "http://run.example.test";
/** A browser that agreed to be measured, carrying `visitor`. */
const browserOf = (visitor: string | null = VISITOR) => ["camel_consent=granted", ...(visitor ? [`camel_attribution_id=${visitor}`] : [])].join("; ");
const AGREED = { visitor: VISITOR, consent: "granted" as const, collect: true };
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** A fake GitHub: any code signs in as `user`. */
async function fakeGithub(t: T, user: { login: string; id: number }) {
  return listen(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/login/oauth/access_token") return void res.end(JSON.stringify({ access_token: "gho_fixture" }));
    if (req.url === "/user") return void res.end(JSON.stringify({ ...user, name: "Octo Cat", created_at: "2015-01-01T00:00:00Z" }));
    res.end("{}");
  });
}

/**
 * A fake journey store: what it took, having checked each delivery's signature over the bytes it got.
 * `answer` picks each delivery's status, or a whole reply; a 200 names the event as the real store does.
 */
async function fakeStore(t: T, answer: (delivery: number, event: JourneyEvent) => number | { status: number; body: string } = () => 200, refusalStatus: () => number = () => 200) {
  const deliveries: { id: string; events: JourneyEvent[] }[] = [];
  const touches: { attribution_id: string; touch: Record<string, unknown> }[] = [];
  const refusals: { control_id: string; account_ref: string; visitor_id: string | null; consent: string; decided_at: string }[] = [];
  let count = 0;
  const url = await listen(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const id = String(req.headers["webhook-id"]), timestamp = String(req.headers["webhook-timestamp"]);
      const expected = `v1,${createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
      if (!["/api/journey/server-events", "/api/marketing-attribution/resolve", "/api/journey/consent-controls"].includes(req.url!) || req.headers["webhook-signature"] !== expected || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return void res.writeHead(401).end("{}");
      if (req.url === "/api/marketing-attribution/resolve") {
        touches.push(JSON.parse(body));
        return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ schema_version: 1, attribution_id: JSON.parse(body).attribution_id, first_touch: {}, latest_touch: null }));
      }
      if (req.url === "/api/journey/consent-controls") {
        const status = refusalStatus();
        if (status === 200) refusals.push(JSON.parse(body));
        return void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(status === 200 ? { accepted: [id], duplicates: [] } : { error: "fixture" }));
      }
      const events = JSON.parse(body).events as JourneyEvent[];
      const reply = answer(count++, events[0]!);
      if (typeof reply !== "number") return void res.writeHead(reply.status, { "Content-Type": "text/html" }).end(reply.body);
      if (reply === 200) deliveries.push({ id, events });
      res.writeHead(reply, { "Content-Type": "application/json" }).end(JSON.stringify(reply === 200 ? { accepted: [id], duplicates: [] } : { error: "fixture" }));
    });
  });
  return { url, deliveries, touches, refusals };
}

async function setup(t: T, options: { journey?: false | Partial<JourneyOptions>; store?: string; internalDomains?: string[] } = {}) {
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, pricing: { startingGrant: 0 } as never });
  const journey = options.journey === false ? undefined : new Journey({
    db, url: options.store ?? "http://127.0.0.1:9", secret: SECRET, publicUrl: "https://run.example.test", visitorCookie: "camel_attribution_id", visitorCookieDomain: "example.test", siteHosts: ["example.test", "www.example.test"], consentCookie: "camel_consent", retryBaseMs: 1,
    internal: (_tenant, email) => emailAt(options.internalDomains ?? [], email), ...options.journey,
  });
  const github = await fakeGithub(t, { login: "octocat", id: 583231 });
  const consoleAuth = new ConsoleAuth({
    accounts, publicUrl: ORIGIN, passwords: new Passwords(db), journey,
    github: { clientId: "id", clientSecret: "secret", org: "", open: true, minAccountDays: 0, webUrl: github, apiUrl: github },
  });
  /** Sign in with GitHub from a browser with these cookies and headers; `next` as the MCP consent page sets it. Returns the session cookie. */
  const signIn = async (cookie = browserOf(), next?: string, headers: Record<string, string> = {}) => {
    const start = await consoleAuth.app.request(`/console/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`, { headers: { cookie, ...headers } });
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const set = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const callback = await consoleAuth.app.request(`/console/auth/callback?code=abc&state=${state}`, { headers: { cookie: [set, cookie].filter(Boolean).join("; "), ...headers } });
    assert.equal(callback.status, 302);
    assert.ok(!callback.headers.get("location")!.includes("error="), callback.headers.get("location")!);
    return callback.headers.getSetCookie().find(value => value.startsWith("ar_session="))!.split(";")[0]!;
  };
  const outbox = async () => (await db.query("select id, account_ref, body, attempts, last_error, rejected_at from journey_outbox where target = 'events' order by created_at, body->>'name', id")).rows as
    { id: string; account_ref: string | null; body: JourneyEvent; attempts: number; last_error: string | null; rejected_at: number | null }[];
  const names = async () => (await outbox()).map(row => row.body.name);
  /** The touches waiting to go to the store's attribution endpoint. */
  const touches = async () => (await db.query("select body from journey_outbox where target = 'resolve' order by created_at, id")).rows.map(row => row.body as { attribution_id: string; touch: { page_host: string; page_path: string; referrer_host: string | null; campaign: Record<string, string>; occurred_at: string } });
  /** Word of a refusal waiting to go to the store's consent endpoint. */
  const refusals = async () => (await db.query("select id, account_ref, body from journey_outbox where target = 'consent' order by created_at, id")).rows.map(row => ({ id: row.id as string, column: row.account_ref as string, ...row.body as { control_id: string; account_ref: string; visitor_id: string | null; consent: string; decided_at: string; schema_version: number } }));
  /** A browser going to a console page. */
  const arrive = (path: string, headers: Record<string, string> = {}) => journey!.arrival(new Request(`http://internal${path}`, { headers: { "user-agent": CHROME, "sec-fetch-dest": "document", cookie: "camel_consent=granted", ...headers } }));
  return { db, accounts, journey, consoleAuth, signIn, outbox, names, touches, refusals, arrive };
}

test("journey events are configured by AGENT_JOURNEY_URL and a secret, and off without them", () => {
  assert.equal(journeyConfig({}, undefined), undefined);
  assert.throws(() => journeyConfig({}, SECRET), /without AGENT_JOURNEY_URL/);
  assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "https://example.com" }, undefined), /AGENT_JOURNEY_SECRET/);
  // Not a secret, base64url where the store reads standard base64, and a key too short to sign with.
  for (const secret of ["not-a-secret", "whsec_abc-def_ghijklmnopqrstuv", `whsec_${Buffer.from("short").toString("base64")}`]) {
    assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "https://example.com" }, secret), /whsec_/, secret);
  }
  for (const url of ["example.com", "ftp://example.com", "https://example.com/path", "https://user:pass@example.com", "https://example.com/?a=1"]) {
    assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: url }, SECRET), /must be an origin/, url);
  }
  assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "http://example.com" }, SECRET), /must be https/);
  for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) assert.equal(journeyConfig({ AGENT_JOURNEY_URL: url }, SECRET)!.url, url);
  assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "https://example.com", AGENT_JOURNEY_VISITOR_COOKIE: "a b" }, SECRET), /VISITOR_COOKIE must be a cookie name/);
  assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "https://example.com", AGENT_JOURNEY_CONSENT_COOKIE: "a=b" }, SECRET), /CONSENT_COOKIE must be a cookie name/);
  assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "https://example.com", AGENT_JOURNEY_COLLECT_UNKNOWN: "yes" }, SECRET), /true or false/);
  assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "https://example.com", AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS: "not a domain" }, SECRET), /INTERNAL_EMAIL_DOMAINS must be host names/);
  for (const retry of ["0", "-5", "soon", "1.5", "Infinity"]) assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "https://example.com", AGENT_JOURNEY_RETRY_MS: retry }, SECRET), /RETRY_MS/, retry);
  assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "https://example.com", AGENT_JOURNEY_VISITOR_COOKIE_DOMAIN: "example.com, example.org" }, SECRET), /one domain/);
  assert.throws(() => journeyConfig({ AGENT_JOURNEY_URL: "https://example.com", AGENT_JOURNEY_SITE_HOSTS: "https://example.com" }, SECRET), /SITE_HOSTS must be host names/);
  assert.deepEqual(journeyConfig({
    AGENT_JOURNEY_URL: "https://example.com/", AGENT_JOURNEY_VISITOR_COOKIE: "camel_attribution_id", AGENT_JOURNEY_VISITOR_COOKIE_DOMAIN: "Example.com", AGENT_JOURNEY_SITE_HOSTS: "example.com, www.example.com",
    AGENT_JOURNEY_CONSENT_COOKIE: "camel_consent", AGENT_JOURNEY_INTERNAL_EMAIL_DOMAINS: "Example.com, example.org", AGENT_JOURNEY_RETRY_MS: "500",
  }, SECRET), {
    url: "https://example.com", secret: SECRET, visitorCookie: "camel_attribution_id", visitorCookieDomain: "example.com", siteHosts: ["example.com", "www.example.com"],
    consentCookie: "camel_consent", collectUnknown: false, internalEmailDomains: ["example.com", "example.org"], retryBaseMs: 500,
  });
  assert.equal(journeyConfig({ AGENT_JOURNEY_URL: "https://example.com", AGENT_JOURNEY_COLLECT_UNKNOWN: "true" }, SECRET)!.collectUnknown, true);
  assert.ok(emailAt(["example.com"], "Ada@Example.com"));
  assert.ok(!emailAt(["example.com"], "ada@notexample.com") && !emailAt(["example.com"], "ada@example.com.evil.test") && !emailAt(["example.com"], undefined));
});

test("without journey events configured, a sign-up and a sign-in write nothing", async t => {
  const { db, signIn } = await setup(t, { journey: false });
  await signIn();
  await signIn();
  assert.equal((await db.query("select 1 from tenants where id = 'octocat'")).rowCount, 1);
  for (const table of ["journey_accounts", "journey_milestones", "journey_outbox", "journey_state", "journey_lost_signups"]) assert.equal((await db.query(`select 1 from ${table}`)).rowCount, 0, table);
});

test("a sign-up is one run_account_created naming the visitor; later sign-ins are run_signed_in and never change who signed up", async t => {
  const { db, signIn, outbox } = await setup(t);
  await signIn(`theme=dark; ${browserOf()}`);
  const [started, created, ...none] = await outbox();
  assert.equal(none.length, 0);
  // Before there is an account, the browser alone.
  assert.deepEqual([started!.body.name, started!.body.visitor_id, started!.body.account_ref, started!.body.properties], ["run_auth_started", VISITOR, null, { method: "github", auth_surface: "console" }]);
  const account = (await db.query("select account_ref, signup_visitor, since_signup, consent from journey_accounts where tenant = 'octocat'")).rows[0];
  assert.match(account.account_ref, UUID);
  assert.deepEqual([account.since_signup, account.consent], [true, "granted"]);
  assert.deepEqual(created!.body, {
    schema_version: 1, event_id: created!.id, name: "run_account_created", occurred_at: created!.body.occurred_at,
    source_app: "run", observed_by: "server", visitor_id: VISITOR, account_ref: account.account_ref,
    page_host: null, page_path: null, referrer_host: null, properties: { method: "github", auth_surface: "console" }, is_internal: false, analytics_consent: "granted",
  });
  assert.ok(Math.abs(Date.parse(created!.body.occurred_at) - Date.now()) < 60_000);

  // The same person again, from another browser, then through the MCP consent page with no visitor cookie at all.
  await signIn(browserOf(OTHER_VISITOR));
  await signIn(browserOf(null), "/oauth/authorize?client_id=x");
  const events = (await outbox()).map(row => row.body).filter(event => event.name !== "run_auth_started");
  assert.deepEqual(events.map(event => event.name), ["run_account_created", "run_signed_in", "run_signed_in"]);
  assert.deepEqual(events.slice(1).map(event => [event.visitor_id, event.account_ref, event.properties]), [
    [OTHER_VISITOR, account.account_ref, { method: "github", auth_surface: "console" }],
    [null, account.account_ref, { method: "github", auth_surface: "mcp" }],
  ]);
  assert.equal(new Set((await outbox()).map(row => row.id)).size, 6);
  assert.equal((await db.query("select signup_visitor from journey_accounts where tenant = 'octocat'")).rows[0].signup_visitor, VISITOR);
  // No event says who the account is: not its tenant id, its login or its name.
  assert.ok(!/octo/i.test(JSON.stringify(await outbox())));
});

test("signing out says which browser is no longer the account's", async t => {
  const { db, consoleAuth, signIn, outbox } = await setup(t);
  const session = await signIn();
  const logout = await consoleAuth.app.request("/console/auth/logout", { method: "POST", headers: { cookie: `${session}; ${browserOf()}`, [CONSOLE_HEADER]: "1", origin: ORIGIN } });
  assert.equal(logout.status, 200);
  const out = (await outbox()).map(row => row.body).find(event => event.name === "run_signed_out")!;
  assert.deepEqual([out.visitor_id, out.account_ref, out.properties], [VISITOR, (await db.query("select account_ref from journey_accounts")).rows[0].account_ref, {}]);
  // A sign-out with no session is nobody's.
  await consoleAuth.app.request("/console/auth/logout", { method: "POST", headers: { cookie: browserOf(), [CONSOLE_HEADER]: "1", origin: ORIGIN } });
  assert.equal((await outbox()).filter(row => row.body.name === "run_signed_out").length, 1);
});

test("a browser that refused, or sends Global Privacy Control, or has not answered, is not recorded", async t => {
  const { db, signIn, names, journey } = await setup(t);
  await journey!.reconcile();
  await signIn(`camel_consent=denied; camel_attribution_id=${VISITOR}`);
  await signIn(browserOf(), undefined, { "sec-gpc": "1" });
  await signIn(`camel_attribution_id=${VISITOR}`);
  await signIn(`camel_consent=maybe; camel_attribution_id=${VISITOR}`);
  assert.deepEqual(await names(), []);
  // The account exists, and journey knows not to send for it: a token it mints with a token says nothing either.
  assert.deepEqual((await db.query("select signup_visitor, consent from journey_accounts where tenant = 'octocat'")).rows, [{ signup_visitor: null, consent: "unknown" }]);
  await journey!.tokenCreated({ tenant: "octocat" });
  // Nor is its sign-up taken for a lost event and sent late.
  assert.equal(await journey!.reconcile(Date.now() + 3_600_000), 0);
  assert.deepEqual(await names(), []);
  // Agreeing later is recorded from then on; refusing again stops it.
  await signIn();
  assert.deepEqual(await names(), ["run_auth_started", "run_signed_in"]);
  await signIn(`camel_consent=denied; camel_attribution_id=${VISITOR}`);
  await journey!.tokenCreated({ tenant: "octocat" });
  assert.deepEqual(await names(), ["run_auth_started", "run_signed_in"]);
});

test("the operator may choose to record browsers that have not answered; a refusal still is not", async t => {
  const { signIn, names, outbox } = await setup(t, { journey: { collectUnknown: true } });
  await signIn(`camel_attribution_id=${VISITOR}`);
  assert.deepEqual((await names()).sort(), ["run_account_created", "run_auth_started"]);
  // Each says what the browser said, which was nothing: recorded by the operator's choice is not the same as agreed.
  assert.deepEqual((await outbox()).map(row => [row.body.visitor_id, row.body.analytics_consent]), [[VISITOR, "unknown"], [VISITOR, "unknown"]]);
  await signIn(`camel_consent=denied; camel_attribution_id=${VISITOR}`);
  assert.deepEqual((await names()).sort(), ["run_account_created", "run_auth_started"]);
});

test("a visitor cookie that is not a UUID is no visitor", async t => {
  const { signIn, outbox } = await setup(t);
  await signIn("camel_consent=granted; camel_attribution_id=octocat%40example.com");
  assert.deepEqual((await outbox()).map(row => row.body.visitor_id), [null, null]);
});

test("an account from before journey events were on gets its account_ref at its next sign-in, with no signup visitor", async t => {
  const { db, accounts, signIn, names } = await setup(t);
  await accounts.tenantForGithub({ login: "octocat", id: 583231, createdAt: 0 }, { minAccountAgeMs: 0 });
  await signIn();
  assert.deepEqual(await names(), ["run_auth_started", "run_signed_in"]);
  assert.deepEqual((await db.query("select signup_visitor, since_signup from journey_accounts where tenant = 'octocat'")).rows, [{ signup_visitor: null, since_signup: false }]);
});

test("a fault writing the event never loses the sign-up; the event is sent late, as of when the account was made and as its browser allowed", async t => {
  let broken = true;
  const { db, journey, signIn, outbox, names } = await setup(t, { journey: { internal: () => { if (broken) throw new Error("journey unavailable"); return false; } } });
  await journey!.reconcile();
  await signIn(browserOf(), "/oauth/authorize?client_id=x");
  const made = Number((await db.query("select created_at from tenants where id = 'octocat'")).rows[0].created_at);
  // The savepoint took the half-written journey rows with it, and what it takes to send the event late was noted aside.
  assert.equal((await db.query("select 1 from journey_accounts")).rowCount, 0);
  assert.deepEqual((await db.query("select tenant, consent, visitor, method, surface from journey_lost_signups")).rows, [{ tenant: "octocat", consent: "granted", visitor: VISITOR, method: "github", surface: "mcp" }]);
  assert.deepEqual(await names(), ["run_auth_started"]);
  // An account just made may be mid-sign-up; an older one with no row lost its event.
  broken = false;
  assert.equal(await journey!.reconcile(), 0);
  assert.equal(await journey!.reconcile(Date.now() + 3_600_000), 1);
  assert.equal(await journey!.reconcile(Date.now() + 3_600_000), 0);
  const created = (await outbox()).map(row => row.body).find(event => event.name === "run_account_created")!;
  assert.deepEqual([created.occurred_at, created.visitor_id, created.properties, created.analytics_consent], [new Date(made).toISOString(), VISITOR, { method: "github", auth_surface: "mcp" }, "granted"]);
  assert.deepEqual((await db.query("select since_signup, signup_visitor, consent from journey_accounts")).rows, [{ since_signup: true, signup_visitor: VISITOR, consent: "granted" }]);
  assert.equal((await db.query("select 1 from journey_lost_signups")).rowCount, 0);
});

test("sending a lost sign-up late never undoes a refusal, even where the unanswered are recorded", async t => {
  let broken = true;
  const { db, journey, signIn, names } = await setup(t, { journey: { collectUnknown: true, internal: () => { if (broken) throw new Error("journey unavailable"); return false; } } });
  await journey!.reconcile();
  await signIn(`camel_consent=denied; camel_attribution_id=${VISITOR}`);
  // The refusal was noted, and nothing of the browser with it.
  assert.deepEqual((await db.query("select consent, visitor from journey_lost_signups")).rows, [{ consent: "denied", visitor: null }]);
  broken = false;
  assert.equal(await journey!.reconcile(Date.now() + 3_600_000), 1);
  assert.deepEqual(await names(), []);
  assert.deepEqual((await db.query("select consent from journey_accounts")).rows, [{ consent: "denied" }]);
  await journey!.tokenCreated({ tenant: "octocat" });
  assert.deepEqual(await names(), []);
});

test("a lost sign-up of which nothing was noted is counted and never sent: its browser may have refused", async t => {
  const { db, journey, names } = await setup(t, { journey: { collectUnknown: true } });
  await journey!.reconcile();
  await db.query("insert into tenants (id, github, github_id, created_at) values ('u-late', 'late', 77, $1)", [Date.now()]);
  assert.equal(await journey!.reconcile(Date.now() + 3_600_000), 1);
  assert.deepEqual((await db.query("select consent, since_signup from journey_accounts")).rows, [{ consent: "lost", since_signup: true }]);
  // Nor is anything else, until a browser of the account's says.
  await journey!.tokenCreated({ tenant: "u-late" });
  assert.deepEqual(await names(), []);
  await journey!.signedIn({ tenant: "u-late", method: "github", surface: "console", browser: AGREED });
  await journey!.tokenCreated({ tenant: "u-late" });
  assert.deepEqual(await names(), ["run_signed_in", "run_token_created"]);
});

test("accounts from before journey events were first on are not sent as new sign-ups", async t => {
  const { accounts, journey, names } = await setup(t);
  await accounts.tenantForGithub({ login: "octocat", id: 583231, createdAt: 0 }, { minAccountAgeMs: 0 });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await journey!.reconcile(), 0);
  assert.equal(await journey!.reconcile(Date.now() + 3_600_000), 0);
  assert.deepEqual(await names(), []);
});

test("is_first is the account's first token: exact for an account journey saw made, and for an older one only if it has no other", async t => {
  const { accounts, journey, signIn, outbox } = await setup(t, { journey: { collectUnknown: true } });
  const tokens = async () => (await outbox()).filter(row => row.body.name === "run_token_created").map(row => [row.body.properties, row.body.visitor_id]);
  await signIn();
  await journey!.tokenCreated({ tenant: "octocat", browser: AGREED });
  await journey!.tokenCreated({ tenant: "octocat" });
  assert.deepEqual(await tokens(), [[{ is_first: true }, VISITOR], [{ is_first: false }, null]]);

  // An older account that already had a token: its next is not its first.
  await accounts.tenantForGoogle({ sub: "google-sub-1", email: "old@elsewhere.test" });
  const old = (await accounts.db.query("select id from tenants where google_sub = 'google-sub-1'")).rows[0].id;
  await accounts.createToken(old, "earlier");
  await accounts.createToken(old, "now");
  await journey!.tokenCreated({ tenant: old });
  assert.deepEqual((await tokens()).at(-1), [{ is_first: false }, null]);
});

test("a staff account stays internal in every later event, whatever that event knows of it", async t => {
  const { db, journey, outbox } = await setup(t, { internalDomains: ["example.com"], journey: { collectUnknown: true } });
  await transaction(db, sql => journey!.accountCreated(sql, { tenant: "u-staff", method: "google", surface: "console", browser: AGREED, email: "ada@example.com" }));
  await transaction(db, sql => journey!.accountCreated(sql, { tenant: "u-customer", method: "google", surface: "console", browser: AGREED, email: "bo@elsewhere.test" }));
  // No address comes with these.
  for (const tenant of ["u-staff", "u-customer"]) {
    await journey!.tokenCreated({ tenant });
    await journey!.signedOut({ tenant, browser: AGREED });
  }
  const refs = Object.fromEntries((await db.query("select tenant, account_ref from journey_accounts")).rows.map(row => [row.account_ref, row.tenant]));
  const events = (await outbox()).map(row => row.body);
  assert.equal(events.length, 6);
  for (const event of events) assert.equal(event.is_internal, refs[event.account_ref!] === "u-staff", `${event.name} of ${refs[event.account_ref!]}`);
  assert.ok(!JSON.stringify(events).includes("@"));
});

test("events are delivered signed, one per request, and leave the outbox once the store names them", async t => {
  const store = await fakeStore(t);
  const { journey, signIn, outbox } = await setup(t, { store: store.url });
  await signIn();
  await signIn();
  const queued = await outbox();
  assert.equal(queued.length, 4);
  await journey!.send();
  assert.equal((await outbox()).length, 0);
  assert.deepEqual(store.deliveries.map(delivery => [delivery.id, delivery.events.length]).sort(), queued.map(row => [row.id, 1]).sort());
  assert.deepEqual(store.deliveries.map(delivery => delivery.events[0]!.event_id).sort(), queued.map(row => row.id).sort());
  assert.deepEqual(await journey!.backlog(), { pending: 0, rejected: 0, oldestAgeMs: 0 });
});

test("a 200 that does not name the event is not the store's word: the event is kept and sent again", async t => {
  const replies = [{ status: 200, body: "<html>Welcome</html>" }, { status: 200, body: "{}" }, { status: 200, body: JSON.stringify({ accepted: ["00000000-0000-4000-8000-000000000000"] }) }];
  const store = await fakeStore(t, delivery => replies[delivery] ?? 200);
  const { db, journey, outbox } = await setup(t, { store: store.url, journey: { collectUnknown: true } });
  await transaction(db, sql => journey!.accountCreated(sql, { tenant: "u-one", method: "google", surface: "console", browser: AGREED }));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await journey!.send();
    const [row] = await outbox();
    assert.deepEqual([row!.attempts, row!.last_error, row!.rejected_at], [attempt, "not acknowledged", null]);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await journey!.send();
  assert.equal((await outbox()).length, 0);
  assert.equal(store.deliveries.length, 1);
});

test("a store that is down, or refuses the signature, is tried again with the same event id until it answers", async t => {
  const store = await fakeStore(t, delivery => [503, 401, 429, 200][delivery] ?? 200);
  const { db, journey, outbox } = await setup(t, { store: store.url, journey: { collectUnknown: true } });
  await transaction(db, sql => journey!.accountCreated(sql, { tenant: "u-one", method: "google", surface: "console", browser: AGREED }));
  const [queued] = await outbox();
  for (const [attempts, error] of [[1, "HTTP 503"], [2, "HTTP 401"], [3, "HTTP 429"]] as const) {
    await journey!.send();
    const [row] = await outbox();
    assert.deepEqual([row!.id, row!.attempts, row!.last_error, row!.rejected_at], [queued!.id, attempts, error, null]);
    assert.equal(store.deliveries.length, 0);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await journey!.send();
  assert.equal((await outbox()).length, 0);
  assert.deepEqual(store.deliveries.map(delivery => delivery.id), [queued!.id]);
});

test("an unreachable store keeps the event; sign-in does not wait on it", async t => {
  const { journey, signIn, outbox } = await setup(t);
  await signIn();
  await journey!.send();
  for (const row of await outbox()) {
    assert.equal(row.attempts, 1);
    assert.ok(row.last_error);
  }
  assert.equal((await journey!.backlog()).pending, 2);
});

test("an event the store refuses as invalid is kept and offered again a day later, when the store may have learned to read it", async t => {
  let learned = false;
  const store = await fakeStore(t, () => learned ? 200 : 422);
  const { db, journey, outbox } = await setup(t, { store: store.url, journey: { collectUnknown: true } });
  await transaction(db, sql => journey!.accountCreated(sql, { tenant: "u-one", method: "google", surface: "console", browser: AGREED }));
  await journey!.send();
  await new Promise(resolve => setTimeout(resolve, 20));
  await journey!.send();
  await journey!.send(Date.now() + 23 * 3_600_000);
  const [row] = await outbox();
  assert.deepEqual([row!.attempts, row!.last_error], [1, "HTTP 422"]);
  assert.ok(row!.rejected_at);
  assert.deepEqual(await journey!.backlog().then(backlog => [backlog.pending, backlog.rejected]), [1, 1]);
  learned = true;
  await journey!.send(Date.now() + 25 * 3_600_000);
  assert.equal((await outbox()).length, 0);
  assert.equal(store.deliveries.length, 1);
});

test("deleting an account removes what journey kept of it and tells the store, once, with the account's real age", async t => {
  const { db, journey, signIn, outbox } = await setup(t);
  await signIn();
  await journey!.tokenCreated({ tenant: "octocat", browser: AGREED });
  await db.query("update tenants set created_at = created_at - $1 where id = 'octocat'", [3 * 86_400_000 + 60_000]);
  const accountRef = (await db.query("select account_ref from journey_accounts where tenant = 'octocat'")).rows[0].account_ref;
  await transaction(db, sql => deleteJourneyAccount(sql, "octocat"));
  await transaction(db, sql => deleteJourneyAccount(sql, "octocat"));
  for (const table of ["journey_accounts", "journey_milestones"]) assert.equal((await db.query(`select 1 from ${table}`)).rowCount, 0, table);
  // What was still to send about the account went with it; the deletion is left, naming no visitor (and what no account ever was part of).
  const rows = (await outbox()).filter(row => row.body.name !== "run_auth_started");
  assert.deepEqual(rows.map(row => [row.body.name, row.body.account_ref, row.body.visitor_id, row.body.properties]), [["run_account_deleted", accountRef, null, { days_since_signup: 3 }]]);
});

test("a deletion waits for the store however long it takes: never dropped for age, never given up on as refused", async t => {
  let ready = false;
  const store = await fakeStore(t, (_delivery, event) => event.name === "run_account_deleted" && !ready ? 503 : event.name === "run_account_deleted" ? 200 : 422);
  const { db, journey, signIn, outbox, names } = await setup(t, { store: store.url });
  await signIn();
  await transaction(db, sql => deleteJourneyAccount(sql, "octocat"));
  await signIn(browserOf(OTHER_VISITOR));
  await db.query("update journey_outbox set created_at = created_at - $1", [31 * 86_400_000]);
  await journey!.send();
  // Everything else that old is dropped; the deletion is tried, and kept.
  assert.deepEqual(await names(), ["run_account_deleted"]);
  // A store that calls it invalid is asked again too.
  const refusing = new Journey({ db, url: (await fakeStore(t, () => 422)).url, secret: SECRET, retryBaseMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  await refusing.send();
  const [row] = await outbox();
  assert.deepEqual([row!.body.name, row!.last_error, row!.rejected_at], ["run_account_deleted", "HTTP 422", null]);
  ready = true;
  await new Promise(resolve => setTimeout(resolve, 20));
  await journey!.send();
  assert.deepEqual(await names(), []);
  assert.deepEqual(store.deliveries.map(delivery => delivery.events[0]!.name), ["run_account_deleted"]);
});

test("deleting an account still queues its deletion for the store when journey events are no longer configured", async t => {
  const { db, signIn, names } = await setup(t);
  await signIn();
  // As the deletion does it, with no Journey in hand.
  await transaction(db, sql => deleteJourneyAccount(sql, "octocat"));
  assert.equal((await db.query("select 1 from journey_accounts")).rowCount, 0);
  assert.deepEqual((await names()).filter(name => name !== "run_auth_started"), ["run_account_deleted"]);
  // An account journey never knew leaves nothing.
  await transaction(db, sql => deleteJourneyAccount(sql, "nobody"));
  assert.equal((await names()).filter(name => name === "run_account_deleted").length, 1);
});

test("a console page is known by its route, never by an address with an id in it", () => {
  for (const [path, route] of [
    ["/console", "/console"], ["/console/", "/console"], ["/console/agents", "/console/agents"], ["/console/agents/", "/console/agents"],
    ["/console/agents/client_0123456789abcdef", "/console/agents/:agent_id"], ["/console/agents/my%20secret%20project", "/console/agents/:agent_id"],
    ["/console/volumes/vol_abc", "/console/volumes/:volume_id"], ["/console/billing/confirm", "/console/billing/confirm"],
    ["/console/agents/client_1/files/notes.txt", "/console/*"], ["/console/tokens/art_secret", "/console/*"], ["/console/nowhere", "/console/*"], ["/elsewhere", "/console/*"],
  ] as const) assert.equal(consoleRoute(path), route, path);
});

test("a browser that comes here first is given its visitor id, and the store is told where it came from", async t => {
  const { arrive, outbox, touches } = await setup(t);
  const { setCookie } = await arrive("/console/agents/client_abc?utm_source=newsletter&utm_campaign=launch&email=ada%40example.com&token=art_secret", { referer: "https://news.ycombinator.com/item?id=1" });
  const visitor = /^camel_attribution_id=([0-9a-f-]{36}); Domain=example\.test; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Lax$/.exec(setCookie!)?.[1];
  assert.match(visitor!, UUID);
  const [arrived] = await outbox();
  assert.deepEqual([arrived!.body.name, arrived!.body.visitor_id, arrived!.body.account_ref, arrived!.body.properties, arrived!.body.analytics_consent],
    ["run_arrived", visitor, null, { entry_channel: "other_referral", landing_path: "/console/agents/:agent_id" }, "granted"]);
  // The touch: the page as its route, the other site's host, and of the query only what names a campaign.
  const [touch] = await touches();
  assert.deepEqual(touch, { attribution_id: visitor, touch: { page_host: "run.example.test", page_path: "/console/agents/:agent_id", referrer_host: "news.ycombinator.com", campaign: { utm_source: "newsletter", utm_campaign: "launch" }, occurred_at: arrived!.body.occurred_at } });
  assert.ok(!/ada|art_secret|client_abc|item/.test(JSON.stringify([await outbox(), await touches()])));
});

test("how a browser arrived is told from its link and where it came from; a reload or a return visit is no arrival", async t => {
  const { arrive, outbox, touches } = await setup(t);
  const known = { cookie: browserOf() };
  const handoff = "0c7d0a52-3f0e-4a55-8a0d-7f7a7a1b2c3d";
  // Reloading, or coming back with nothing to say where from.
  assert.deepEqual(await arrive("/console/", known), {});
  assert.deepEqual(await arrive("/console/tokens", { ...known, referer: "https://run.example.test/console/" }), {});
  assert.equal((await outbox()).length, 0);
  for (const [path, referer, entry] of [
    [`/console/?camel_handoff=${handoff}`, "https://example.test/run", "sales_site_link"],
    [`/console/?camel_handoff=${handoff}`, undefined, "sales_site_link"],
    ["/console/", "https://www.example.test/pricing", "sales_site_link"],
    ["/console/", "https://example.test/docs/camelrun/quickstart", "docs"],
    ["/console/", "https://github.com/qaml-ai/run", "github"],
    ["/console/", "https://www.google.co.uk/", "search"],
    ["/console/", "https://chatgpt.com/", "ai_assistant"],
    ["/console/", "https://blog.elsewhere.test/post", "other_referral"],
  ] as const) {
    // A browser the operator's site already knows is not given another id.
    assert.deepEqual(await arrive(path, { ...known, ...(referer ? { referer } : {}) }), {}, `${path} from ${referer}`);
    const event = (await outbox()).at(-1)!.body;
    assert.deepEqual([event.name, event.visitor_id, event.properties], ["run_arrived", VISITOR, { entry_channel: entry, landing_path: "/console", ...(path.includes("camel_handoff") ? { handoff_id: handoff } : {}) }], `${path} from ${referer}`);
  }
  // A handoff id that is not one is no handoff.
  assert.deepEqual(await arrive("/console/?camel_handoff=not-a-uuid", known), {});
  // Our own site's link says nothing new about where the visitor came from: only other sites' touches go to the store.
  assert.deepEqual((await touches()).map(touch => touch.touch.referrer_host), ["github.com", "www.google.co.uk", "chatgpt.com", "blog.elsewhere.test"]);
});

test("nothing is noted, and no cookie set, for a browser that has not agreed, a program, or a page loaded ahead of time", async t => {
  const { arrive, outbox, touches, journey } = await setup(t);
  const from = { referer: "https://github.com/qaml-ai/run" };
  for (const headers of [
    { ...from, cookie: "camel_consent=denied" }, { ...from, cookie: "" }, { ...from, "sec-gpc": "1" },
    { ...from, "user-agent": "curl/8.7.1" }, { ...from, "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" }, { ...from, "user-agent": "" },
    { ...from, "sec-fetch-dest": "empty" }, { ...from, "sec-purpose": "prefetch;prerender" },
  ]) assert.deepEqual(await arrive("/console/", headers), {}, JSON.stringify(headers));
  assert.deepEqual(await journey!.arrival(new Request("http://internal/console/", { method: "POST", headers: { "user-agent": CHROME, cookie: "camel_consent=granted", ...from } })), {});
  assert.equal((await outbox()).length + (await touches()).length, 0);
});

test("the console's pages are kept as routes, for the visitor in the cookie and the account in the session, whatever the request says", async t => {
  const { db, journey, consoleAuth, signIn, outbox } = await setup(t);
  const app = journeyApp(journey!, consoleAuth);
  const session = await signIn();
  const accountRef = (await db.query("select account_ref from journey_accounts")).rows[0].account_ref;
  const post = (events: unknown[], cookie: string, headers: Record<string, string> = {}) => app.request("/api/journey/events", {
    method: "POST", headers: { "content-type": "application/json", cookie, [CONSOLE_HEADER]: "1", origin: ORIGIN, ...headers }, body: JSON.stringify({ schema_version: 1, events }),
  });
  const page = (path: string, more: Record<string, unknown> = {}) => ({ event_id: crypto.randomUUID(), name: "page_viewed", occurred_at: new Date().toISOString(), page_path: path, referrer_host: null, ...more });
  const pages = async () => (await outbox()).map(row => row.body).filter(event => event.name === "page_viewed").sort((a, b) => a.page_path!.localeCompare(b.page_path!));

  // Signed out: the visitor alone. Google Analytics' id for the browser goes along, from its own cookie.
  const first = page("/console/", { referrer_host: "github.com" });
  let reply = await post([first], `${browserOf()}; _ga=GA1.1.1234567890.1700000000`);
  assert.deepEqual([reply.status, await reply.json()], [200, { accepted: [first.event_id], rejected: [] }]);
  // Signed in: the account too. Sent again, it is accepted again and kept once.
  const second = page("/console/agents/client_0123456789abcdef"), third = page("/console/tokens");
  reply = await post([second, third], `${session}; ${browserOf()}`);
  assert.deepEqual(await reply.json(), { accepted: [second.event_id, third.event_id], rejected: [] });
  await post([second], `${session}; ${browserOf()}`);
  assert.deepEqual((await pages()).map(event => [event.event_id, event.page_host, event.page_path, event.referrer_host, event.visitor_id, event.account_ref, event.observed_by, event.ga_client_id]), [
    [first.event_id, "run.example.test", "/console", "github.com", VISITOR, null, "browser", "1234567890.1700000000"],
    [second.event_id, "run.example.test", "/console/agents/:agent_id", null, VISITOR, accountRef, "browser", undefined],
    [third.event_id, "run.example.test", "/console/tokens", null, VISITOR, accountRef, "browser", undefined],
  ]);
  assert.deepEqual((await pages())[0]!.properties, { page_type: "console", product_context: "run" });
  assert.equal((await pages())[1]!.occurred_at, second.occurred_at);

  // What a page may not say, or claim to be.
  const bad = [
    page("/console/", { visitor_id: OTHER_VISITOR }), page("/console/", { account_ref: accountRef }), page("/console/", { name: "run_account_created" }),
    page("/elsewhere"), page("/console/", { occurred_at: new Date(Date.now() + 3_600_000).toISOString() }), page("/console/", { occurred_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
    page("/console/", { referrer_host: "https://github.com/x?y=1" }), page("/console/", { event_id: "nope" }), page("/console/", { properties: { page_type: "homepage" } }),
  ];
  reply = await post(bad, browserOf());
  assert.deepEqual((await reply.json()).rejected.map((refusal: { reason: string }) => refusal.reason),
    ["unknown_field", "unknown_field", "unknown_name", "invalid_path", "invalid_timestamp", "invalid_timestamp", "invalid_referrer", "invalid_event_id", "unknown_field"]);
  assert.equal((await pages()).length, 3);
  assert.ok(!/client_0123|octo/.test(JSON.stringify(await pages())));

  // Not from a page of ours, not a batch, too many, and a browser that refused.
  assert.equal((await post([page("/console/")], browserOf(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await app.request("/api/journey/events", { method: "POST", headers: { cookie: browserOf(), origin: ORIGIN }, body: "{}" })).status, 403);
  assert.equal((await post([], browserOf())).status, 400);
  assert.equal((await post(Array.from({ length: 21 }, () => page("/console/")), browserOf())).status, 400);
  assert.equal((await app.request("/api/journey/events", { method: "POST", headers: { cookie: browserOf(), [CONSOLE_HEADER]: "1", origin: ORIGIN }, body: "not json" })).status, 400);
  reply = await post([page("/console/")], `${session}; camel_consent=denied; camel_attribution_id=${VISITOR}`);
  assert.deepEqual(await reply.json(), { accepted: [], rejected: [], collecting: false });
  assert.equal((await pages()).length, 3);
});

test("touches are delivered signed to the store's attribution endpoint, and leave once it names the visitor", async t => {
  const store = await fakeStore(t);
  const { journey, arrive, touches, outbox } = await setup(t, { store: store.url });
  await arrive("/console/", { referer: "https://github.com/qaml-ai/run" });
  const [queued] = await touches();
  await journey!.send();
  assert.equal((await touches()).length + (await outbox()).length, 0);
  assert.deepEqual(store.touches, [queued]);
  assert.deepEqual(store.deliveries.map(delivery => delivery.events[0]!.name), ["run_arrived"]);
});

test("an account an operator made is told of once, with no visitor, and only where the unanswered are recorded", async t => {
  const { journey, names } = await setup(t);
  await journey!.accountProvisioned("acme");
  assert.deepEqual(await names(), []);
  const lenient = await setup(t, { journey: { collectUnknown: true } });
  await lenient.journey!.accountProvisioned("acme");
  await lenient.journey!.accountProvisioned("acme");
  const rows = await lenient.outbox();
  assert.deepEqual(rows.map(row => [row.body.name, row.body.visitor_id, row.body.properties, row.body.analytics_consent]), [["run_account_provisioned", null, {}, "unknown"]]);
  // Nobody signed up: it is no sign-up to send late either.
  assert.equal(await lenient.journey!.reconcile(Date.now() + 3_600_000), 0);
});

test("a new agent says how it was made and whether it is the account's first", async t => {
  const { db, accounts, journey, signIn, outbox } = await setup(t);
  const agents = async () => (await outbox()).filter(row => row.body.name === "run_agent_created").map(row => [row.body.properties, row.body.visitor_id]);
  await signIn();
  await journey!.agentCreated({ tenant: "octocat", via: "console", browser: AGREED });
  await journey!.agentCreated({ tenant: "octocat", via: "mcp" });
  await journey!.agentCreated({ tenant: "octocat", via: "api" });
  assert.deepEqual(await agents(), [[{ is_first: true, created_via: "console" }, VISITOR], [{ is_first: false, created_via: "mcp" }, null], [{ is_first: false, created_via: "api" }, null]]);
  // An older account with agents already: its next is not its first. A browser that refused is not recorded.
  await accounts.tenantForGoogle({ sub: "google-sub-1", email: "old@elsewhere.test" });
  const old = (await db.query("select id from tenants where google_sub = 'google-sub-1'")).rows[0].id;
  await journey!.signedIn({ tenant: old, method: "google", surface: "console", browser: AGREED });
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ('client_a', $1, '{}', 1, 'a', 't', 'm'), ('client_b', $1, '{}', 1, 'b', 't', 'm')", [old]);
  await journey!.agentCreated({ tenant: old, via: "api" });
  assert.deepEqual((await agents()).at(-1), [{ is_first: false, created_via: "api" }, null]);
  await journey!.agentCreated({ tenant: old, via: "console", browser: { visitor: null, consent: "denied", collect: false } });
  assert.equal((await agents()).length, 4);
});

test("runs mark the account's day once, and its first completed run once, however many there are and whichever node sees them", async t => {
  const { db, journey, signIn, outbox } = await setup(t);
  const runs = async () => (await outbox()).filter(row => /^run_(active_day|first_execution)/.test(row.body.name)).map(row => [row.body.name, row.body.properties, row.body.visitor_id]);
  await signIn();
  await db.query("update tenants set created_at = $1 where id = 'octocat'", [Date.parse("2026-10-05T10:00:00Z")]);
  const at = (time: string) => Date.parse(`2026-10-05T${time}Z`);
  // A run that failed, or stopped short, is activity but not the first completed run.
  await journey!.runEnded("octocat", { completed: false, at: at("10:01:00") });
  await journey!.runEnded("octocat", { completed: false, at: at("10:02:00") });
  assert.deepEqual(await runs(), [["run_active_day", { activity_date: "2026-10-05" }, null]]);
  for (let run = 0; run < 5; run++) await journey!.runEnded("octocat", { completed: true, at: at("10:05:00") + run * 1000 });
  assert.deepEqual(await runs(), [["run_active_day", { activity_date: "2026-10-05" }, null], ["run_first_execution_completed", { seconds_since_signup: 300 }, null]]);
  // Another node, which remembers nothing, sees later runs of the same day and of the next.
  const other = new Journey({ db, url: "http://127.0.0.1:9", secret: SECRET, consentCookie: "camel_consent" });
  await other.runEnded("octocat", { completed: true, at: at("23:59:59") });
  await other.runEnded("octocat", { completed: true, at: Date.parse("2026-10-06T00:00:01Z") });
  await other.runEnded("octocat", { completed: true, at: Date.parse("2026-10-06T08:00:00Z") });
  assert.deepEqual((await runs()).map(run => [run[0], (run[1] as { activity_date?: string }).activity_date]).sort(), [["run_active_day", "2026-10-05"], ["run_active_day", "2026-10-06"], ["run_first_execution_completed", undefined]]);
  // Once a node knows the day is marked and the first run behind it, a run costs the database nothing.
  const queries: string[] = [];
  const watched = new Journey({ db: { connect: async () => { queries.push("connect"); return db.connect(); }, query: (...args: unknown[]) => { queries.push("query"); return (db.query as Function)(...args); } } as never, url: "http://127.0.0.1:9", secret: SECRET });
  await watched.runEnded("octocat", { completed: true, at: Date.parse("2026-10-06T09:00:00Z") });
  const first = queries.length;
  for (let run = 0; run < 20; run++) await watched.runEnded("octocat", { completed: true, at: Date.parse("2026-10-06T09:00:00Z") + run });
  assert.ok(first > 0 && queries.length === first, `${queries.length - first} more database calls for 20 runs`);
});

test("an account from before journey events has no first run to tell of, and one whose browser refused has no runs told at all", async t => {
  const { accounts, journey, signIn, names } = await setup(t);
  await accounts.tenantForGithub({ login: "octocat", id: 583231, createdAt: 0 }, { minAccountAgeMs: 0 });
  await signIn();
  await journey!.runEnded("octocat", { completed: true });
  assert.deepEqual((await names()).filter(name => name.startsWith("run_active") || name.startsWith("run_first")), ["run_active_day"]);
  await signIn(`camel_consent=denied; camel_attribution_id=${VISITOR}`);
  const fresh = new Journey({ db: accounts.db, url: "http://127.0.0.1:9", secret: SECRET, consentCookie: "camel_consent" });
  await fresh.runEnded("octocat", { completed: true, at: Date.now() + 2 * 86_400_000 });
  assert.equal((await names()).filter(name => name === "run_active_day").length, 1);
});

test("what an account does away from a browser carries Google Analytics' id for its last browser that agreed, and none once one refuses", async t => {
  const { db, journey, signIn, outbox } = await setup(t);
  const ga = "_ga=GA1.1.1234567890.1700000000";
  const ids = async () => (await outbox()).map(row => [row.body.name, row.body.ga_client_id ?? null]);
  await signIn(`${browserOf()}; ${ga}`);
  await journey!.tokenCreated({ tenant: "octocat" });
  await journey!.runEnded("octocat", { completed: true });
  await transaction(db, sql => journey!.creditPurchased(sql, { tenant: "octocat", amountMinor: 1000, payment: "pi_one" }));
  assert.deepEqual((await ids()).sort(), [
    ["run_account_created", "1234567890.1700000000"], ["run_active_day", "1234567890.1700000000"], ["run_auth_started", "1234567890.1700000000"],
    ["run_credit_purchased", "1234567890.1700000000"], ["run_first_execution_completed", "1234567890.1700000000"], ["run_token_created", "1234567890.1700000000"],
  ]);
  assert.equal((await db.query("select ga_client_id from journey_accounts")).rows[0].ga_client_id, "1234567890.1700000000");
  // A later browser that agreed but has no Google cookie leaves the kept id; one that says another id replaces it.
  await signIn(browserOf(OTHER_VISITOR));
  await signIn(`${browserOf()}; _ga=GA1.2.99.88`);
  await transaction(db, sql => journey!.creditPurchased(sql, { tenant: "octocat", amountMinor: 1000, payment: "pi_two" }));
  assert.deepEqual((await ids()).filter(id => id[0] === "run_signed_in" || id[0] === "run_credit_purchased").map(id => id[1]), ["1234567890.1700000000", "1234567890.1700000000", "99.88", "99.88"]);
  // A refusal forgets it, and agreeing again does not bring the old one back.
  await signIn(`camel_consent=denied; camel_attribution_id=${VISITOR}; ${ga}`);
  assert.equal((await db.query("select ga_client_id from journey_accounts")).rows[0].ga_client_id, null);
  await signIn(browserOf());
  await transaction(db, sql => journey!.creditPurchased(sql, { tenant: "octocat", amountMinor: 1000, payment: "pi_three" }));
  assert.equal((await ids()).at(-1)![1], null);
  // What is not Google's id is not passed along as one.
  await signIn(`${browserOf()}; _ga=octocat@example.com`);
  assert.equal((await db.query("select ga_client_id from journey_accounts")).rows[0].ga_client_id, null);
});

test("a source may report so many pages a minute and no more; others, and the next minute, are not held up", async t => {
  const { journey, consoleAuth, outbox } = await setup(t);
  let now = Date.parse("2026-10-05T12:00:00Z"), from = "203.0.113.5";
  const app = journeyApp(journey!, consoleAuth, () => from, () => now);
  const post = (pages: number) => app.request("/api/journey/events", {
    method: "POST", headers: { "content-type": "application/json", cookie: browserOf(), [CONSOLE_HEADER]: "1", origin: ORIGIN },
    body: JSON.stringify({ schema_version: 1, events: Array.from({ length: pages }, () => ({ event_id: crypto.randomUUID(), name: "page_viewed", occurred_at: new Date().toISOString(), page_path: "/console/", referrer_host: null })) }),
  });
  for (let batch = 0; batch < 6; batch++) assert.equal((await post(20)).status, 200);
  const refused = await post(1);
  assert.deepEqual([refused.status, await refused.json(), refused.headers.get("retry-after")], [429, { error: "rate_limited" }, "60"]);
  now += 20_000;
  assert.equal((await post(1)).headers.get("retry-after"), "40");
  assert.equal((await outbox()).length, 120);
  // Another source is its own count, and a minute on the first may report again.
  from = "203.0.113.6";
  assert.equal((await post(5)).status, 200);
  from = "203.0.113.5";
  now += 41_000;
  assert.equal((await post(5)).status, 200);
  assert.equal((await outbox()).length, 130);
  // A request that is not ours to answer is not counted against anyone.
  const forbidden = await app.request("/api/journey/events", { method: "POST", headers: { origin: "https://evil.example", [CONSOLE_HEADER]: "1" }, body: "{}" });
  assert.equal(forbidden.status, 403);
});

test("a refusal is told to the store, naming the account and the browser and nothing else: when an account turns to refusing, and at each sign-in that still does", async t => {
  const { db, journey, consoleAuth, signIn, names, refusals } = await setup(t);
  const session = await signIn();
  const accountRef = (await db.query("select account_ref from journey_accounts")).rows[0].account_ref;
  assert.deepEqual(await refusals(), []);
  const app = journeyApp(journey!, consoleAuth);
  const view = (cookie: string, headers: Record<string, string> = {}) => app.request("/api/journey/events", {
    method: "POST", headers: { "content-type": "application/json", cookie, [CONSOLE_HEADER]: "1", origin: ORIGIN, ...headers },
    body: JSON.stringify({ schema_version: 1, events: [{ event_id: crypto.randomUUID(), name: "page_viewed", occurred_at: new Date().toISOString(), page_path: "/console/", referrer_host: null }] }),
  });
  // The signed-in browser now refuses: the first page it reports says so to the account, and so to the store, once.
  const refusing = `${session}; camel_consent=denied; camel_attribution_id=${VISITOR}`;
  for (let page = 0; page < 3; page++) assert.deepEqual(await (await view(refusing)).json(), { accepted: [], rejected: [], collecting: false });
  const [told, ...more] = await refusals();
  assert.equal(more.length, 0);
  assert.deepEqual([told!.schema_version, told!.account_ref, told!.column, told!.visitor_id, told!.consent, told!.control_id], [1, accountRef, accountRef, VISITOR, "denied", told!.id]);
  assert.ok(Math.abs(Date.parse(told!.decided_at) - Date.now()) < 60_000);
  assert.deepEqual(Object.keys(told!).sort(), ["account_ref", "column", "consent", "control_id", "decided_at", "id", "schema_version", "visitor_id"]);
  assert.equal((await db.query("select consent from journey_accounts")).rows[0].consent, "denied");
  // Nothing of the refusing browser is recorded as activity.
  assert.deepEqual((await names()).filter(name => name === "page_viewed"), []);
  // Signing in again while refusing says it again (Global Privacy Control this time, from a browser with no visitor id); agreeing says nothing.
  await signIn("camel_consent=granted", undefined, { "sec-gpc": "1" });
  assert.deepEqual((await refusals()).map(refusal => [refusal.account_ref, refusal.visitor_id]), [[accountRef, VISITOR], [accountRef, null]]);
  await signIn();
  await signIn();
  assert.equal((await refusals()).length, 2);
  // A browser that has not answered is not a refusal.
  await signIn(`camel_attribution_id=${VISITOR}`);
  assert.equal((await refusals()).length, 2);
});

test("word of a refusal is delivered signed and waits for the store however long it takes: never dropped for age, never set aside as refused", async t => {
  let status = 422;
  const store = await fakeStore(t, () => 200, () => status);
  const { db, journey, signIn, refusals } = await setup(t, { store: store.url });
  await signIn(`camel_consent=denied; camel_attribution_id=${VISITOR}`);
  await db.query("update journey_outbox set created_at = created_at - $1", [31 * 86_400_000]);
  await journey!.send();
  const [waiting] = (await db.query("select attempts, last_error, rejected_at from journey_outbox where target = 'consent'")).rows;
  assert.deepEqual([waiting.attempts, waiting.last_error, waiting.rejected_at], [1, "HTTP 422", null]);
  status = 200;
  await new Promise(resolve => setTimeout(resolve, 20));
  await journey!.send();
  assert.deepEqual(await refusals(), []);
  assert.deepEqual(store.refusals.map(refusal => [refusal.visitor_id, refusal.consent]), [[VISITOR, "denied"]]);
  // No event went with it: the sign-up of a browser that refused is not activity.
  assert.deepEqual(store.deliveries, []);
});
