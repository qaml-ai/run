// Real-tier mode (CAMELFS_CONTRACT_URL/KEY) is only for a tier you start
// yourself, locally or on a Sprite, with DynamoDB Local and its own throwaway
// test key. Never target production or staging. Their JWKS trusts only the
// runtime's real signer.
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { test } from "node:test";
import { mintCamelfsToken } from "../backends/workers/test/camelfs-token.ts";
import { runCamelfsRefsCases } from "./contract/camelfs-refs-cases.ts";

const { CAMELFS_CONTRACT_URL: url, CAMELFS_CONTRACT_KEY: key, CAMELFS_CONTRACT_KID: kid,
  CAMELFS_CONTRACT_ISS: issuer, CAMELFS_REFS_CONTRACT_REQUIRED: required } = process.env;

test("camelFS refs contract against a self-started tier", {
  skip: !(url && key && kid && issuer) && required !== "1" ? "configure a self-started camelFS tier with a throwaway test key" : false,
  timeout: 120_000,
}, async t => {
  assert.ok(url && key && kid && issuer, "set CAMELFS_CONTRACT_URL, CAMELFS_CONTRACT_KEY, CAMELFS_CONTRACT_KID and CAMELFS_CONTRACT_ISS");
  const privateKey = createPrivateKey({ key, format: "pem", type: "pkcs8" });
  assert.equal(privateKey.asymmetricKeyType, "ed25519");
  await runCamelfsRefsCases(t, {
    url, issuer, mint: (claims, header) => mintCamelfsToken(privateKey, kid, claims, header),
  });
});
