import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";

// Product assertions ported from tests/email-signup.test.ts and tests/api.test.ts.
// The loopback sink receives the same SES envelope as tests/email-signup.test.ts.
const PASSWORD = "a long and unusual passphrase";
const PUBLIC = "https://agents.example.test";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("Workers accounts preserve email/password, session and OAuth policy", { timeout: 180_000 }, async t => {
  const mails: { to: string; subject: string; html: string; text: string }[] = [];
  const arrivals = new Set<() => void>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const envelope = JSON.parse(body), simple = envelope.Content.Simple;
    mails.push({ to: envelope.Destination.ToAddresses.join(","), subject: simple.Subject.Data, html: simple.Body.Html.Data, text: simple.Body.Text.Data });
    for (const arrived of arrivals) arrived();
    response.writeHead(200, { "Content-Type": "application/json" }).end('{"MessageId":"fake"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const fake = `http://127.0.0.1:${(server.address() as {port: number}).port}/mail`;
  const f = await startFixture({ vars: { AGENT_PUBLIC_URL: PUBLIC, AGENT_OPEN_SIGNUP: "true", AGENT_ACCOUNT_EMAIL_FROM: "accounts@example.test", MAIL_TEST_URL: fake } });
  t.after(() => f.stop());
  const call = async (path: string, method = "GET", body?: unknown, cookie?: string, extra: Record<string, string> = {}) => {
    const response = await fetch(f.url + path, { method, redirect: "manual", headers: { "Content-Type": "application/json", "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin", ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, json, headers: response.headers, cookie: response.headers.getSetCookie().find(value => value.startsWith("ar_session="))?.split(";")[0] };
  };
  const mail = async (count: number) => {
    if (mails.length < count) await new Promise<void>((resolve, reject) => {
      const arrived = () => {
        if (mails.length < count) return;
        clearTimeout(deadline); arrivals.delete(arrived); resolve();
      };
      const deadline = setTimeout(() => { arrivals.delete(arrived); reject(new Error(`Mail ${count} did not reach the local sink`)); }, 5000);
      arrivals.add(arrived);
    });
    assert.ok(mails.length >= count, "background mail reaches local fake");
    return mails[count - 1];
  };
  const tokenOf = (message: {text: string}) => {
    const token = /\/console\/(?:verify|reset)#([A-Za-z0-9_-]{43})/.exec(message.text)?.[1];
    assert.ok(token, "one account link is present");
    return token;
  };

  await t.test("signup waits for mailbox and chosen password; links are hashed and single use", async () => {
    const methods = await call("/console/auth/methods");
    assert.deepEqual(methods.json, { github: false, google: false, password: true, signup: true, reset: true });
    for (const password of ["too short", "password1234", "qwertyuiop123", "ada@example.test"]) assert.equal((await call("/console/auth/signup", "POST", { email: "ada@example.test", password })).status, 400);
    assert.equal((await call("/console/auth/signup", "POST", { email: "ada@example.test", password: PASSWORD }, undefined, { "X-Agent-Runtime-Console": "" })).status, 403);
    const sent = await call("/console/auth/signup", "POST", { email: "  Ada@Example.TEST ", password: PASSWORD });
    assert.deepEqual([sent.status, sent.json, sent.cookie], [202, { sent: true }, undefined]);
    const message = await mail(1), token = tokenOf(message);
    assert.equal(message.to, "ada@example.test");
    assert.equal(message.subject, "Confirm your email for camelRun");
    const stored = (await f.db.query("select sha256, purpose, email, tenant, hash, expires_at-created_at as ttl from account_email_links")).rows;
    assert.equal(stored.length, 1);
    assert.ok(stored[0].sha256 === sha(token), "only the token hash is stored");
    assert.equal(stored[0].tenant, null);
    assert.match(stored[0].hash, /^scrypt\$32768\$8\$1\$/);
    assert.equal(Number(stored[0].ttl), 86_400_000);
    assert.equal((await call("/console/auth/password", "POST", { email: message.to, password: PASSWORD })).status, 401);
    assert.equal((await call("/console/auth/verify", "POST", { token, password: "a different unknown password" })).status, 401);
    const done = await call("/console/auth/verify", "POST", { token, password: PASSWORD });
    assert.equal(done.status, 200);
    assert.match(done.json.tenant, /^u-[a-f0-9]{16}$/);
    assert.ok(done.cookie, "verified signup issues session");
    assert.equal((await f.db.query("select count(*)::int n from credit_ledger where tenant=$1", [done.json.tenant])).rows[0].n, 0, "email signup does not invent starting credit");
    assert.equal((await call("/console/auth/link", "POST", { token })).status, 404);
    assert.equal((await call("/console/auth/verify", "POST", { token, password: PASSWORD })).status, 400);
    const login = await call("/console/auth/password", "POST", { email: "ADA@example.test", password: PASSWORD });
    assert.equal(login.json.tenant, done.json.tenant);
    const who = await call("/v1/me", "GET", undefined, login.cookie);
    assert.equal(who.status, 200);
    assert.deepEqual([who.json.tenant, who.json.via, who.json.signIn], [done.json.tenant, "console", "password"]);
  });

  await t.test("unknown addresses and existing accounts share a response; Google addresses cannot be taken over", async () => {
    const prior = mails.length;
    const duplicate = await call("/console/auth/signup", "POST", { email: "ada@example.test", password: PASSWORD });
    const fresh = await call("/console/auth/signup", "POST", { email: "unverified@example.test", password: PASSWORD });
    assert.deepEqual([duplicate.status, duplicate.json], [fresh.status, fresh.json]);
    const existing = await mail(prior + 1);
    assert.equal(existing.subject, "Someone tried to sign up for camelRun with your email");
    assert.ok(!/\/console\/verify#/.test(existing.text));
    await mail(prior + 2);
    await f.db.query("insert into tenants(id,google_sub,google_email,created_at) values('u-google0000000001','google-sub-1','Lin@Example.test',$1)", [Date.now()]);
    assert.equal((await call("/console/auth/signup", "POST", { email: "lin@example.test", password: PASSWORD })).status, 202);
    assert.match((await mail(prior + 3)).text, /signs in with Google/);
    assert.equal((await f.db.query("select count(*)::int n from tenant_passwords where email='lin@example.test'")).rows[0].n, 0);
  });

  await t.test("password reset expires links and every old password session; mutations require CSRF header", async () => {
    const first = await call("/console/auth/password", "POST", { email: "ada@example.test", password: PASSWORD });
    const second = await call("/console/auth/password", "POST", { email: "ada@example.test", password: PASSWORD });
    assert.ok(first.cookie && second.cookie);
    assert.equal((await call("/v1/account/password", "PUT", { currentPassword: PASSWORD, newPassword: "changed password is unusually long" }, first.cookie, { "X-Agent-Runtime-Console": "" })).status, 403);
    const prior = mails.length;
    assert.equal((await call("/console/auth/reset/request", "POST", { email: "ada@example.test" })).status, 202);
    const token = tokenOf(await mail(prior + 1));
    const reset = await call("/console/auth/reset", "POST", { token, password: "new and unusual reset passphrase" });
    assert.equal(reset.status, 200);
    assert.ok(reset.json.signedOut >= 2);
    assert.equal((await call("/v1/me", "GET", undefined, first.cookie)).status, 401);
    assert.equal((await call("/v1/me", "GET", undefined, second.cookie)).status, 401);
    assert.equal((await call("/console/auth/password", "POST", { email: "ada@example.test", password: PASSWORD })).status, 401);
    assert.equal((await call("/console/auth/password", "POST", { email: "ada@example.test", password: "new and unusual reset passphrase" })).status, 200);
    assert.equal((await call("/console/auth/reset", "POST", { token, password: "new and unusual reset passphrase" })).status, 400);
  });

  await t.test("OAuth uses PKCE, rotates refresh tokens and revokes replay outside the grace window", async () => {
    const login = await call("/console/auth/password", "POST", { email: "ada@example.test", password: "new and unusual reset passphrase" });
    assert.ok(login.cookie);
    const client = (await call("/oauth/register", "POST", { client_name: "Fixture", redirect_uris: ["https://app.example.test/callback"], token_endpoint_auth_method: "none" })).json;
    assert.ok(client.client_id);
    const verifier = "v".repeat(43), challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://app.example.test/callback", scope: "agents", code_challenge: challenge, code_challenge_method: "S256", state: "state", resource: PUBLIC + "/mcp" });
    const consent = await call("/oauth/authorize?" + params, "GET", undefined, login.cookie);
    assert.equal(consent.status, 200);
    const form = async (path: string, values: Record<string,string>, cookie?: string) => fetch(f.url + path, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin", ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(values) });
    const granted = await form("/oauth/authorize", { ...Object.fromEntries(params), decision: "allow" }, login.cookie);
    assert.equal(granted.status, 302);
    const code = new URL(granted.headers.get("location")!).searchParams.get("code");
    assert.ok(code);
    const tokens = await (await form("/oauth/token", { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: "https://app.example.test/callback", code, code_verifier: verifier, resource: PUBLIC + "/mcp" })).json() as any;
    assert.ok(tokens.access_token && tokens.refresh_token);
    const authorization = { Authorization: `Bearer ${tokens.access_token}` };
    assert.equal((await call("/v1/me", "GET", undefined, undefined, authorization)).status, 200, "OAuth may read its account");
    assert.equal((await call("/v1/tokens", "POST", {}, undefined, authorization)).status, 403, "OAuth cannot create a lasting credential");
    const rotate = () => form("/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource: PUBLIC + "/mcp" });
    const rotated = await (await rotate()).json() as any;
    assert.ok(rotated.access_token && rotated.refresh_token);
    const retry = await (await rotate()).json() as any;
    assert.ok(retry.access_token === rotated.access_token && retry.refresh_token === rotated.refresh_token, "lost-ack retry within grace receives same successor");
    assert.equal((await form("/oauth/token", { grant_type: "authorization_code", client_id: client.client_id, redirect_uri: "https://app.example.test/callback", code, code_verifier: verifier, resource: PUBLIC + "/mcp" })).status, 400, "authorization code works once");
    await f.db.query("update oauth_tokens set used_at=$2 where sha256=$1", [sha(tokens.refresh_token), Date.now() - 11_000]);
    assert.equal((await rotate()).status, 400, "used refresh outside grace revokes grant");
    assert.equal((await f.db.query("select count(*)::int n from oauth_grants where client_id=$1", [client.client_id])).rows[0].n, 0);
  });
});
