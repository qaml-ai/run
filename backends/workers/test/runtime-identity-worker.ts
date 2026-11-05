import { createLocalJWKSet, jwtVerify } from "jose";
import { keyServices, type SecurityEnv } from "../src/security-services.ts";
import { RuntimeSigner, type TokenClaims } from "../src/runtime-identity.ts";

/** Local test entrypoint only. No signing endpoint is added to the runtime HTTP API. */
export default {
  async fetch(request: Request, env: SecurityEnv & { TEST_MODE?: string; AGENT_ISSUER: string }) {
    if (env.TEST_MODE !== "1") return new Response(null, { status: 404 });
    if (new URL(request.url).pathname === "/healthz") return Response.json({ ok: true });
    const { accounts } = await keyServices(env);
    const signer = new RuntimeSigner({ db: accounts.db, accounts, issuer: env.AGENT_ISSUER });
    const { audience, claims } = await request.json() as { audience: string; claims: TokenClaims };
    const token = await signer.token(audience, claims);
    const verified = await jwtVerify(token, createLocalJWKSet(await signer.jwks()), { issuer: env.AGENT_ISSUER, audience, algorithms: ["EdDSA"] });
    return Response.json({ token, payload: verified.payload });
  },
};
