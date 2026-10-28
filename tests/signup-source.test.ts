import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { ConsoleAuth } from "../src/console-auth.ts";
import { EmailAccounts } from "../src/email-accounts.ts";
import { Journey } from "../src/journey.ts";
import { Passwords } from "../src/passwords.ts";
import { keptSignupSource, signupSource } from "../src/signup-source.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { listen, type T } from "./runtime-server.ts";

/** Where an account came from (src/signup-source.ts): sent by the console as a sign-in starts, kept once on the account it makes. */
const ORIGIN = "http://run.example.test";
const BROWSER = { "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
const PASSWORD = "a long and unusual passphrase";

/** A console sign-in with a fake GitHub (each `id` its own account), journey events on or off, and email sign-up whose links are kept here. */
async function setup(t: T, options: { journey?: boolean } = {}) {
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, pricing: { startingGrant: 0 } as never });
  let user = { login: "octocat", id: 1 };
  const github = await listen(t, (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/login/oauth/access_token") return void res.end(JSON.stringify({ access_token: "gho_fixture" }));
    if (req.url === "/user") return void res.end(JSON.stringify({ ...user, created_at: "2015-01-01T00:00:00Z" }));
    res.end("{}");
  });
  const links: string[] = [];
  const mail = { config: { origin: ORIGIN }, send: (_kind: string, _to: string, link?: string) => { if (link) links.push(link); } };
  const email = new EmailAccounts({ accounts, mail: mail as never, openSignup: true });
  const journey = options.journey ? new Journey({ db, url: "http://127.0.0.1:9", secret: `whsec_${Buffer.from("signup-source-test-signing-key").toString("base64")}`, publicUrl: ORIGIN, visitorCookie: "camel_attribution_id", consentCookie: "camel_consent" }) : undefined;
  const auth = new ConsoleAuth({ accounts, publicUrl: ORIGIN, passwords: new Passwords(db), email, journey,
    github: { clientId: "id", clientSecret: "secret", org: "", open: true, minAccountDays: 0, webUrl: github, apiUrl: github } });
  /** Sign in with GitHub as account `id`, starting at `query`. Returns the cookies the callback set. */
  const signIn = async (id: number, query = "", headers: Record<string, string> = {}) => {
    user = { login: `user${id}`, id };
    const start = await auth.app.request(`/console/auth/github${query}`, { headers });
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    // The browser's cookies after the start: what it had, with what the start set or cleared.
    const jar = new Map((headers.cookie ?? "").split("; ").filter(Boolean).map(pair => [pair.split("=")[0]!, pair]));
    for (const set of start.headers.getSetCookie()) {
      const pair = set.split(";")[0]!;
      if (set.includes("Max-Age=0")) jar.delete(pair.split("=")[0]!); else jar.set(pair.split("=")[0]!, pair);
    }
    const callback = await auth.app.request(`/console/auth/callback?code=abc&state=${state}`, { headers: { ...headers, cookie: [...jar.values()].join("; ") } });
    assert.equal(callback.status, 302);
    assert.ok(!callback.headers.get("location")!.includes("error="), callback.headers.get("location")!);
    return { started: start.headers.getSetCookie(), finished: callback.headers.getSetCookie() };
  };
  const source = async (tenant: string) => (await db.query("select signup_source from tenants where id = $1", [tenant])).rows[0]?.signup_source;
  return { db, auth, signIn, source, links };
}

test("a sign-in's ref and referrer are checked: tags and host names only, the referrer not for a browser that refuses", () => {
  assert.deepEqual(signupSource({ ref: "Run-Slack", from: "www.Google.com" }), { ref: "run-slack", referrer: "google.com" });
  assert.deepEqual(signupSource({ ref: "blog/agent-memory", from: "news.ycombinator.com" }), { ref: "blog/agent-memory", referrer: "news.ycombinator.com" });
  assert.deepEqual(signupSource({ ref: "home", from: "chatgpt.com" }, true), { ref: "home" }, "a refusing browser's referrer is not kept");
  for (const ref of ["", "-home", "a b", "<script>", "x".repeat(65), 7, null]) assert.deepEqual(signupSource({ ref }), {}, String(ref));
  for (const from of ["localhost", "https://google.com", "google.com/search", "a..b", "-bad.com", "x".repeat(300) + ".com", {}]) assert.deepEqual(signupSource({ from }), {}, String(from));
  assert.deepEqual(keptSignupSource({ ref: "home", referrer: "google.com", extra: "dropped" }), { ref: "home", referrer: "google.com" });
  assert.deepEqual(keptSignupSource({}), {});
  for (const kept of [null, undefined, "home", ["home"]]) assert.equal(keptSignupSource(kept), undefined);
});

test("a GitHub sign-in that makes an account keeps where its browser came from, once; journey events on or off", async t => {
  for (const journey of [false, true]) {
    const { signIn, source } = await setup(t, { journey });
    const first = await signIn(1, "?ref=Run-Slack&from=www.google.com");
    const kept = first.started.find(value => value.startsWith("ar_source="))!;
    assert.match(kept, /Path=\/console\/auth; Max-Age=600; HttpOnly; SameSite=Lax/, "only the sign-in's own short cookie");
    assert.ok(first.finished.some(value => value.startsWith("ar_source=;") && value.includes("Max-Age=0")), "cleared at the callback");
    assert.deepEqual(await source("user1"), { ref: "run-slack", referrer: "google.com" });
    // Signing in again, from anywhere, never rewrites it.
    await signIn(1, "?ref=footer&from=bing.com");
    assert.deepEqual(await source("user1"), { ref: "run-slack", referrer: "google.com" });
    // Neither shown: direct, which is not the same as nothing kept. An abandoned sign-in's source is not carried over.
    const direct = await signIn(2, "", { cookie: kept.split(";")[0]! });
    assert.ok(direct.started.some(value => value.startsWith("ar_source=;") && value.includes("Max-Age=0")));
    assert.deepEqual(await source("user2"), {});
  }
});

test("a browser that asks not to be measured keeps its link's tag but not its referrer", async t => {
  const { signIn, source } = await setup(t, { journey: true });
  await signIn(1, "?ref=home&from=google.com", { "sec-gpc": "1" });
  assert.deepEqual(await source("user1"), { ref: "home" });
  await signIn(2, "?ref=home&from=google.com", { cookie: "camel_consent=denied" });
  assert.deepEqual(await source("user2"), { ref: "home" });
});

test("an email sign-up keeps its browser's source with the mailed link, and on the account the link makes", async t => {
  const { auth, db, source, links } = await setup(t);
  const signUp = await auth.app.request("/console/auth/signup", { method: "POST", headers: BROWSER, body: JSON.stringify({ email: "ada@example.test", password: PASSWORD, ref: "pricing", from: "github.com" }) });
  assert.equal(signUp.status, 202);
  assert.deepEqual((await db.query("select signup_source from account_email_links")).rows[0].signup_source, { ref: "pricing", referrer: "github.com" });
  const token = links[0]!.split("#")[1];
  const verified = await auth.app.request("/console/auth/verify", { method: "POST", headers: BROWSER, body: JSON.stringify({ token, password: PASSWORD }) });
  assert.equal(verified.status, 200);
  assert.deepEqual(await source((await verified.json()).tenant), { ref: "pricing", referrer: "github.com" });
  // A link mailed before sources were kept has none: the account it makes is not captured, not direct.
  await auth.app.request("/console/auth/signup", { method: "POST", headers: BROWSER, body: JSON.stringify({ email: "bo@example.test", password: PASSWORD }) });
  await db.query("update account_email_links set signup_source = null");
  const older = await auth.app.request("/console/auth/verify", { method: "POST", headers: BROWSER, body: JSON.stringify({ token: links[1]!.split("#")[1], password: PASSWORD }) });
  assert.equal(await source((await older.json()).tenant), null);
});
