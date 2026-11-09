import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { registerHooks } from "node:module";
// The operator also imports unrelated Durable Object routes. Fail if this test
// ever tries to instantiate one; the password route uses only Postgres.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor() { throw new Error('Unexpected Durable Object'); } }", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { default: pilotOperator } = await import("../scripts/pilot-operator-worker.ts");
hooks.deregister();
import { Passwords } from "../src/account-passwords.ts";
import { testDatabase } from "./billing-database.ts";
// @ts-ignore JavaScript operator helper has no declaration file.
import { setConsolePassword, readPassword } from "../scripts/pilot-console-password.mjs";

test("pilot password route sets an existing allowed tenant and refuses other methods, paths and tenants", async () => {
  const { db, url } = await testDatabase();
  await db.query("insert into tenants(id, created_at) values ('pilot-camel-code', $1), ('pilot-other', $1)", [Date.now()]);
  const token = "pilot-operator-test-token-at-least-32-characters";
  const operator = pilotOperator({ tenantIds: ["pilot-camel-code", "pilot-missing"], tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: Date.now() + 60_000 });
  const env = { HYPERDRIVE: { connectionString: url }, AGENT_SECRETS_KEY: "ab".repeat(32) };
  const call = (path: string, method = "PUT") => operator.fetch(new Request(`https://operator.example.test${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify({ email: "cto@example.test", password: "unit test only password" }) }),
  }), env as any, {} as ExecutionContext);
  const path = "/v1/tenants/pilot-camel-code/password";
  assert.equal((await call(path)).status, 200);
  assert.equal(await new Passwords(db).verify("cto@example.test", "unit test only password"), "pilot-camel-code");
  for (const method of ["GET", "POST", "DELETE", "PATCH"]) assert.equal((await call(path, method)).status, 404);
  assert.equal((await call("/v1/tenants/pilot-other/password")).status, 403);
  assert.equal((await call("/v1/tenants/pilot-missing/password")).status, 404);
  for (const suffix of ["password/", "password/extra", "passwords", "provider"]) {
    assert.equal((await call(`/v1/tenants/pilot-camel-code/${suffix}`)).status, 404);
  }
  assert.equal(await new Passwords(db).verify("cto@example.test", "unit test only password"), "pilot-camel-code");
});

test("console helper sends only the password PUT scoped to its existing tenant", async () => {
  let calls = 0;
  const message = await setConsolePassword("pilot-camel-code", " CTO@Example.test ", {
    read: async () => "unit test only password",
    operate: async (options: unknown, callback: Function) => {
      assert.deepEqual(options, { tenantIds: ["pilot-camel-code"] });
      await callback({ request: async (path: string, init: unknown) => {
        calls++;
        assert.equal(path, "/v1/tenants/pilot-camel-code/password");
        assert.deepEqual(init, { method: "PUT", body: { email: "cto@example.test", password: "unit test only password" } });
      } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(message, "Password set for cto@example.test on pilot-camel-code. Sign in at https://run-pilot.camelai.dev/console");
});

test("password entry requires a TTY and input validation happens before operator deployment", async () => {
  await assert.rejects(readPassword({ isTTY: false }, { isTTY: true }), /interactive terminal/);
  const options = { read: async () => { throw new Error("must not prompt"); }, operate: async () => { throw new Error("must not deploy"); } };
  await assert.rejects(setConsolePassword("production", "cto@example.test", options), /pilot-/);
  await assert.rejects(setConsolePassword("pilot-camel-code", "invalid", options), /email/);
});

for (const scenario of ["match", "mismatch", "short", "cancel"]) {
  test(`password prompt hides input and restores terminal mode: ${scenario}`, async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; return this; } });
    let shown = "";
    const password = "unit test only password";
    const output = Object.assign(new Writable({ write(chunk, _encoding, done) {
      shown += chunk.toString();
      if (chunk.toString() === "Password: ") setImmediate(() => input.write(scenario === "cancel" ? "\x03" : (scenario === "short" ? "short" : password) + "\n"));
      if (chunk.toString() === "Confirm password: ") setImmediate(() => input.write((scenario === "mismatch" ? "different test password" : password) + "\n"));
      done();
    } }), { isTTY: true });
    if (scenario === "match") assert.equal(await readPassword(input, output), password);
    else await assert.rejects(readPassword(input, output), scenario === "short" ? /12 to 256/ : scenario === "cancel" ? /cancelled/ : /do not match/);
    assert.equal(input.isRaw, false);
    assert.ok(!shown.includes(password));
    assert.ok(!shown.includes("short"));
    assert.ok(!shown.includes("different test password"));
    input.destroy();
    output.destroy();
  });
}
