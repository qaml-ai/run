import { withSql, type PostgresEnv } from "./postgres.ts";
import { HttpError } from "./errors.ts";

export type ProviderKeyEnv = PostgresEnv & { AGENT_SECRETS_KEY?: string };
export type ProviderKey = { apiKey?: string; headers?: Record<string, string>; baseUrl?: string; region?: string; platform: boolean };
type Sealed = { iv: string; tag: string; ciphertext: string };
const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
/** The same AES-GCM envelope and AAD as src/accounts.ts, read only at request time. */
export async function openProviderSecret(env: ProviderKeyEnv, aad: string, value: Sealed): Promise<string> {
  if (!env.AGENT_SECRETS_KEY || !/^[a-f0-9]{64}$/i.test(env.AGENT_SECRETS_KEY)) throw new HttpError(503, "Provider key encryption is not configured");
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(env.AGENT_SECRETS_KEY.match(/../g)!, part => Number.parseInt(part, 16)), "AES-GCM", false, ["decrypt"]);
  const ciphertext = bytes(value.ciphertext), tag = bytes(value.tag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext); combined.set(tag, ciphertext.length);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(value.iv), additionalData: new TextEncoder().encode(aad) }, key, combined));
}

/** Scope credentials take precedence; the tenant key is the fallback. No ambient AWS credentials. */
export async function resolveProviderKey(env: ProviderKeyEnv, tenant: string, provider: string, scope?: string): Promise<ProviderKey | undefined> {
  if (!env.AGENT_SECRETS_KEY) return undefined;
  if (scope) {
    const row = (await withSql(env, sql => sql.query("select sealed, settings from key_scope_providers where tenant=$1 and scope=$2 and provider=$3", [tenant, scope, provider]))).rows[0];
    if (row) return { ...row.settings, ...JSON.parse(await openProviderSecret(env, `key-scope:${tenant}:${scope}:${provider}`, row.sealed)), platform: false };
  }
  const row = (await withSql(env, sql => sql.query("select sealed, region from provider_keys where tenant=$1 and provider=$2", [tenant, provider]))).rows[0];
  return row ? { apiKey: await openProviderSecret(env, `${tenant}:${provider}`, row.sealed), ...(row.region ? { region: row.region } : {}), platform: false } : undefined;
}
