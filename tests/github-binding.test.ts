import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import type { Db } from "../src/db.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const DAY = 86_400_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function accountsOn(db: Db, tenants: Record<string, object>) {
  const file = new Tenants({ read: async () => JSON.stringify({ tenants }) });
  await file.reload();
  return new Accounts({ db, tenants: file });
}

test("an admin tenant linked by login is bound to the first account that signs in with it, not to whoever takes the login later", async () => {
  const { db } = await testDatabase();
  const accounts = await accountsOn(db, { ops: { tokenSha256: sha("ops-token"), github: "Miguel" } });
  const miguel = { login: "miguel", id: 100, createdAt: Date.now() - 900 * DAY };
  // The first sign-in after the change binds the account by its numeric id.
  assert.equal(await accounts.tenantForGithub(miguel, { minAccountAgeMs: 0 }), "ops");
  assert.equal(await accounts.tenantForGithub(miguel, { minAccountAgeMs: 0 }), "ops");
  // A renamed account keeps the tenant; the freed login now names someone else, who does not get it.
  assert.equal(await accounts.tenantForGithub({ ...miguel, login: "miguel-renamed" }, { minAccountAgeMs: 0 }), "ops");
  const squatter = await accounts.tenantForGithub({ login: "Miguel", id: 666, createdAt: Date.now() - DAY }, { minAccountAgeMs: 0 });
  assert.notEqual(squatter, "ops");
  // An admin who points the entry at another login rebinds it to the next account to sign in with that login.
  const moved = await accountsOn(db, { ops: { tokenSha256: sha("ops-token"), github: "someone-else" } });
  assert.notEqual(await moved.tenantForGithub(miguel, { minAccountAgeMs: 0 }), "ops");
  assert.equal(await moved.tenantForGithub({ login: "someone-else", id: 200, createdAt: 1 }, { minAccountAgeMs: 0 }), "ops");
});

test("a tenants-file githubId binds an admin tenant to that account only", async () => {
  const { db } = await testDatabase();
  const accounts = await accountsOn(db, { ops: { tokenSha256: sha("ops-token"), github: "miguel", githubId: 100 } });
  assert.notEqual(await accounts.tenantForGithub({ login: "miguel", id: 666, createdAt: Date.now() - 900 * DAY }, { minAccountAgeMs: 0 }), "ops");
  assert.equal(await accounts.tenantForGithub({ login: "anything", id: 100, createdAt: 1 }, { minAccountAgeMs: 0 }), "ops");
  await assert.rejects(accountsOn(db, { a: { tokenSha256: sha("a"), githubId: 1 }, b: { tokenSha256: sha("b"), githubId: 1 } }), /another tenant's githubId/);
  await assert.rejects(accountsOn(db, { a: { tokenSha256: sha("a"), githubId: "1" } }), /invalid githubId/);
});

test("a self-serve tenant from before numeric ids is never bound to an account made after it", async () => {
  const { db } = await testDatabase();
  const made = Date.now() - 100 * DAY;
  await db.query("insert into tenants (id, github, created_at) values ('olduser', 'olduser', $1)", [made]);
  const accounts = await accountsOn(db, {});
  // Someone who registered the freed login afterwards gets a tenant of their own.
  const newcomer = await accounts.tenantForGithub({ login: "olduser", id: 300, createdAt: made + DAY }, { minAccountAgeMs: 0 });
  assert.notEqual(newcomer, "olduser");
  // The account that made it (older than the tenant) is bound on its next sign-in, and only it thereafter.
  assert.equal(await accounts.tenantForGithub({ login: "olduser", id: 301, createdAt: made - DAY }, { minAccountAgeMs: 0 }), "olduser");
  assert.equal((await db.query("select github_id from tenants where id = 'olduser'")).rows[0].github_id, 301);
  // A sign-in without the numeric id is refused rather than matched by login.
  await assert.rejects(accounts.tenantForGithub({ login: "olduser" }), /valid account/);
});
