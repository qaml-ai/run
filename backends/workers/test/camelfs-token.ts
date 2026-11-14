import { createPublicKey, sign, verify } from "node:crypto";
import type { JsonWebKey, KeyObject } from "node:crypto";

export type TokenClaims = Record<string, unknown>;
export type Holder = { host: string; boot: number; mount: string };
export type Fence = { holder: Holder; epoch: number };
export type CamelfsTokenOptions = {
  issuer?: string;
  jwks?: { keys: (JsonWebKey & { kid?: string })[] };
};

export function mintCamelfsToken(privateKey: KeyObject, kid: string, claims: TokenClaims, header = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "EdDSA", typ: "camelfs+jwt", kid, ...header })}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// JSON.parse validates the syntax. Track object keys separately, including escaped
// spellings of the same key, before accepting the parsed claims.
function jwtObject(bytes: Buffer) {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(raw);
  if (!record(value)) throw new Error("JWT segment must be an object");
  const stack: (Set<string> | null)[] = [];
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:]/g)) {
    const part = match[0];
    if (part === "{" || part === "[") stack.push(part === "{" ? new Set() : null);
    else if (part === "}" || part === "]") stack.pop();
    else if (part.startsWith('"') && /^\s*:/.test(raw.slice(match.index + part.length))) {
      const key: string = JSON.parse(part);
      const keys = stack.at(-1);
      if (keys?.has(key)) throw new Error("duplicate JSON key");
      keys?.add(key);
    }
  }
  return value;
}

export function tokenVerifier({ jwks, issuer = "https://runtime.contract.example" }: CamelfsTokenOptions) {
  const keys = new Map<string, KeyObject>();
  for (const key of jwks?.keys ?? []) {
    if (key.kty === "OKP" && key.crv === "Ed25519" && key.kid) {
      keys.set(key.kid, createPublicKey({ key, format: "jwk" }));
    }
  }
  return (authorization: string | null, now: number) => {
    const token = /^Bearer ([^ ]+)$/i.exec(authorization ?? "")?.[1];
    if (!token) throw new Error("missing bearer token");
    if (token.length > 8192) throw new Error("token exceeds 8 KiB");
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("malformed token");
    const [h, p, signature] = parts.map(part => Buffer.from(part, "base64url"));
    if ([h, p, signature].some((bytes, i) => bytes.toString("base64url") !== parts[i])) throw new Error("malformed token");
    const header = jwtObject(h);
    if (header.alg !== "EdDSA") throw new Error("alg must be EdDSA");
    if (header.typ !== "camelfs+jwt") throw new Error("typ must be camelfs+jwt");
    if (["jwk", "jku", "x5u", "crit"].some(field => field in header)) throw new Error("unsupported JWT header");
    const key = typeof header.kid === "string" && keys.get(header.kid);
    if (!key) throw new Error("unknown kid");
    if (!verify(null, Buffer.from(parts.slice(0, 2).join(".")), key, signature)) throw new Error("invalid signature");
    const { iss, aud, sub, iat, exp, lin, acc, refs, fence } = jwtObject(p);
    if (iss !== issuer) throw new Error("invalid issuer");
    if (aud !== "camelrun:camelfs") throw new Error("invalid audience");
    if (typeof sub !== "string" || !sub) throw new Error("invalid subject");
    if (typeof iat !== "number" || !Number.isSafeInteger(iat)) throw new Error("iat must be an integer");
    if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= iat) throw new Error("exp must be an integer after iat");
    if (exp <= Math.floor(now / 1000)) throw new Error("token expired");
    if (iat > Math.floor(now / 1000) + 5) throw new Error("iat is more than 5 seconds in the future");
    if (exp - iat > 900) throw new Error("token lifetime exceeds 15 minutes");
    if (typeof lin !== "string" || !/^[ -~]{1,128}$/.test(lin) || /[/\\]/.test(lin) || lin === "." || lin === "..") {
      throw new Error("invalid lineage claim");
    }
    if (acc !== "r" && acc !== "w") throw new Error("acc must be r or w");
    if (!Array.isArray(refs) || refs.length > 64 || refs.some(ref => typeof ref !== "string" || !/^[A-Za-z0-9._*-]+(?:\/[A-Za-z0-9._*-]+)*$/.test(ref))) {
      throw new Error("invalid refs claim");
    }
    // Inside the token the holder is the canonical string <host>:<boot>:<mount> (hostwire.Holder.String()).
    let parsed: Fence | undefined;
    if (fence !== undefined) {
      const m = record(fence) && typeof fence.holder === "string" ? /^([^:]+):(\d+):(.+)$/.exec(fence.holder) : null;
      if (!m || !Number.isSafeInteger(fence.epoch)) throw new Error("invalid fence claim");
      parsed = { holder: { host: m[1], boot: Number(m[2]), mount: m[3] }, epoch: fence.epoch as number };
    }
    return { sub, lin, acc, refs: refs as string[], fence: parsed };
  };
}

export function validHolder(value: unknown): value is Holder {
  return record(value) && Object.keys(value).length === 3 &&
    typeof value.host === "string" && !!value.host &&
    typeof value.mount === "string" && !!value.mount && Number.isSafeInteger(value.boot);
}
