import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.ts";

test("legacy end-user reads preserve tenant scope and leave writes on the original route", { timeout: 180_000 }, async (t) => {
  const apiKey = "art_fixture-tenant-key";
  const fixtureUser = `legacy_credit_${randomBytes(8).toString("hex")}`;
  const creditGrants = readFileSync(new URL("../ops/legacy-credit-reads-grants.sql", import.meta.url), "utf8")
    .replaceAll(':"compatibility_role"', fixtureUser);
  const f = await startFixture({
    databaseRole: { fixtureUser, grants: `grant usage on schema public to ${fixtureUser};
      grant select on tenants, api_tokens, oauth_tokens, oauth_grants, console_sessions, account_deletions to ${fixtureUser};
      ${creditGrants}` },
    tenants: [{ id: "fixture", token: apiKey }, { id: "other", token: "art_fixture-other-tenant" }],
    vars: { AGENT_V2_COMPAT_API_KEYS: "{}" },
    entrypoint: fileURLToPath(new URL("./legacy-mcp-entry.ts", import.meta.url)),
  });
  t.after(() => f.stop());

  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  await f.db.query(`insert into end_users(tenant,id,balance,created_at,updated_at)
    values ('fixture','user',99,$1,$1), ('other','user',25,$1,$1), ('other','foreign',20,$1,$1)`, [now]);
  await f.db.query(`insert into end_user_ledger(tenant,end_user,kind,amount,raw,allowance,bucket,idempotency_key,balance_after,created_at)
    values ('fixture','user','usage',-1,2,1,'builder','fixture',99,$1), ('other','user','usage',-3,5,2,'builder','other',25,$1)`, [now]);
  await f.db.query(`insert into end_user_days(tenant,end_user,day,bucket,allowance_spent,paid_spent)
    values ('fixture','user',$1,'builder',1,1), ('other','user',$1,'builder',2,3)`, [day]);

  const read = (path: string, init: RequestInit = {}) => fetch(f.url + path, { ...init, headers: { authorization: `Bearer ${apiKey}` } });
  const list = await read("/v1/end-users");
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.deepEqual(await list.json(), { endUsers: [{ id: "user", balance: 99, createdAt: now, updatedAt: now }] });
  const usage = await read(`/v1/end-users/user/usage?from=${now}&to=${now + 1}&bucket=buil*`);
  assert.equal(usage.status, 200);
  assert.deepEqual(await usage.json(), { step: "hour", from: now, to: now + 1, rows: [{
    at: Math.floor(now / 3_600_000) * 3_600_000, bucket: "builder", call: null, agent: null, calls: 1,
    raw: 2, allowance: 1, paid: 1, writtenOff: 0,
  }] });
  const days = await read(`/v1/end-users/user/days?from=${day}&bucket=builder`);
  assert.equal(days.status, 200);
  assert.equal(days.headers.get("cache-control"), "no-store");
  assert.deepEqual(await days.json(), { days: [{ day, freeRaw: 1, paidCharged: 1, writtenOff: 0,
    granted: 0, refunded: 0, adjusted: 0, spent: 0, expired: 0, entries: 0,
    buckets: [{ bucket: "builder", freeRaw: 1, paidCharged: 1, writtenOff: 0 }],
  }] });
  const ledger = await read(`/v1/end-users/user/ledger?kind=usage&bucket=builder&from=${now}&to=${now + 1}`);
  assert.equal(ledger.status, 200);
  assert.equal(ledger.headers.get("cache-control"), "no-store");
  const { entries } = await ledger.json();
  assert.deepEqual(entries.map(({ id: _id, ...entry }: Record<string, unknown>) => entry), [{
    kind: "usage", amount: -1, raw: 2, allowance: 1, writtenOff: 0, bucket: "builder", key: "fixture",
    reference: null, description: null, metadata: {}, balanceAfter: 99, createdAt: now,
  }]);
  const detail = await read("/v1/end-users/user?buckets=builder");
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get("cache-control"), "no-store");
  const user = await detail.json();
  assert.equal(user.id, "user");
  assert.equal(user.balance, 99);
  assert.deepEqual(user.today.buckets.map(({ bucket }: { bucket: string }) => bucket), ["builder"]);
  const foreign = await read("/v1/end-users/foreign");
  assert.equal(foreign.status, 200);
  assert.equal((await foreign.json()).balance, 0);
  assert.equal((await fetch(`${f.url}/v1/end-users/user`)).status, 401);
  assert.equal((await fetch(`${f.url}/v1/end-users`)).status, 401);
  assert.equal((await fetch(`${f.url}/v1/end-users/user/ledger`)).status, 401);
  assert.equal((await read("/v1/end-users/user/days?limit=zero")).status, 400);
  const settings = await read("/v1/end-user-settings");
  assert.equal(settings.status, 200);
  const patched = await read("/v1/end-users/user", {
    method: "PATCH",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ lowBalance: 10 }),
  });
  assert.equal(patched.status, 200);
  const posted = await read("/v1/end-users/user/entries", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ kind: "grant", amount: 50, key: "compat-grant-1" }),
  });
  assert.equal(posted.status, 201);

  await f.db.query(`insert into end_users (tenant, id, balance, created_at, updated_at) values ('fixture', 'expiry', 5, $1, $1)`, [now]);
  await f.db.query(`insert into end_user_lots (tenant, end_user, key, amount, remaining, expires_at, created_at)
    values ('fixture', 'expiry', 'entry:expiring-credit', 5, 5, $1, $2)`, [now - 1, now - 100]);
  const expired = await Promise.all([read("/v1/end-users/expiry"), read("/v1/end-users/expiry")]);
  for (const response of expired) {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).balance, 0);
  }
  const { rows } = await f.db.query(`select amount::int from end_user_ledger where tenant = 'fixture' and end_user = 'expiry' and kind = 'expiry'`);
  assert.deepEqual(rows, [{ amount: -5 }]);
});
