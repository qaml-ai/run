import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalJWKSet, jwtVerify } from "jose";
import { RuntimeSigner } from "../src/runtime-identity.ts";
import { keyServices } from "../src/security-services.ts";
import { startFixture } from "./fixture.ts";
import { LocalWorker, unusedPort } from "./local-worker.ts";

test("public JWKS and source Ed25519 signing roundtrip work in workerd and Node", { timeout: 120_000 }, async t => {
  const issuer = "https://runtime.example.test";
  const r = await startFixture({ vars: { AGENT_PUBLIC_URL: issuer } });
  t.after(() => r.stop());
  const published = await fetch(r.url + "/.well-known/jwks.json");
  assert.equal(published.status, 200);
  assert.equal(published.headers.get("Cache-Control"), "public, max-age=300");
  const jwks = await published.json() as { keys: any[] };
  assert.ok(jwks.keys.length > 0, "the real source signer creates a key");
  for (const key of jwks.keys) {
    assert.deepEqual([key.kty, key.crv, key.alg, key.use, key.d], ["OKP", "Ed25519", "EdDSA", "sig", undefined]);
    assert.ok(key.kid && key.x);
  }
  const secret = "0".repeat(64);
  const { accounts } = await keyServices({ HYPERDRIVE: { connectionString: r.databaseUrl }, AGENT_SECRETS_KEY: secret });
  const nodeSigner = new RuntimeSigner({ db: accounts.db, accounts, issuer });
  const audience = "https://tools.example.test/mcp", claims = { tenant: "camelrun-proto-local", agent: "client_fixture", identity: { subject: "end-user", context: { workspace: "ws_1" } }, actor: "assistant", request: "request_1", toolCall: "call_1" };
  const nodeToken = await nodeSigner.token(audience, claims);
  const decoded = await jwtVerify(nodeToken, createLocalJWKSet(jwks), { issuer, audience, algorithms: ["EdDSA"] });
  assert.equal(decoded.payload.sub, "end-user");
  assert.equal(decoded.payload.exp! - decoded.payload.iat!, 120);
  const storage = await mkdtemp(join(tmpdir(), "camelrun-proto-identity-test-"));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const config = join(storage, "wrangler.json");
  await writeFile(config, JSON.stringify({
    name: "camelrun-proto-identity-local", main: fileURLToPath(new URL("./runtime-identity-worker.ts", import.meta.url)),
    compatibility_date: "2026-11-05", compatibility_flags: ["nodejs_compat"], workers_dev: false, preview_urls: false,
    hyperdrive: [{ binding: "HYPERDRIVE", id: "00000000000000000000000000000000", localConnectionString: r.databaseUrl }],
    vars: { TEST_MODE: "1", AGENT_SECRETS_KEY: secret, AGENT_ISSUER: issuer },
  }));
  const worker = new LocalWorker(await unusedPort(), storage, config);
  t.after(() => worker.stop());
  await worker.start();
  const native = await fetch(worker.url + "/sign", { method: "POST", body: JSON.stringify({ audience, claims }) });
  assert.equal(native.status, 200);
  const signed = await native.json() as { token: string; payload: Record<string, any> };
  const verified = await jwtVerify(signed.token, createLocalJWKSet(jwks), { issuer, audience, algorithms: ["EdDSA"] });
  assert.deepEqual(signed.payload, verified.payload);
  assert.deepEqual([verified.payload.tenant, verified.payload.agent, verified.payload.sub, verified.payload.act, verified.payload.req, verified.payload.tcid, verified.payload.ctx],
    [claims.tenant, claims.agent, "end-user", claims.actor, claims.request, claims.toolCall, { workspace: "ws_1" }]);
  const row = (await r.db.query("select public_jwk, private_sealed from signing_keys")).rows[0];
  assert.equal(row.public_jwk.d, undefined);
  assert.deepEqual(Object.keys(row.private_sealed).sort(), ["ciphertext", "iv", "tag"]);
  assert.equal((await r.db.query("select count(*)::int count from signing_keys")).rows[0].count, jwks.keys.length, "signers reuse the published key");
});
