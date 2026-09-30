import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { AccountDeletions } from "../src/account-deletion.ts";
import { testDatabase } from "./database.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("a deletion interrupted at any step continues where it stopped, and never while another node holds it", { timeout: 60_000 }, async () => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: { admin: { tokenSha256: sha("admin-operator-token") } } }) }), db });
  await accounts.tenants.reload();
  await db.query("insert into tenants (id, github, github_id, created_at) values ('dave', 'Dave', 77, 1)");
  const { token } = await accounts.createToken("dave", "script");
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ('client_a', 'dave', '{}', 1, 'a', 'general', 'x/y'), ('client_b', 'dave', '{}', 1, 'b', 'general', 'x/y')");
  await db.query("insert into definitions (id, tenant, name, revision, spec, created_at, updated_at) values ('def_1', 'dave', 'd', 1, '{}', 1, 1)");
  await db.query("insert into credit_ledger (tenant, kind, amount, idempotency_key, created_at) values ('dave', 'grant', 5000000, 'grant:github:77', 1)");
  await db.query("insert into starting_credit_decisions (github_id, tenant, decision, offered_amount, signup_at, decided_at) values (77, 'dave', 'eligible', 5000000, 1, 1)");
  await storage.writeBlob("chunks/dave/ab/abc", Buffer.from("file contents"));
  await storage.writeBlob("chunks/other/ab/abc", Buffer.from("another tenant's"));

  let purging = false, crash = true;
  const deleted: string[] = [];
  const deletions = new AccountDeletions({
    db, accounts,
    storage: { ...storage, removeBlobs: async prefix => { if (crash) { crash = false; throw new Error("storage went away"); } return storage.removeBlobs(prefix); } },
    deleteAgent: async agent => { deleted.push(agent); await db.query("update agents set revoked = true where id = $1", [agent]); },
    // The sweep purges only once the test lets it, as it would once each agent's node let go of it.
    purgeAgents: async () => { if (purging) await db.query("update agents set tenant = '', purged_at = 1 where tenant = 'dave' and revoked"); },
  });
  const due = () => db.query("update account_deletions set claimed_until = null");

  await assert.rejects(deletions.request("admin", "self"), (error: any) => error.status === 403, "admin tenants are the tenants file's");
  await assert.rejects(deletions.request("nobody", "self"), (error: any) => error.status === 404);
  const started = await deletions.request("dave", "operator:admin");
  assert.equal(started.state, "deleting");
  await deletions.kick();
  // At once: it no longer authenticates, and sign-in no longer finds it.
  assert.equal(await accounts.exists("dave"), false);
  assert.equal(await accounts.authenticate(`Bearer ${token}`), undefined);
  assert.deepEqual((await db.query("select github, github_id from tenants where id = 'dave'")).rows, [{ github: null, github_id: null }]);

  // Its agents are deleted, but not purged yet: the deletion waits, keeping everything else.
  assert.deepEqual(deleted.sort(), ["client_a", "client_b"]);
  assert.equal((await deletions.status("dave"))!.agents, 2);
  assert.equal((await db.query("select count(*)::int as n from definitions")).rows[0].n, 1);

  // Held by another node: left alone.
  await db.query("update account_deletions set claimed_until = now() + interval '1 minute'");
  purging = true;
  assert.equal(await deletions.next(), false);

  // Purged now, but storage fails midway: the next attempt starts over, and everything done before is done again harmlessly.
  await due();
  assert.equal(await deletions.next(), true);
  assert.equal((await deletions.status("dave"))!.state, "deleting");
  assert.ok(await storage.readBlob("chunks/dave/ab/abc"), "not deleted yet");
  await due();
  assert.equal(await deletions.next(), true);
  const status = (await deletions.status("dave"))!;
  assert.equal(status.state, "deleted");

  for (const table of ["api_tokens", "definitions"]) assert.equal((await db.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0, table);
  assert.equal((await db.query("select count(*)::int as n from tenants")).rows[0].n, 0);
  assert.equal(await storage.readBlob("chunks/dave/ab/abc"), undefined);
  assert.ok(await storage.readBlob("chunks/other/ab/abc"), "another tenant's files stay");
  assert.equal((await db.query("select count(*)::int as n from credit_ledger where tenant = 'dave'")).rows[0].n, 1, "the ledger stays");
  assert.equal((await db.query("select count(*)::int as n from starting_credit_decisions where tenant = 'dave'")).rows[0].n, 1);

  // Its id is never given out again; the identity signs up under another, and its credit decision stands.
  const again = await accounts.tenantForGithub({ login: "Dave", id: 77, createdAt: 1 }, { minAccountAgeMs: 0 });
  assert.equal(again, "dave-77");
  assert.equal((await db.query("select count(*)::int as n from credit_ledger where tenant = $1", [again])).rows[0].n, 0);
  assert.equal(await deletions.next(), false, "nothing left to do");
});
