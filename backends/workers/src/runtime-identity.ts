import { withSql, type PostgresEnv } from "./postgres.ts";
import { openProviderSecret } from "./model-credentials.ts";
import { HttpError } from "./errors.ts";

export type IdentityEnv = PostgresEnv & { AGENT_SECRETS_KEY?: string };
export type RuntimeIdentity = {
  tenant: string; agent: string; definition?: string; sub?: string;
  ctx?: Record<string, unknown>; act?: string; origin?: Record<string, unknown>;
  req?: string; tcid?: string; par?: string; root?: string;
  approval?: { input: string; by: Record<string, unknown>; at: number };
};
type KeyRow = { kid: string; public_jwk: JsonWebKey; private_sealed: { iv: string; tag: string; ciphertext: string }; retired_at: number | null };
const cache = new WeakMap<IdentityEnv, { expires: number; keys: Promise<{ publicKeys: JsonWebKey[]; kid: string; key: CryptoKey }> }>();
const bytes = (text: string) => new TextEncoder().encode(text);
const base64 = (value: Uint8Array) => btoa(String.fromCharCode(...value));
const encoded = (value: unknown) => base64(bytes(JSON.stringify(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Same envelope and AAD as src/accounts.ts and src/identity.ts. */
async function sealKey(env: IdentityEnv, kid: string, privateKey: JsonWebKey) {
  if (!env.AGENT_SECRETS_KEY || !/^[a-f0-9]{64}$/i.test(env.AGENT_SECRETS_KEY)) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot sign identity tokens");
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(env.AGENT_SECRETS_KEY.match(/../g)!, value => Number.parseInt(value, 16)), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bytes(`runtime-signing:${kid}`) }, key, bytes(JSON.stringify(privateKey))));
  return { iv: base64(iv), ciphertext: base64(encrypted.subarray(0, -16)), tag: base64(encrypted.subarray(-16)) };
}

async function loadKeys(env: IdentityEnv) {
  return withSql(env, async sql => {
    const read = async () => (await sql.query<KeyRow>("select kid, public_jwk, private_sealed, retired_at from signing_keys order by created_at, kid")).rows;
    let rows = await read();
    if (!rows.some(row => row.retired_at === null)) {
      const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
      const kid = crypto.randomUUID(), publicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey) as JsonWebKey, privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey) as JsonWebKey;
      await sql.query("insert into signing_keys(kid,public_jwk,private_sealed,created_at) values($1,$2,$3,$4)", [kid, { ...publicJwk, kid, alg: "EdDSA", use: "sig" }, await sealKey(env, kid, privateJwk), Date.now()]);
      rows = await read();
    }
    const active = rows.find(row => row.retired_at === null)!;
    const privateJwk = JSON.parse(await openProviderSecret(env, `runtime-signing:${active.kid}`, active.private_sealed));
    const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "Ed25519" }, false, ["sign"]);
    return { publicKeys: rows.map(row => row.public_jwk), key, kid: active.kid };
  });
}
function keys(env: IdentityEnv) {
  let current = cache.get(env);
  if (!current || current.expires < Date.now()) {
    current = { expires: Date.now() + 600_000, keys: loadKeys(env) }; cache.set(env, current);
    void current.keys.catch(() => { if (cache.get(env) === current) cache.delete(env); });
  }
  return current.keys;
}
export async function runtimeJwks(env: IdentityEnv) { return { keys: (await keys(env)).publicKeys }; }

export async function signRuntimeIdentity(env: IdentityEnv, issuer: string, audience: string, identity: RuntimeIdentity) {
  const signing = await keys(env), now = Math.floor(Date.now() / 1000);
  const claims = Object.fromEntries(Object.entries(identity).filter(([, value]) => value !== undefined));
  const unsigned = `${encoded({ alg: "EdDSA", kid: signing.kid, typ: "JWT" })}.${encoded({ ...claims, sub: identity.sub ?? identity.agent, iss: issuer.replace(/\/+$/, ""), aud: audience, iat: now, exp: now + 120, jti: crypto.randomUUID() })}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signing.key, bytes(unsigned)));
  return `${unsigned}.${base64(signature).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
