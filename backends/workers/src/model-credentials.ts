import { withSql, type PostgresEnv } from "./postgres.ts";
import type { CustomProviders } from "./model-policy.ts";
import { HttpError } from "./errors.ts";
import { keyServices, providerCredentials, type KeyEnv } from "./security-services.ts";

export type ProviderKeyEnv = PostgresEnv & { AGENT_SECRETS_KEY?: string; API_TOKEN?: string; TEST_MODE?: string };
export type ProviderKey = { apiKey?: string; headers?: Record<string, string>; baseUrl?: string; region?: string; bearer?: true; platform: boolean };
export type Sealed = { iv: string; tag: string; ciphertext: string };
const bytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
async function secretKey(env: ProviderKeyEnv, use: "encrypt" | "decrypt") {
  const key = env.AGENT_SECRETS_KEY;
  const raw = key && /^[a-f0-9]{64}$/i.test(key)
    ? Uint8Array.from(key.match(/../g)!, part => Number.parseInt(part, 16))
    : env.TEST_MODE === "1" && env.API_TOKEN
      ? new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.API_TOKEN)))
      : undefined;
  if (!raw) throw new HttpError(503, "Provider key encryption is not configured");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [use]);
}
/** Writes the same envelope as the Node runtime; test-only local deployments derive a disposable key. */
export async function sealProviderSecret(env: ProviderKeyEnv, aad: string, value: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name:"AES-GCM", iv, additionalData:new TextEncoder().encode(aad) }, await secretKey(env, "encrypt"), new TextEncoder().encode(value)));
  const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
  return { iv:base64(iv), ciphertext:base64(sealed.subarray(0, -16)), tag:base64(sealed.subarray(-16)) };
}
/** The same AES-GCM envelope and AAD as src/accounts.ts, read only at request time. */
export async function openProviderSecret(env: ProviderKeyEnv, aad: string, value: Sealed): Promise<string> {
  const key = await secretKey(env, "decrypt");
  const ciphertext = bytes(value.ciphertext), tag = bytes(value.tag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext); combined.set(tag, ciphertext.length);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(value.iv), additionalData: new TextEncoder().encode(aad) }, key, combined));
}

/** Scope credentials take precedence; the tenant key is the fallback. No ambient AWS credentials. */
export async function resolveProviderKey(env: ProviderKeyEnv, tenant: string, provider: string, scope?: string): Promise<ProviderKey | undefined> {
  const credentials = await providerCredentials(await keyServices(env as KeyEnv), tenant, provider, scope);
  // Auxiliary work is platform-funded only for the actual platform key.
  // Operator-configured tenant keys retain model billing attribution separately.
  return credentials && { ...credentials, platform: credentials.source === "platform" };
}

/** Only public declarations enter the synchronous model resolver; keys stay in the request hook. */
export async function resolveCustomProviders(env: PostgresEnv, tenant: string, scope?: string): Promise<CustomProviders> {
  const rows = (await withSql(env, sql => sql.query("select name,config from model_providers where tenant=$1 and (scope='' or scope=$2) order by scope desc", [tenant, scope ?? ""]))).rows;
  const providers: Exclude<CustomProviders, undefined> = {};
  for (const row of rows) if (!providers[row.name]) providers[row.name] = { type: row.config.type === "openai-compatible" ? "openai-completions" : row.config.type, baseUrl: row.config.baseUrl, models: row.config.models };
  return Object.keys(providers).length ? providers : undefined;
}
