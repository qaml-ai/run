import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// The operator entry point is plain Node JavaScript; importing never runs its CLI.
// @ts-ignore JavaScript operator helper has no declaration file.
import { setupPilotAdmin, writePilotAdminKey } from "../scripts/pilot-admin-key.mjs";

test("pilot admin credit failure revokes only the new key and leaves a retryable tenant", async () => {
  const calls: string[] = [];
  const key = { id: "00000000-0000-0000-0000-000000000001", token: "unused-test-placeholder" };
  const operator = { async request(path: string, init: { method?: string } = {}) {
    calls.push(`${init.method ?? "POST"} ${path}`);
    if (path.startsWith("/pilot/inspect")) return { tenants: 0, deleted_tenants: 0, deleting_tenants: 0 };
    if (path === "/v1/tenants") return { tenant: "pilot-admin", token: key };
    if (path === "/v1/billing/adjustments") throw new Error("simulated grant failure");
    return { revoked: true };
  } };
  await assert.rejects(setupPilotAdmin(operator), /new key was revoked/);
  assert.ok(calls.includes(`DELETE /v1/tenants/pilot-admin/tokens/${key.id}`));
  assert.ok(!calls.includes("DELETE /v1/tenants/pilot-admin"));
});

test("pilot admin retry mints through the existing tenant's bounded token path", async () => {
  const calls: string[] = [];
  const operator = { async request(path: string) {
    calls.push(path);
    if (path.startsWith("/pilot/inspect")) return { tenants: 1, deleted_tenants: 0, deleting_tenants: 0 };
    if (path.endsWith("/tokens")) return { id: "00000000-0000-0000-0000-000000000002", token: "unused-test-placeholder" };
    return {};
  } };
  assert.equal((await setupPilotAdmin(operator)).tenant, "pilot-admin");
  assert.ok(calls.includes("/v1/tenants/pilot-admin/tokens"));
  assert.ok(!calls.includes("/v1/tenants"));
});

test("pilot admin never retries a permanently deleted tenant identifier", async () => {
  let calls = 0;
  await assert.rejects(setupPilotAdmin({ async request() { calls++; return { tenants: 0, deleted_tenants: 1 }; } }), /cannot be reused/);
  assert.equal(calls, 1);
});

const fixtureToken = { id: "test-key-id", token: "unused-test-placeholder" };
const fixtureOperator = { async request(path: string) {
  if (path.startsWith("/pilot/inspect")) return { tenants: 1 };
  if (path.endsWith("/tokens")) return fixtureToken;
  return {};
} };
type Provision = (operator: typeof fixtureOperator) => Promise<unknown>;

test("admin key output is private and an existing path cannot mint a second key", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pilot-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "keys", "pilot-admin.key");
  const result = await writePilotAdminKey(file, (options: unknown, provision: Provision) => {
    assert.deepEqual(options, { tenantIds: ["pilot-admin"] });
    return provision(fixtureOperator);
  });
  assert.deepEqual(result, { tenant: "pilot-admin", keyId: fixtureToken.id });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(writePilotAdminKey(file, () => assert.fail("operator must not run")), { code: "EEXIST" });
  assert.equal(await readFile(file, "utf8"), `${fixtureToken.token}\n`);
});

test("admin key output is removed after setup failure and retained after bootstrap cleanup failure", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pilot-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "pilot-admin.key");
  const setupFailure = new Error("bootstrap setup failed");
  await assert.rejects(writePilotAdminKey(file, () => { throw setupFailure; }), setupFailure);
  await assert.rejects(stat(file), { code: "ENOENT" });

  const cleanupFailure = new Error("bootstrap cleanup failed");
  await assert.rejects(writePilotAdminKey(file, async (_options: unknown, provision: Provision) => {
    await provision(fixtureOperator);
    throw cleanupFailure;
  }), cleanupFailure);
  assert.equal(await readFile(file, "utf8"), `${fixtureToken.token}\n`);
});
