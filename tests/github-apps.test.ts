import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubApps, githubAppAuthInput, type GitHubAppAuth } from "../src/core/github-apps.ts";
import { testDatabase } from "./database.ts";
import { fakeGitHubApp } from "./github-app-fake.ts";
import { cases } from "./github-apps-cases.ts";
import { runtime } from "./runtime-server.ts";

/** Sealing as the host gives it, bound to its context (the tests' own: AES is the accounts' concern). */
const keys = {
  canStore: true,
  seal: (context: string, plaintext: string) => ({ iv: "", tag: context, ciphertext: Buffer.from(plaintext).toString("base64") }),
  unseal: (context: string, sealed: { tag: string; ciphertext: string }) => {
    if (sealed.tag !== context) throw new Error("sealed under another context");
    return Buffer.from(sealed.ciphertext, "base64").toString();
  },
};

async function service(t: { after(fn: () => Promise<void> | void): void }) {
  const github = await fakeGitHubApp(t);
  const { db } = await testDatabase();
  const apps = new GitHubApps({ sql: db, keys, fetch, apiUrl: github.url });
  const app = await apps.create("alice", { appId: "5151", privateKey: github.state.pem, name: "code" });
  return { github, db, apps, app };
}
const auth = (fields: Partial<GitHubAppAuth> = {}): GitHubAppAuth => ({ type: "github-app", app: "code", ...fields });

test("auth github-app is checked where it is saved: an App, one owner's repositories, GitHub's permission levels", () => {
  assert.deepEqual(githubAppAuthInput({ type: "github-app", app: "code", repositories: ["Acme/App", "acme/web"], permissions: { pull_requests: "write", contents: "read" } }, "auth"),
    { type: "github-app", app: "code", repositories: ["acme/app", "acme/web"], permissions: { contents: "read", pull_requests: "write" } });
  assert.deepEqual(githubAppAuthInput({ type: "github-app", app: "gha_0123456789abcdef0123", installation: 7, owner: "acme" }, "auth"),
    { type: "github-app", app: "gha_0123456789abcdef0123", installation: 7, owner: "acme" });
  for (const [value, message] of [
    [{ type: "exchange", app: "code" }, /auth is \{ type: "github-app"/],
    [{ type: "github-app" }, /auth\.app is the name or id/],
    [{ type: "github-app", app: "code", token: "x" }, /Unrecognized key: "token"/],
    [{ type: "github-app", app: "code", installation: "7" }, /installation is the installation's numeric id/],
    [{ type: "github-app", app: "code", owner: "a/b" }, /owner is a GitHub user or organization login/],
    [{ type: "github-app", app: "code", repositories: [] }, /repositories is a list of 1 to 500/],
    [{ type: "github-app", app: "code", repositories: ["acme/a", "solo/b"] }, /must all have one owner/],
    [{ type: "github-app", app: "code", owner: "solo", repositories: ["acme/a"] }, /owner must be the repositories' owner/],
    [{ type: "github-app", app: "code", permissions: { contents: "all" } }, /permissions\.contents must be "read", "write" or "admin"/],
    [{ type: "github-app", app: "code", permissions: {} }, /permissions is an object of 1 to 50/],
  ] as const) assert.throws(() => githubAppAuthInput(value, "auth"), message as RegExp);
});

test("a token is minted for the repositories' installation, scoped to them, and reused until five minutes before it expires", async t => {
  const { github, apps } = await service(t);
  const first = await apps.token("alice", auth({ repositories: ["acme/app"], permissions: { contents: "write" } }));
  assert.equal(github.tokenFor(`Bearer ${first.token}`)?.installation, 101);
  assert.deepEqual(github.minted().map(entry => [entry.repositories, entry.permissions]), [[["app"], { contents: "write" }]]);
  const again = await apps.token("alice", auth({ repositories: ["acme/app"], permissions: { contents: "write" } }));
  assert.equal(again.token, first.token, "reused");
  assert.ok(first.expiresAt > Date.now() + 50 * 60_000);
  // Another scope is another token; calls at once share one mint.
  const [a, b] = await Promise.all([apps.token("alice", auth({ repositories: ["acme/other"] })), apps.token("alice", auth({ repositories: ["acme/other"] }))]);
  assert.equal(a.token, b.token);
  assert.equal(github.minted().length, 2);
  // A token turned away (401) is replaced at the next use.
  a.refused();
  assert.notEqual((await apps.token("alice", auth({ repositories: ["acme/other"] }))).token, a.token);
  apps.refuse(first.token);
  assert.notEqual((await apps.token("alice", auth({ repositories: ["acme/app"], permissions: { contents: "write" } }))).token, first.token);
  assert.equal(github.minted().length, 4);
});

test("the installation is the one named, the owner's, or the App's only one; a repository it is not on is refused", async t => {
  const { github, apps } = await service(t);
  assert.equal(github.tokenFor(`Bearer ${(await apps.token("alice", auth({ owner: "solo" }))).token}`)?.installation, 202);
  assert.equal(github.tokenFor(`Bearer ${(await apps.token("alice", auth({ owner: "acme" }))).token}`)?.installation, 101);
  assert.equal(github.tokenFor(`Bearer ${(await apps.token("alice", auth({ installation: 202 }))).token}`)?.installation, 202);
  await assert.rejects(apps.token("alice", auth()), /has more than one installation: say which with installation, owner or repositories/);
  await assert.rejects(apps.token("alice", auth({ repositories: ["acme/missing"] })), /GitHub App code is not installed on acme\/missing: GitHub answered HTTP 404/);
  await assert.rejects(apps.token("alice", auth({ owner: "nobody" })), /not installed for nobody/);
  await assert.rejects(apps.token("alice", auth({ installation: 999 })), (error: any) => error.status === 404 && /access_tokens: GitHub answered HTTP 404/.test(error.message));
});

test("a rotated key mints fresh tokens; a deleted App mints none, and the tokens this node held are revoked", async t => {
  const { github, apps, app } = await service(t);
  const before = await apps.token("alice", auth({ owner: "solo" }));
  await apps.update("alice", app.id, { privateKey: github.rotate() });
  const after = await apps.token("alice", auth({ owner: "solo" }));
  assert.notEqual(after.token, before.token, "minted again, under the new key");
  assert.equal(github.state.requests.filter(request => request.path.endsWith("/access_tokens")).at(-1)!.jwt, true);
  await assert.rejects(apps.update("alice", app.id, { privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" }), /privateKey must be the App's RSA private key/);
  await apps.remove("alice", "code");
  assert.equal(github.tokenFor(`Bearer ${after.token}`), undefined, "revoked at GitHub");
  await assert.rejects(apps.token("alice", auth({ owner: "solo" })), (error: any) => error.status === 404 && /GitHub App code is not one of this tenant's/.test(error.message));
  await assert.rejects(apps.remove("alice", "code"), /Unknown GitHub App code/);
});

test("an App is its tenant's alone, and a tenant holds at most 50", async t => {
  const { github, apps, app, db } = await service(t);
  await assert.rejects(apps.token("bob", auth()), /not one of this tenant's/);
  await assert.rejects(apps.get("bob", app.id), /Unknown GitHub App/);
  await assert.rejects(apps.remove("bob", app.id), /Unknown GitHub App/);
  const stored = (await db.query("select tenant, name, app from github_apps")).rows;
  assert.deepEqual(stored.map(row => [row.tenant, row.name]), [["alice", "code"]]);
  assert.doesNotMatch(JSON.stringify(stored), /PRIVATE KEY/);
  for (let index = 1; index < 50; index++) await db.query("insert into github_apps (id, tenant, name, app, created_at) values ($1, 'alice', $2, '{}', 0)", [`gha_${String(index).padStart(20, "0")}`, `app${index}`]);
  await assert.rejects(apps.create("alice", { appId: "5151", privateKey: github.state.pem, name: "more" }), /at most 50 GitHub Apps/);
});

for (const [name, body] of Object.entries(cases)) {
  test(`through the API: ${name}`, t => body(t, async (t, respond, env) => {
    const r = await runtime(t, respond, env);
    return Object.assign(r, { query: (text: string) => r.db.query(text) });
  }));
}
