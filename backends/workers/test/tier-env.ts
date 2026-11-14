import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { registerHooks } from "node:module";

/** Supply the runtime signer with an in-memory signing key in Node tests. */
export function tierIdentity(issuer = "https://runtime.test", keys = generateKeyPairSync("ed25519") as { privateKey: KeyObject; publicKey: KeyObject }, kid = "test-tier") {
  const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" };
  return {
    issuer,
    jwks: { keys: [jwk] },
    accounts: {
      canStoreKeys: true,
      db: { query: async () => ({ rows: [{ kid, public_jwk: jwk, retired_at: null }] }) },
      unseal: () => JSON.stringify(keys.privateKey.export({ format: "jwk" })),
    },
  };
}

export function hookTierServices() {
  return registerHooks({ resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return { url: "data:text/javascript,export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } export const waitUntil=p=>p;", shortCircuit: true };
    if (specifier.endsWith("/security-services.ts"))
      return { url: "data:text/javascript,export const keyServices=async env=>({accounts:{...env.accounts,billing:{storageLimit:async()=>env.limit}}});", shortCircuit: true };
    return next(specifier, context);
  } });
}
