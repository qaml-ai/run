import { importPKCS8, SignJWT } from "jose";
import type { Env } from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

const vaultKeyCache = new Map<string, Promise<CryptoKey>>();
const ed25519KeyCache = new Map<string, Promise<{ kid: string; key: CryptoKey }>>();

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function randomId(prefix: string, byteLength = 12): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return `${prefix}_${bytesToHex(buf)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string, existingSaltHex?: string): Promise<{ hash: string; salt: string }> {
  const saltBytes = existingSaltHex
    ? hexToBytes(existingSaltHex)
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes as BufferSource, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    256,
  );
  return {
    hash: bytesToHex(new Uint8Array(derived)),
    salt: bytesToHex(saltBytes),
  };
}

export async function verifyPassword(password: string, storedHash: string, storedSaltHex: string): Promise<boolean> {
  const { hash } = await hashPassword(password, storedSaltHex);
  return constantTimeEqual(hash, storedHash);
}

export async function mintTenantApiKey(tenantId: string): Promise<{
  id: string;
  token: string;
  prefix: string;
  keyHash: string;
}> {
  const idBytes = new Uint8Array(6);
  const secBytes = new Uint8Array(18);
  crypto.getRandomValues(idBytes);
  crypto.getRandomValues(secBytes);
  const id = `key_${bytesToHex(idBytes)}`;
  const shortId = bytesToHex(idBytes);
  const secret = toBase64Url(secBytes);
  const token = `cr_live_${tenantId}.${shortId}_${secret}`;
  const prefix = `cr_live_${tenantId}.${shortId}_${secret.slice(0, 4)}...`;
  const keyHash = await sha256Hex(token);
  return { id, token, prefix, keyHash };
}

export function parseTenantApiKeyTenant(token: string): string | null {
  if (!token.startsWith("cr_live_")) return null;
  const rest = token.slice("cr_live_".length);
  const dotIdx = rest.indexOf(".");
  if (dotIdx <= 0) return null;
  return rest.slice(0, dotIdx);
}

export async function mintAgentToken(
  tenantId: string,
  agentId: string,
): Promise<{
  token: string;
  tokenHash: string;
}> {
  const secBytes = new Uint8Array(18);
  crypto.getRandomValues(secBytes);
  const secret = toBase64Url(secBytes);
  const token = `agt_tok_${tenantId}.${agentId}.${secret}`;
  const tokenHash = await sha256Hex(token);
  return { token, tokenHash };
}

export function parseAgentTokenIds(
  token: string,
): { tenantId: string; agentId: string } | null {
  if (!token.startsWith("agt_tok_")) return null;
  const rest = token.slice("agt_tok_".length);
  const firstDot = rest.indexOf(".");
  if (firstDot <= 0) return null;
  const secondDot = rest.indexOf(".", firstDot + 1);
  if (secondDot <= firstDot + 1) return null;
  const tenantId = rest.slice(0, firstDot);
  const agentId = rest.slice(firstDot + 1, secondDot);
  return { tenantId, agentId };
}

export function mintChannelId(tenantId: string): string {
  const rand = new Uint8Array(6);
  crypto.getRandomValues(rand);
  return `ch_${tenantId}.${bytesToHex(rand)}`;
}

export function parseChannelTenantId(channelId: string): string | null {
  if (!channelId.startsWith("ch_")) return null;
  const rest = channelId.slice("ch_".length);
  const dotIdx = rest.indexOf(".");
  if (dotIdx <= 0) return null;
  return rest.slice(0, dotIdx);
}

async function deriveVaultKey(vaultSecret: string): Promise<CryptoKey> {
  const effective = vaultSecret || "default-dev-vault-secret";
  let cached = vaultKeyCache.get(effective);
  if (!cached) {
    cached = (async () => {
      const hash = await crypto.subtle.digest("SHA-256", encoder.encode(`camelrun-vault-v2:${effective}`));
      return crypto.subtle.importKey("raw", hash, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
    vaultKeyCache.set(effective, cached);
  }
  return cached;
}

export async function sealSecret(plaintext: string, vaultSecret: string): Promise<string> {
  const key = await deriveVaultKey(vaultSecret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(plaintext),
  );
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function openSecret(sealed: string, vaultSecret: string): Promise<string> {
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") {
    throw new Error("Malformed sealed secret");
  }
  const key = await deriveVaultKey(vaultSecret);
  const iv = fromBase64Url(parts[1]!);
  const cipher = fromBase64Url(parts[2]!);
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    cipher as BufferSource,
  );
  return decoder.decode(plainBuf);
}

export async function signWebhookPayload(
  payloadText: string,
  secret: string,
  timestamp?: number,
): Promise<{ signature: string; timestamp: number }> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signingInput = `${ts}.${payloadText}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return {
    signature: `t=${ts},v1=${bytesToHex(new Uint8Array(mac))}`,
    timestamp: ts,
  };
}

export async function computeRawHmacHex(payloadText: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadText));
  return bytesToHex(new Uint8Array(mac));
}

function decodeKeyMaterial(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed) || /^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  return fromBase64Url(trimmed);
}

async function importCamelfsSigningKey(spec: string): Promise<{ kid: string; key: CryptoKey }> {
  let cached = ed25519KeyCache.get(spec);
  if (!cached) {
    cached = (async () => {
      const trimmed = spec.trim();
      if (trimmed.includes("BEGIN PRIVATE KEY")) {
        const key = (await importPKCS8(trimmed, "EdDSA")) as CryptoKey;
        return { kid: "default", key };
      }
      let kid = "k1";
      let rawPart = trimmed;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx > 0) {
        kid = trimmed.slice(0, colonIdx).trim() || "k1";
        rawPart = trimmed.slice(colonIdx + 1).trim();
      }
      if (rawPart.includes("BEGIN PRIVATE KEY")) {
        const key = (await importPKCS8(rawPart, "EdDSA")) as CryptoKey;
        return { kid, key };
      }
      const bytes = decodeKeyMaterial(rawPart);
      let pkcs8: Uint8Array;
      if (bytes.length === 32 || bytes.length === 64) {
        const seed = bytes.subarray(0, 32);
        pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
        pkcs8.set(ED25519_PKCS8_PREFIX, 0);
        pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
      } else if (bytes.length === 48 && bytes[0] === 0x30) {
        pkcs8 = bytes;
      } else {
        throw new Error(`Unsupported Ed25519 signing key byte length: ${bytes.length}`);
      }
      const key = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8 as BufferSource,
        { name: "Ed25519" },
        false,
        ["sign"],
      );
      return { kid, key };
    })();
    ed25519KeyCache.set(spec, cached);
  }
  return cached;
}

export async function mintCamelfsToken(
  env: Pick<Env, "CAMELFS_SIGNING_KEY" | "CAMELFS_DEV_TOKEN">,
  tenantId: string,
  lineage = "*",
  scopes: string[] = ["repo:read", "repo:write", "vm:exec"],
  ttlSeconds = 300,
): Promise<string> {
  const signingSpec = env.CAMELFS_SIGNING_KEY?.trim();
  if (signingSpec) {
    const { kid, key } = await importCamelfsSigningKey(signingSpec);
    const nowSec = Math.floor(Date.now() / 1000);
    return new SignJWT({
      lin: lineage,
      scopes,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "camelfs+jwt", kid })
      .setIssuer("camelrun")
      .setSubject(tenantId)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + ttlSeconds)
      .sign(key);
  }
  if (env.CAMELFS_DEV_TOKEN) {
    return env.CAMELFS_DEV_TOKEN;
  }
  throw new Error("Neither CAMELFS_SIGNING_KEY nor CAMELFS_DEV_TOKEN is configured");
}
