import { RuntimeSigner, type TokenClaims } from "./runtime-identity.ts";
import { keyServices, type SecurityEnv } from "./security-services.ts";
import { publicOrigins } from "./account-origins.ts";

export type IdentityEnv = SecurityEnv & { AGENT_PUBLIC_ALIASES?: string; AGENT_ISSUER?: string };
export type RuntimeIdentity = {
  tenant: string; agent: string; definition?: string; sub?: string;
  ctx?: Record<string, unknown>; act?: string; origin?: Record<string, unknown>;
  req?: string; tcid?: string; par?: string; root?: string;
  approval?: { input: string; by: Record<string, unknown>; at: number };
  exchange?: { server: string; url: string };
};
const signers = new WeakMap<IdentityEnv, { issuer: string; signer: Promise<RuntimeSigner> }>();

/** Compact transport claims use the same signer, key envelope and issuer policy as account and file tokens. */
function signer(env: IdentityEnv, fallback: string) {
  const issuer = publicOrigins(env as unknown as NodeJS.ProcessEnv, fallback).issuer;
  let entry = signers.get(env);
  if (!entry || entry.issuer !== issuer) {
    entry = { issuer, signer: keyServices(env).then(({ accounts }) => new RuntimeSigner({ db: accounts.db, accounts, issuer })) };
    signers.set(env, entry);
    void entry.signer.catch(() => { if (signers.get(env) === entry) signers.delete(env); });
  }
  return entry.signer;
}

export async function runtimeJwks(env: IdentityEnv) {
  return (await signer(env, env.PUBLIC_URL ?? "https://localhost")).jwks();
}

export async function signRuntimeIdentity(env: IdentityEnv, issuer: string, audience: string, identity: RuntimeIdentity) {
  const claims: TokenClaims = {
    tenant: identity.tenant, agent: identity.agent, definition: identity.definition,
    identity: { subject: identity.sub, context: identity.ctx }, actor: identity.act,
    origin: identity.origin, request: identity.req, toolCall: identity.tcid,
    parent: identity.par, root: identity.root, approval: identity.approval, exchange: identity.exchange,
  };
  return (await signer(env, issuer)).token(audience, claims);
}
