import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { ADMIN_REPORT_PATH } from "../src/admin-report.ts";
import { adminDays, adminSignals, adminToday } from "../src/admin-signals.ts";
import { adminSite, adminSiteFromEnvironment, type AdminSiteOptions } from "../src/admin-site.ts";
import type { Sql } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { listen, type T } from "./runtime-server.ts";

const HOST = "admin.example.test";
const TEAM = "https://fixture.cloudflareaccess.example";
const AUD = "fixture-access-audience";
const ADMIN = "isabella@example.test";
const EVENT_SECRET = `whsec_${Buffer.from("admin-test-event-signing-key-0123").toString("base64")}`;
const REPORT_SECRET = `whsec_${Buffer.from("admin-test-report-signing-key-012").toString("base64")}`;
const ACCOUNT = "3f2b8a6e-1c4d-4e5f-8a9b-0c1d2e3f4a5b";
const CHICAGO = "America/Chicago";
const at = (iso: string) => Date.parse(iso);
const range = (start_date: string, end_date = start_date, time_zone = CHICAGO) => ({ start_date, end_date, time_zone });

test("a calendar day starts where its zone says, across daylight-saving changes", () => {
  // Clocks go forward on 8 March 2026 (a 23-hour day) and back on 1 November (25 hours).
  const spring = adminDays(range("2026-03-07", "2026-03-09"));
  assert.deepEqual(spring.dates, ["2026-03-07", "2026-03-08", "2026-03-09"]);
  assert.deepEqual(spring.boundaries.map(instant => new Date(instant).toISOString()),
    ["2026-03-07T06:00:00.000Z", "2026-03-08T06:00:00.000Z", "2026-03-09T05:00:00.000Z", "2026-03-10T05:00:00.000Z"]);
  const autumn = adminDays(range("2026-11-01"));
  assert.equal(autumn.boundaries[1] - autumn.boundaries[0], 25 * 3_600_000);
  assert.deepEqual(adminDays(range("2026-06-01", "2026-06-01", "UTC")).boundaries, [at("2026-06-01T00:00:00Z"), at("2026-06-02T00:00:00Z")]);
  // Late evening in Chicago is already tomorrow in UTC.
  assert.equal(adminToday(CHICAGO, at("2026-07-01T03:30:00Z")), "2026-06-30");

  const refused = (value: Parameters<typeof adminDays>[0], code: string, status: number) =>
    assert.throws(() => adminDays(value), (error: any) => error.message === code && error.status === status);
  refused(range("2026-02-30"), "invalid_date", 400);
  refused(range("2026-3-1"), "invalid_date", 400);
  refused(range("2026-03-02", "2026-03-01"), "invalid_range", 400);
  refused(range("2026-03-01", "2026-03-01", "Mars/Olympus"), "invalid_time_zone", 400);
  refused(range("2025-01-01", "2026-01-02"), "range_too_long", 422);
  assert.equal(adminDays(range("2025-01-01", "2026-01-01")).dates.length, 366);
});

/** Accounts as sign-up and billing leave them, around the night clocks went forward in Chicago. */
async function accounts(db: Sql) {
  let githubId = 0;
  const tenant = (id: string, how: "github" | "google" | "email" | "operator", made: string) => db.query(
    "insert into tenants (id, github, github_id, google_sub, google_email, email_signup, created_at) values ($1, $2, $3, $4, $5, $6, $7)",
    [id, how === "github" ? id : null, how === "github" ? ++githubId : null, how === "google" ? `sub-${id}` : null, how === "google" ? `${id}@example.test` : null, how === "email", at(made)]);
  const ledger = (owner: string, kind: string, amount: number, posted: string) => db.query(
    "insert into credit_ledger (tenant, kind, amount, idempotency_key, created_at) values ($1, $2, $3, $4, $5)", [owner, kind, amount, `${kind}:${owner}:${posted}:${amount}`, at(posted)]);
  const journey = (owner: string, ref: string, internal: boolean, firstRun?: string) => Promise.all([
    db.query("insert into journey_accounts (tenant, account_ref, internal, since_signup, consent, created_at) values ($1, $2, $3, true, 'unknown', 0)", [owner, ref, internal]),
    firstRun && db.query("insert into journey_milestones (account_ref, name, at) values ($1, 'run_first_execution_completed', $2), ($1, 'run_active_day:2026-03-08', $2)", [ref, at(firstRun)]),
  ]);
  // 11:30 pm on the 7th in Chicago, though the 8th in UTC; the last millisecond of the 8th; and the first of the 9th.
  await tenant("gh-one", "github", "2026-03-08T05:30:00Z");
  await tenant("g-two", "google", "2026-03-08T18:00:00Z");
  await tenant("e-three", "email", "2026-03-09T04:59:59.999Z");
  await tenant("next-day", "github", "2026-03-09T05:00:00Z");
  // Not sign-ups: an operator's making, the operator's own staff, an account being erased.
  await tenant("ops-made", "operator", "2026-03-08T18:00:00Z");
  await tenant("staff", "google", "2026-03-08T18:00:00Z");
  await tenant("erasing", "github", "2026-03-08T18:00:00Z");
  await db.query("insert into account_deletions (tenant, requested_at, requested_by) values ('erasing', 1, 'self'), ('erased', 1, 'self')");
  // Purchases are micro-USD: $25.00 and $10.50 on the 8th, $5 on the 7th. Grants, usage and refunds are not payments.
  await ledger("gh-one", "purchase", 25_000_000, "2026-03-08T15:00:00Z");
  await ledger("gh-one", "purchase", 10_500_000, "2026-03-08T16:00:00Z");
  await ledger("g-two", "purchase", 5_000_000, "2026-03-08T05:59:59Z");
  await ledger("g-two", "grant", 5_000_000, "2026-03-08T15:00:00Z");
  await ledger("g-two", "usage", -1_250_000, "2026-03-08T15:00:00Z");
  await ledger("gh-one", "refund", -10_500_000, "2026-03-08T17:00:00Z");
  await ledger("next-day", "purchase", 40_000_000, "2026-03-09T05:00:00Z");
  // An erased account's ledger outlives its row; staff and accounts being erased pay too.
  await ledger("erased", "purchase", 99_000_000, "2026-03-08T15:00:00Z");
  await ledger("erasing", "purchase", 99_000_000, "2026-03-08T15:00:00Z");
  await ledger("staff", "purchase", 99_000_000, "2026-03-08T15:00:00Z");
  await journey("g-two", "11111111-1111-4111-8111-111111111111", false, "2026-03-08T19:00:00Z");
  await journey("e-three", "22222222-2222-4222-8222-222222222222", false, "2026-03-07T12:00:00Z");
  await journey("gh-one", "33333333-3333-4333-8333-333333333333", false);
  await journey("staff", "44444444-4444-4444-8444-444444444444", true, "2026-03-08T19:00:00Z");
  await journey("erasing", "55555555-5555-4555-8555-555555555555", false, "2026-03-08T19:00:00Z");
}

test("product signals count sign-ups, purchases in cents and first runs by the calendar day they happened on", async () => {
  const { db } = await testDatabase();
  await accounts(db);
  const days = range("2026-03-07", "2026-03-08");
  const enabled = (iso: string) => db.query("insert into journey_state (enabled_at) values ($1) on conflict (singleton) do update set enabled_at = excluded.enabled_at", [at(iso)]);

  // Journey events never on: sign-ups and purchases all the same, and first runs unknown, not none.
  const untracked = await adminSignals(db, { range: days, tracking: false, now: at("2026-03-10T00:00:00Z") });
  assert.deepEqual(untracked, {
    schema_version: 1, range: days, generated_at: "2026-03-10T00:00:00.000Z",
    summary: { signups: 3, activations: null, payments: 3, paying_accounts: 2, amount_minor: 4050, currency: "USD" },
    daily: [
      { date: "2026-03-07", signups: 1, activations: null, payments: 1, amount_minor: 500 },
      { date: "2026-03-08", signups: 2, activations: null, payments: 2, amount_minor: 3550 },
    ],
    activation_coverage: { status: "unavailable", since: null },
  });
  assert.equal((await adminSignals(db, { range: days, tracking: true })).activation_coverage.status, "unavailable", "on, but not yet begun");

  // On since before the range: every first run in it is known. Staff's and an erasing account's are not counted.
  await enabled("2026-03-01T00:00:00Z");
  const full = await adminSignals(db, { range: days, tracking: true });
  assert.deepEqual(full.activation_coverage, { status: "full", since: "2026-03-01T00:00:00.000Z" });
  assert.equal(full.summary.activations, 2);
  assert.deepEqual(full.daily.map(day => day.activations), [1, 1]);
  assert.deepEqual({ ...full, generated_at: "", summary: { ...full.summary, activations: null }, daily: full.daily.map(day => ({ ...day, activations: null })), activation_coverage: untracked.activation_coverage },
    { ...untracked, generated_at: "" }, "everything else is the same either way");
  // Recorded once, they stay known only while journey events are on: off again, a later day would read as none.
  assert.equal((await adminSignals(db, { range: days, tracking: false })).summary.activations, null);

  // On from midday on the 8th: the 7th is unknown, the 8th counted from then, and the total says since when.
  await enabled("2026-03-08T17:00:00Z");
  const partial = await adminSignals(db, { range: days, tracking: true });
  assert.deepEqual(partial.activation_coverage, { status: "partial", since: "2026-03-08T17:00:00.000Z" });
  assert.deepEqual(partial.daily.map(day => day.activations), [null, 1]);
  assert.equal(partial.summary.activations, 1);

  // On only after the range: unknown throughout.
  await enabled("2026-03-09T05:00:00Z");
  const none = await adminSignals(db, { range: days, tracking: true });
  assert.deepEqual(none.activation_coverage, { status: "none", since: "2026-03-09T05:00:00.000Z" });
  assert.deepEqual([none.summary.activations, ...none.daily.map(day => day.activations)], [null, null, null]);

  // A day with nothing is a row of zeros, and the day after the change is its own.
  const later = await adminSignals(db, { range: range("2026-03-09", "2026-03-10"), tracking: true });
  assert.deepEqual(later.daily, [
    { date: "2026-03-09", signups: 1, activations: 0, payments: 1, amount_minor: 4000 },
    { date: "2026-03-10", signups: 0, activations: 0, payments: 0, amount_minor: 0 },
  ]);
  // The same instants fall on other days elsewhere.
  assert.deepEqual((await adminSignals(db, { range: range("2026-03-08", "2026-03-08", "UTC"), tracking: false })).summary,
    { signups: 2, activations: null, payments: 3, paying_accounts: 2, amount_minor: 4050, currency: "USD" });
});

/** The site in a server of its own, as the runtime mounts it: before everything else, which answers "runtime". */
async function site(t: T, options: Partial<AdminSiteOptions> = {}) {
  const { db } = await testDatabase();
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: "fixture", alg: "RS256" }] });
  const consoleDir = await mkdtemp(join(tmpdir(), "admin-site-"));
  await writeFile(join(consoleDir, "admin.html"), "<title>admin</title>");
  const app = new Hono();
  app.use(adminSite({ host: HOST, team: TEAM, audience: AUD, db, consoleDir, keys, emails: [ADMIN], ...options }));
  app.all("*", c => c.text("runtime"));
  const token = (claims: { email?: string | null; iss?: string; aud?: string; exp?: string } = {}, key = privateKey) =>
    new SignJWT(claims.email === null ? { common_name: "service-token" } : { email: claims.email ?? ADMIN }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(claims.iss ?? TEAM).setAudience(claims.aud ?? AUD).setIssuedAt().setExpirationTime(claims.exp ?? "5m").sign(key);
  const call = async (path: string, init: { token?: string | null; host?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const signedIn = init.token === null ? undefined : init.token ?? await token();
    const response = await app.request(`http://${init.host ?? HOST}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { host: init.host ?? HOST, ...(signedIn ? { "cf-access-jwt-assertion": signedIn } : {}), ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* a page, or plain text */ }
    return { status: response.status, text, json, cache: response.headers.get("cache-control") };
  };
  return { db, call, token, app };
}

test("the admin site is for the listed addresses only, of those Cloudflare Access signed in", async t => {
  const { call, token } = await site(t, { emails: [ADMIN, "miguel@example.test"] });
  const paths = ["/", "/api/stats", "/api/product-signals"];

  // No valid Access token for this application: nothing, whatever the address it claims.
  const stranger = (await generateKeyPair("RS256")).privateKey;
  for (const refused of [null, await token({ aud: "another-application" }), await token({ iss: "https://other.cloudflareaccess.example" }), await token({ exp: "-1m" }), await token({}, stranger), await token({ email: null }), "not-a-token"]) {
    for (const path of paths) assert.equal((await call(path, { token: refused })).status, 401);
    assert.equal((await call("/api/report", { token: refused, body: {} })).status, 401);
  }
  // A header that only says who someone is counts for nothing.
  assert.equal((await call("/api/stats", { token: null, headers: { "cf-access-authenticated-user-email": ADMIN, "x-forwarded-email": ADMIN } })).status, 401);

  // Signed in by Access, but not listed: nothing either, the page included.
  const teammate = await token({ email: "teammate@example.test" });
  for (const path of paths) {
    const refused = await call(path, { token: teammate });
    assert.equal(refused.status, 403);
    assert.equal(refused.cache, "no-store");
    assert.doesNotMatch(refused.text, /signups|admin<\/title>/);
  }
  assert.equal((await call("/api/report", { token: teammate, body: {} })).status, 403);

  // Listed, however the address is capitalised.
  for (const email of [ADMIN, "Miguel@Example.test"]) {
    const signedIn = await token({ email });
    assert.equal((await call("/", { token: signedIn })).text, "<title>admin</title>");
    const stats = await call("/api/stats", { token: signedIn });
    assert.equal(stats.status, 200);
    assert.equal(stats.json.viewer, email);
    assert.equal((await call("/api/product-signals", { token: signedIn })).status, 200);
  }

  // The site is its hostname's alone: elsewhere its paths are the runtime's, and its token opens nothing.
  for (const path of paths) assert.equal((await call(path, { host: "run.example.test" })).text, "runtime");
  assert.equal((await call("/api/report", { host: "run.example.test", body: {} })).text, "runtime");
  // Only the report is asked for with a POST.
  assert.equal((await call("/api/stats", { method: "POST" })).status, 404);
  assert.equal((await call("/api/product-signals", { method: "DELETE" })).status, 404);
  assert.equal((await call("/api/report")).status, 404);
});

test("product signals default to today in Chicago and refuse a range they cannot count", async t => {
  const { db, call } = await site(t);
  await db.query("insert into tenants (id, github, github_id, created_at) values ('today', 'today', 1, $1)", [Date.now()]);
  const today = await call("/api/product-signals");
  assert.equal(today.status, 200);
  assert.equal(today.cache, "no-store");
  assert.deepEqual(today.json.range, { start_date: adminToday(), end_date: adminToday(), time_zone: CHICAGO });
  assert.deepEqual(today.json.daily, [{ date: adminToday(), signups: 1, activations: null, payments: 0, amount_minor: 0 }]);
  assert.deepEqual(today.json.activation_coverage, { status: "unavailable", since: null });

  const month = await call("/api/product-signals?start_date=2026-03-01&end_date=2026-03-31&time_zone=Europe/London");
  assert.equal(month.json.daily.length, 31);
  assert.deepEqual(month.json.range, { start_date: "2026-03-01", end_date: "2026-03-31", time_zone: "Europe/London" });

  const refused = async (query: string, status: number, error: string) => assert.deepEqual(await call(`/api/product-signals?${query}`).then(({ status, json }) => ({ status, json })), { status, json: { error } });
  await refused("start_date=2026-03-01", 400, "invalid_date");
  await refused("end_date=2026-03-01", 400, "invalid_date");
  await refused("start_date=2026-02-30&end_date=2026-03-01", 400, "invalid_date");
  await refused("start_date=2026-03-02&end_date=2026-03-01", 400, "invalid_range");
  await refused("start_date=2025-01-01&end_date=2026-01-02", 422, "range_too_long");
  await refused("time_zone=Mars/Olympus", 400, "invalid_time_zone");
});

/** A journey store's report endpoint: what it was asked, having checked each request's signature over the bytes it got. */
async function fakeStore(t: T, answer: (request: any) => { status?: number; body?: unknown; raw?: string; headers?: Record<string, string> } | undefined = () => undefined) {
  const asked: any[] = [];
  let other = 0;
  const base = await listen(t, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk)).on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (req.method !== "POST" || req.url !== ADMIN_REPORT_PATH) { other++; return void res.writeHead(404).end("{}"); }
      const signed = `${req.headers["webhook-id"]}.${req.headers["webhook-timestamp"]}.${raw}`;
      const signature = (secret: string) => `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(signed).digest("base64")}`;
      // As the real store does: a request signed with the events' key is not one it answers.
      if (req.headers["webhook-signature"] !== signature(REPORT_SECRET)) return void res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid_signature" }));
      const request = JSON.parse(raw);
      asked.push(request);
      const reply = answer(request) ?? {};
      const body = reply.body ?? { schema_version: 1, kind: request.kind, range: { start_date: request.start_date, end_date: request.end_date, time_zone: request.time_zone }, generated_at: "2026-03-09T00:00:00.000Z", coverage: { first_event_at: null, last_event_at: null }, items: [], next_cursor: null };
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers }).end(reply.raw ?? JSON.stringify(body));
    });
  });
  return { base, asked, strays: () => other };
}

const JOURNEYS = { schema_version: 1, kind: "journeys", ...range("2026-03-07", "2026-03-08") };

test("the journey store's reports are asked for by the site itself, signed with their own secret", async t => {
  const store = await fakeStore(t, request => request.cursor === "deleted" ? { status: 410, body: { error: "account_deleted" } }
    : request.cursor === "unsigned" ? { status: 401, body: { error: "invalid_signature" } }
    : request.cursor === "unconfigured" ? { status: 503, body: { error: "report_secret_must_be_separate" } }
    : request.cursor === "elsewhere" ? { status: 302, headers: { Location: "/elsewhere" } }
    : request.cursor === "huge" ? { raw: JSON.stringify({ padding: "x".repeat(2_100_000) }) }
    : request.cursor === "other" ? { body: { schema_version: 1, kind: "journeys", range: range("2026-01-01") } }
    : request.cursor === "prose" ? { raw: "<html>gateway</html>" } : undefined);
  const options = adminSiteFromEnvironment({ AGENT_ADMIN_HOST: HOST, AGENT_ADMIN_ACCESS_TEAM: TEAM, AGENT_ADMIN_ACCESS_AUD: AUD, AGENT_ADMIN_EMAILS: ` ${ADMIN.toUpperCase()}, miguel@example.test ` },
    { db: undefined as never, consoleDir: "", journey: { url: store.base, secret: EVENT_SECRET }, reportSecret: REPORT_SECRET })!;
  assert.deepEqual({ ...options, db: 0, consoleDir: 0 }, {
    host: HOST, team: TEAM, audience: AUD, db: 0, consoleDir: 0, tracking: true, emails: [ADMIN, "miguel@example.test"], report: { url: `${store.base}${ADMIN_REPORT_PATH}`, secret: REPORT_SECRET },
  });
  const { call, token } = await site(t, { emails: options.emails, tracking: options.tracking, report: options.report });

  // The list of accounts, and one account: asked of the store as the page asked, and answered as the store answered.
  const list = await call("/api/report", { body: JOURNEYS, headers: { origin: `https://${HOST}` } });
  assert.equal(list.status, 200);
  assert.equal(list.cache, "no-store");
  assert.equal(list.json.kind, "journeys");
  assert.deepEqual(list.json.range, range("2026-03-07", "2026-03-08"));
  const one = { ...JOURNEYS, kind: "journey", account_ref: ACCOUNT, cursor: "page-2" };
  assert.equal((await call("/api/report", { body: one })).status, 200);
  assert.equal((await call("/api/report", { body: { ...JOURNEYS, kind: "signals" } })).status, 200);
  assert.deepEqual(store.asked, [JOURNEYS, one, { ...JOURNEYS, kind: "signals" }]);
  assert.doesNotMatch(JSON.stringify(list), /whsec_/);

  // Not a request the store reads: refused here, and the store never asked.
  for (const body of [
    "not json", [], { ...JOURNEYS, schema_version: 2 }, { ...JOURNEYS, kind: "events" }, { ...JOURNEYS, tenant: "gh-one" }, { ...JOURNEYS, start_date: "2026-02-30" },
    { ...JOURNEYS, start_date: "2025-01-01" }, { ...JOURNEYS, time_zone: "Mars/Olympus" }, { ...JOURNEYS, account_ref: ACCOUNT }, { ...JOURNEYS, kind: "journey" },
    { ...JOURNEYS, kind: "journey", account_ref: "gh-one" }, { ...JOURNEYS, kind: "signals", cursor: "page-2" }, { ...JOURNEYS, cursor: "not a cursor" }, { ...JOURNEYS, cursor: "x".repeat(5000) },
  ]) assert.deepEqual(await call("/api/report", { body }).then(({ status, json }) => ({ status, json })), { status: 400, json: { error: "invalid_request" } });
  assert.equal((await call("/api/report", { body: JOURNEYS, headers: { "content-type": "text/plain" } })).status, 400);
  // Another site's page cannot ask with the viewer's session, and nobody not listed can ask at all.
  assert.deepEqual((await call("/api/report", { body: JOURNEYS, headers: { origin: "https://elsewhere.example.test" } })).json, { error: "invalid_origin" });
  assert.equal((await call("/api/report", { body: JOURNEYS, token: await token({ email: "teammate@example.test" }) })).status, 403);
  assert.equal((await call("/api/report", { body: JOURNEYS, token: null })).status, 401);
  assert.equal(store.asked.length, 3);

  // What the store refuses of a request is passed on; anything else it says is the reports being unavailable.
  const answered = async (cursor: string) => call("/api/report", { body: { ...JOURNEYS, cursor } }).then(({ status, json, cache }) => ({ status, json, cache }));
  assert.deepEqual(await answered("deleted"), { status: 410, json: { error: "account_deleted" }, cache: "no-store" });
  assert.deepEqual(await answered("unconfigured"), { status: 503, json: { error: "report_not_configured" }, cache: "no-store" });
  for (const cursor of ["unsigned", "elsewhere", "huge", "other", "prose"]) assert.deepEqual(await answered(cursor), { status: 502, json: { error: "report_unavailable" }, cache: "no-store" });
  assert.equal(store.strays(), 0, "a redirect is not followed");
});

test("a report is asked for over HTTP as the runtime serves the site, a body read no further than a request is long", async t => {
  const store = await fakeStore(t);
  const { app, token } = await site(t, { emails: [ADMIN], report: { url: `${store.base}${ADMIN_REPORT_PATH}`, secret: REPORT_SECRET } });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address() as { port: number };
  // As Cloudflare sends it to the load balancer: the site's name as Host, and Access's token.
  const post = async (body: string, signedIn = true) => {
    const headers = { host: HOST, "content-type": "application/json", origin: `https://${HOST}`, ...(signedIn ? { "cf-access-jwt-assertion": await token() } : {}) };
    return new Promise<{ status: number; json: any }>((resolve, reject) => {
      // A connection each: the server closes one whose body it stopped reading.
      const sent = httpRequest({ host: "127.0.0.1", port, path: "/api/report", method: "POST", headers, agent: false }, response => {
        let text = "";
        response.setEncoding("utf8").on("data", chunk => text += chunk).on("end", () => resolve({ status: response.statusCode!, json: text.startsWith("{") ? JSON.parse(text) : text }));
      }).on("error", reject);
      // In pieces, with no length said beforehand.
      for (let offset = 0; offset < body.length; offset += 1000) sent.write(body.slice(offset, offset + 1000));
      sent.end();
    });
  };
  const answered = await post(JSON.stringify(JOURNEYS));
  assert.equal(answered.status, 200);
  assert.equal(answered.json.kind, "journeys");
  assert.deepEqual(store.asked, [JOURNEYS]);
  assert.deepEqual(await post(JSON.stringify({ ...JOURNEYS, padding: "x".repeat(200_000) })), { status: 400, json: { error: "invalid_request" } });
  assert.equal((await post(JSON.stringify(JOURNEYS), false)).status, 401);
  assert.equal(store.asked.length, 1);
});

test("reports say they are not configured, or unavailable, while the rest of the site answers", async t => {
  const store = await fakeStore(t);
  // No store: the site's own figures all the same.
  const bare = await site(t);
  assert.deepEqual(await bare.call("/api/report", { body: JOURNEYS }).then(({ status, json }) => ({ status, json })), { status: 503, json: { error: "report_not_configured" } });
  assert.equal((await bare.call("/api/report", { body: { ...JOURNEYS, kind: "events" } })).status, 400);
  assert.equal((await bare.call("/api/stats")).status, 200);
  assert.equal((await bare.call("/api/product-signals")).status, 200);

  // A store that is not there, and one asked with the key events are signed with.
  const gone = await site(t, { report: { url: `http://127.0.0.1:9${ADMIN_REPORT_PATH}`, secret: REPORT_SECRET } });
  assert.deepEqual((await gone.call("/api/report", { body: JOURNEYS })).json, { error: "report_unavailable" });
  assert.equal((await gone.call("/api/stats")).status, 200);
  const wrongKey = await site(t, { report: { url: `${store.base}${ADMIN_REPORT_PATH}`, secret: EVENT_SECRET } });
  assert.equal((await wrongKey.call("/api/report", { body: JOURNEYS })).status, 502);
  assert.equal(store.asked.length, 0);
});

test("the admin site's settings are refused where they could not work", () => {
  const env = { AGENT_ADMIN_HOST: HOST, AGENT_ADMIN_ACCESS_TEAM: TEAM, AGENT_ADMIN_ACCESS_AUD: AUD };
  const context = { db: undefined as never, consoleDir: "" };
  const journey = { url: "https://store.example.test", secret: EVENT_SECRET };
  // As before: no list and no store.
  assert.deepEqual(adminSiteFromEnvironment(env, context), { host: HOST, team: TEAM, audience: AUD, ...context, tracking: false });
  assert.equal(adminSiteFromEnvironment({}, context), undefined);
  assert.equal(adminSiteFromEnvironment({ AGENT_ADMIN_EMAILS: " , " }, context), undefined);
  // Journey events without a report secret: first runs are counted, reports are not configured.
  assert.deepEqual(adminSiteFromEnvironment(env, { ...context, journey }), { host: HOST, team: TEAM, audience: AUD, ...context, tracking: true });
  assert.equal(adminSiteFromEnvironment(env, { ...context, journey, reportSecret: REPORT_SECRET })!.report!.url, "https://store.example.test/api/journey/admin-report");

  assert.throws(() => adminSiteFromEnvironment({ ...env, AGENT_ADMIN_EMAILS: "isabella@example.test, miguel" }, context), /AGENT_ADMIN_EMAILS must be email addresses/);
  assert.throws(() => adminSiteFromEnvironment({ AGENT_ADMIN_EMAILS: ADMIN }, context), /without AGENT_ADMIN_HOST/);
  assert.throws(() => adminSiteFromEnvironment(env, { ...context, reportSecret: REPORT_SECRET }), /without AGENT_JOURNEY_URL/);
  assert.throws(() => adminSiteFromEnvironment(env, { ...context, journey, reportSecret: EVENT_SECRET }), /must not be AGENT_JOURNEY_SECRET/);
  assert.throws(() => adminSiteFromEnvironment(env, { ...context, journey, reportSecret: "whsec_c2hvcnQ=" }), /whsec_<base64 of 16 bytes or more>/);
  assert.throws(() => adminSiteFromEnvironment(env, { ...context, journey, reportSecret: "a-plain-password-of-some-length" }), /Standard Webhooks secret/);
});


test("an unset or empty admin list never grants access to everyone signed in", async t => {
  for (const emails of [undefined, []]) {
    const { call } = await site(t, { emails });
    for (const path of ["/", "/api/stats", "/api/product-signals"]) {
      const result = await call(path);
      assert.equal(result.status, 503);
      assert.equal(result.cache, "no-store");
    }
    assert.equal((await call("/api/report", { body: {} })).status, 503);
  }
});
