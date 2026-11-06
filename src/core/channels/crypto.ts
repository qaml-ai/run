import { sha256Hex } from "../sha256.ts";

/** Bytes and signatures for channels, on WebCrypto: the same on Node and Workers. */

export { sha256Hex };
const encoder = new TextEncoder();
export const utf8 = (text: string) => encoder.encode(text);

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
export const toBase64Url = (bytes: Uint8Array) => toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
export const textBase64Url = (text: string) => toBase64Url(utf8(text));

/** Standard or URL-safe base64, padded or not; whitespace is ignored. Throws on anything else. */
export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(clean.padEnd(clean.length + (4 - clean.length % 4) % 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
export const base64UrlText = (text: string) => new TextDecoder().decode(fromBase64(text));

/** Random bytes as hex: `randomBytes(n).toString("hex")`. */
export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Whether two strings are equal, in time that depends only on their lengths. */
export function sameText(given: string, expected: string): boolean {
  const a = utf8(given), b = utf8(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

const view = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

/** HMAC-SHA256 of `message` under `key` (its bytes, or a string's UTF-8). */
export async function hmacSha256(key: Uint8Array | string, message: Uint8Array | string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", view(typeof key === "string" ? utf8(key) : key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, view(typeof message === "string" ? utf8(message) : message)));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", view(bytes)));
}

// DER, enough to wrap PKCS#1 RSA keys in the PKCS#8 and SPKI envelopes WebCrypto imports.
const derLength = (length: number) => length < 0x80 ? [length] : length < 0x100 ? [0x81, length] : length < 0x10000 ? [0x82, length >> 8, length & 0xff] : [0x83, length >> 16, (length >> 8) & 0xff, length & 0xff];
const der = (tag: number, body: Uint8Array) => new Uint8Array([tag, ...derLength(body.length), ...body]);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
/** AlgorithmIdentifier rsaEncryption with NULL parameters. */
const RSA_ALGORITHM = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
export const pkcs1ToPkcs8 = (pkcs1: Uint8Array) => der(0x30, concat(new Uint8Array([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, pkcs1)));
export const pkcs1ToSpki = (pkcs1: Uint8Array) => der(0x30, concat(RSA_ALGORITHM, der(0x03, concat(new Uint8Array([0]), pkcs1))));

/** A PEM's label and DER body, or undefined when it is not one. */
export function pem(text: string): { label: string; der: Uint8Array } | undefined {
  const match = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match) return undefined;
  try { return { label: match[1]!, der: fromBase64(match[2]!) }; } catch { return undefined; }
}

/** An RSA private key from PEM (PKCS#1 `RSA PRIVATE KEY` or PKCS#8 `PRIVATE KEY`) for RS256, or undefined when it is not one. */
export async function rsaSigningKey(text: string): Promise<CryptoKey | undefined> {
  const found = pem(text);
  if (!found || !["RSA PRIVATE KEY", "PRIVATE KEY"].includes(found.label)) return undefined;
  const pkcs8 = found.label === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(found.der) : found.der;
  try { return await crypto.subtle.importKey("pkcs8", view(pkcs8), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]); }
  catch { return undefined; }
}

export async function rs256(key: CryptoKey, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, view(utf8(data))));
}
