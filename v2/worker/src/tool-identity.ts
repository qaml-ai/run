import { importJWK, SignJWT, type JWK } from "jose";
import { ApiError, type AgentConfig, type Env } from "./types.ts";

export type ToolApproval = { input: string; by: { id: string }; at: number };
export type ToolCallIdentity = { runId: string; callId: string; approval?: ToolApproval };

function signingKey(env: Env) {
  if (!env.TOOL_IDENTITY_ISSUER || !env.TOOL_IDENTITY_PRIVATE_JWK) {
    throw new ApiError(503, "tool_identity_unavailable", "Runtime tool identity is not configured");
  }
  let jwk: JWK;
  try {
    jwk = JSON.parse(env.TOOL_IDENTITY_PRIVATE_JWK) ?? {};
  } catch {
    throw new ApiError(503, "tool_identity_unavailable", "Invalid runtime tool signing key");
  }
  const { kty, crv, x, d, kid } = jwk;
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || typeof d !== "string" || typeof kid !== "string" || !kid) {
    throw new ApiError(503, "tool_identity_unavailable", "Invalid runtime tool signing key");
  }
  return { issuer: env.TOOL_IDENTITY_ISSUER.replace(/\/+$/, ""), privateKey: { kty, crv, x, d, kid }, publicKey: { kty, crv, x, kid, alg: "EdDSA", use: "sig" } };
}

export function toolIdentityKeys(env: Env) {
  return { keys: [signingKey(env).publicKey] };
}

export async function signToolIdentity(env: Env, agent: AgentConfig, audience: string, call?: ToolCallIdentity) {
  const { issuer, privateKey } = signingKey(env);
  const key = await importJWK(privateKey, "EdDSA");
  return new SignJWT({
    tenant: agent.tenantId,
    agent: agent.id,
    ...(agent.definition ? { definition: agent.definition } : {}),
    ...(agent.toolIdentity?.context ? { ctx: agent.toolIdentity.context } : {}),
    ...(call ? { req: call.runId, tcid: call.callId } : {}),
    ...(call?.approval ? { approval: call.approval } : {}),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: privateKey.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(agent.toolIdentity?.subject ?? agent.id)
    .setIssuedAt()
    .setExpirationTime("2 min")
    .setJti(crypto.randomUUID())
    .sign(key);
}
