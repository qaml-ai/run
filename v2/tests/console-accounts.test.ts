import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

const ADMIN_KEY = "test-admin-secret-console-accounts";
const VAULT_SECRET = "test-vault-secret-console-accounts";

test("DO-backed console accounts: OAuth login, email linking, password signup/login, and existing tenant linking", async t => {
  const dir = mkdtempSync(join(tmpdir(), "camelrun-console-accounts-"));
  const config = join(dir, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "console-accounts-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: ADMIN_KEY,
        VAULT_SECRET,
        CAMELFS_URL: "http://127.0.0.1:9",
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());

  const adminPost = async (path: string, body: unknown, includeAdmin = true) =>
    worker.fetch(`https://console-accounts.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(includeAdmin ? { "X-Admin-Key": ADMIN_KEY } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

  // 0. Unauthenticated admin calls are rejected
  const unauth = await adminPost("/v2/admin/console/oauth-login", { provider: "github", externalId: "1" }, false);
  assert.equal(unauth.status, 401);

  // 1. First GitHub OAuth login provisions a v2 tenant + working console API key
  const gh1Res = await adminPost("/v2/admin/console/oauth-login", {
    provider: "github",
    externalId: "9001",
    email: "dev@example.com",
    login: "devuser",
    name: "Dev User",
  });
  assert.equal(gh1Res.status, 200);
  const gh1 = (await gh1Res.json()) as { tenantId: string; apiKey: string; created: boolean };
  assert.equal(gh1.created, true);
  assert.ok(gh1.tenantId.startsWith("tnt_"));
  assert.ok(gh1.apiKey.startsWith("cr_live_"));

  // Verify the minted API key works against /v2/me
  const meRes = await worker.fetch("https://console-accounts.test/v2/me", {
    headers: { Authorization: `Bearer ${gh1.apiKey}` },
  });
  assert.equal(meRes.status, 200);
  const me = (await meRes.json()) as { tenantId: string; name: string };
  assert.equal(me.tenantId, gh1.tenantId);

  // 2. Subsequent Google OAuth login with the same verified email resolves to the SAME tenant
  const googRes = await adminPost("/v2/admin/console/oauth-login", {
    provider: "google",
    externalId: "goog-sub-555",
    email: "DEV@EXAMPLE.COM",
    name: "Dev User",
  });
  assert.equal(googRes.status, 200);
  const goog = (await googRes.json()) as { tenantId: string; apiKey: string; created: boolean };
  assert.equal(goog.created, false);
  assert.equal(goog.tenantId, gh1.tenantId);
  assert.equal(goog.apiKey, gh1.apiKey);

  // 3. Password signup validates min 8 chars, creates a new tenant, rejects duplicate email with 409
  const shortPw = await adminPost("/v2/admin/console/password-signup", {
    email: "ada@example.com",
    password: "short",
  });
  assert.equal(shortPw.status, 400);

  const signupRes = await adminPost("/v2/admin/console/password-signup", {
    email: "ada@example.com",
    password: "correct-horse-battery",
    name: "Ada Lovelace",
  });
  assert.equal(signupRes.status, 201);
  const signup = (await signupRes.json()) as { tenantId: string; apiKey: string; email: string; created: boolean };
  assert.equal(signup.created, true);
  assert.equal(signup.email, "ada@example.com");
  assert.notEqual(signup.tenantId, gh1.tenantId);

  const dupSignup = await adminPost("/v2/admin/console/password-signup", {
    email: "ADA@EXAMPLE.COM",
    password: "another-valid-password",
  });
  assert.equal(dupSignup.status, 409);

  // 4. Password login succeeds with right password and returns generic 401 on wrong password or unknown email
  const loginOkRes = await adminPost("/v2/admin/console/password-login", {
    email: "Ada@Example.com",
    password: "correct-horse-battery",
  });
  assert.equal(loginOkRes.status, 200);
  const loginOk = (await loginOkRes.json()) as { tenantId: string; apiKey: string };
  assert.equal(loginOk.tenantId, signup.tenantId);
  assert.equal(loginOk.apiKey, signup.apiKey);

  const wrongPw = await adminPost("/v2/admin/console/password-login", {
    email: "ada@example.com",
    password: "wrong-password-123",
  });
  assert.equal(wrongPw.status, 401);
  assert.equal(((await wrongPw.json()) as { error: { message: string } }).error.message, "Wrong email or password");

  const unknownEmail = await adminPost("/v2/admin/console/password-login", {
    email: "nobody@example.com",
    password: "correct-horse-battery",
  });
  assert.equal(unknownEmail.status, 401);
  assert.equal(((await unknownEmail.json()) as { error: { message: string } }).error.message, "Wrong email or password");

  // 5. Linking an existing v2 tenant (e.g. pre-seeded prod tenant with credits) to email + GitHub login
  const seededRes = await adminPost("/v2/tenants", { name: "Miguel Prod", initialCreditsUsd: 75 });
  assert.equal(seededRes.status, 201);
  const seeded = (await seededRes.json()) as { tenantId: string; balanceUsd: number };

  const linkRes = await adminPost("/v2/admin/console/link", {
    tenantId: seeded.tenantId,
    email: "miguel@camelai.com",
    githubLogin: "MikeyS",
  });
  assert.equal(linkRes.status, 200);

  // Signing in via GitHub with matching login lands directly in the pre-seeded tenant with $75 balance
  const linkedGhRes = await adminPost("/v2/admin/console/oauth-login", {
    provider: "github",
    externalId: "7777",
    login: "mikeys",
    name: "Miguel",
  });
  assert.equal(linkedGhRes.status, 200);
  const linkedGh = (await linkedGhRes.json()) as { tenantId: string; apiKey: string; created: boolean };
  assert.equal(linkedGh.created, false);
  assert.equal(linkedGh.tenantId, seeded.tenantId);

  const linkedMeRes = await worker.fetch("https://console-accounts.test/v2/me", {
    headers: { Authorization: `Bearer ${linkedGh.apiKey}` },
  });
  assert.equal(linkedMeRes.status, 200);
  assert.equal(((await linkedMeRes.json()) as { balanceUsd: number }).balanceUsd, 75);
});
