import { fromBase64, pkcs1ToSpki, sha256, toBase64 } from "./crypto.ts";

/**
 * DKIM verification (RFC 6376) on WebCrypto, for hosts that receive raw mail without a
 * provider's verdicts (Cloudflare Email Routing hands an Email Worker the message and its
 * envelope, nothing about SPF or DMARC). A signature counts when its body hash and its
 * RSA-SHA256 or Ed25519-SHA256 signature check out against the key its domain publishes,
 * it signs the From header, and it has not expired. `l=` (a partial body) is refused:
 * anything could follow the signed part.
 */

/** The TXT records at a DNS name, each one string (its character-strings joined). */
export type TxtLookup = (name: string) => Promise<string[]>;

export interface DkimResult {
  /** Domains (`d=`) of the signatures that verified, lowercase. */
  passed: string[];
  /** Why each signature that did not verify failed, in order, for logs. */
  failed: string[];
}

/** At most this many signatures are checked: each costs a DNS lookup. */
const MAX_SIGNATURES = 5;

type Header = { name: string; raw: string };

/** A raw message's header fields in order (each with its folding), and its body, as bytes are text in latin1. */
function split(raw: Uint8Array): { headers: Header[]; body: string } {
  let text = "";
  // latin1: each byte one character, so canonicalization never reinterprets bytes.
  for (let index = 0; index < raw.length; index += 0x8000) text += String.fromCharCode(...raw.subarray(index, index + 0x8000));
  const normalized = text.replace(/\r?\n/g, "\r\n");
  const end = normalized.indexOf("\r\n\r\n");
  const head = end < 0 ? normalized : normalized.slice(0, end + 2);
  const body = end < 0 ? "" : normalized.slice(end + 4);
  const headers: Header[] = [];
  for (const line of head.split(/\r\n(?=[^ \t])/)) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim().toLowerCase(), raw: line.replace(/\r\n$/, "") });
  }
  return { headers, body };
}

const relaxedHeader = (raw: string) => {
  const colon = raw.indexOf(":");
  const name = raw.slice(0, colon).trim().toLowerCase();
  const value = raw.slice(colon + 1).replace(/\r\n/g, "").replace(/[ \t]+/g, " ").trim();
  return `${name}:${value}`;
};

function canonicalBody(body: string, relaxed: boolean): string {
  let text = body;
  if (relaxed) text = text.split("\r\n").map(line => line.replace(/[ \t]+/g, " ").replace(/ $/, "")).join("\r\n");
  text = text.replace(/(\r\n)*$/, "");
  return relaxed ? (text ? `${text}\r\n` : "") : `${text}\r\n`;
}

function tags(value: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const part of value.split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const name = part.slice(0, equals).trim();
    if (name && !found.has(name)) found.set(name, part.slice(equals + 1).replace(/\s+/g, ""));
  }
  return found;
}

const bytes = (text: string) => {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) out[index] = text.charCodeAt(index) & 0xff;
  return out;
};

async function publicKey(lookup: TxtLookup, selector: string, domain: string, algorithm: string): Promise<CryptoKey | string> {
  let records: string[];
  try { records = await lookup(`${selector}._domainkey.${domain}`); } catch { return "dns_failed"; }
  const record = records.map(tags).find(record => (record.get("v") ?? "DKIM1") === "DKIM1" && record.has("p"));
  if (!record) return "no_key";
  const p = record.get("p")!;
  if (!p) return "key_revoked";
  const kind = record.get("k") ?? "rsa";
  let der: Uint8Array;
  try { der = fromBase64(p); } catch { return "bad_key"; }
  const view = (value: Uint8Array) => value as Uint8Array<ArrayBuffer>;
  try {
    if (algorithm === "ed25519-sha256") {
      if (kind !== "ed25519") return "key_mismatch";
      return await crypto.subtle.importKey("raw", view(der), { name: "Ed25519" }, false, ["verify"]);
    }
    if (kind !== "rsa") return "key_mismatch";
    // Keys are SubjectPublicKeyInfo; a few publish a bare PKCS#1 RSAPublicKey.
    return await crypto.subtle.importKey("spki", view(der), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"])
      .catch(() => crypto.subtle.importKey("spki", view(pkcs1ToSpki(der)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  } catch { return "bad_key"; }
}

/** Verify a raw message's DKIM signatures. `now` in milliseconds, for `x=`. */
export async function verifyDkim(raw: Uint8Array, lookup: TxtLookup, now = Date.now()): Promise<DkimResult> {
  const result: DkimResult = { passed: [], failed: [] };
  const { headers, body } = split(raw);
  // A second From above the signed one is what readers see and no signature covers: such a message proves nothing.
  if (headers.filter(header => header.name === "from").length !== 1) return { passed: [], failed: ["from_count"] };
  const signatures = headers.filter(header => header.name === "dkim-signature").slice(0, MAX_SIGNATURES);
  for (const signature of signatures) {
    const value = signature.raw.slice(signature.raw.indexOf(":") + 1);
    const t = tags(value);
    const fail = (reason: string) => { result.failed.push(reason); };
    const algorithm = (t.get("a") ?? "").toLowerCase();
    const domain = (t.get("d") ?? "").toLowerCase(), selector = t.get("s") ?? "";
    const signed = (t.get("h") ?? "").toLowerCase().split(":").map(name => name.trim()).filter(Boolean);
    if (t.get("v") !== "1" || !domain || !selector || !t.get("b") || !t.get("bh")) { fail("malformed"); continue; }
    if (algorithm !== "rsa-sha256" && algorithm !== "ed25519-sha256") { fail("algorithm"); continue; }
    if (!signed.includes("from")) { fail("from_unsigned"); continue; }
    if (t.has("l")) { fail("partial_body"); continue; }
    const expires = Number(t.get("x"));
    if (t.has("x") && (!Number.isFinite(expires) || expires * 1000 < now)) { fail("expired"); continue; }
    if (!/^[a-z0-9.-]+$/.test(domain) || !/^[A-Za-z0-9._-]+$/.test(selector)) { fail("malformed"); continue; }
    const [headerCanon = "simple", bodyCanon = "simple"] = (t.get("c") ?? "simple/simple").toLowerCase().split("/");
    const relaxedHead = headerCanon === "relaxed", relaxedBody = bodyCanon === "relaxed";
    const bodyHash = toBase64(await sha256(bytes(canonicalBody(body, relaxedBody))));
    if (bodyHash !== t.get("bh")) { fail("body_hash"); continue; }
    // Each name in h= takes the next instance of that header from the bottom up; a name with none left signs nothing.
    const remaining = new Map<string, Header[]>();
    for (const header of headers) remaining.set(header.name, [...remaining.get(header.name) ?? [], header]);
    const lines: string[] = [];
    for (const name of signed) {
      const instance = remaining.get(name)?.pop();
      if (instance) lines.push(relaxedHead ? relaxedHeader(instance.raw) : instance.raw);
    }
    const self = signature.raw.replace(/(\bb\s*=)[^;]*/i, (_match, prefix: string) => prefix);
    const own = relaxedHead ? relaxedHeader(self) : self;
    const data = bytes([...lines.map(line => `${line}\r\n`), own].join(""));
    const key = await publicKey(lookup, selector, domain, algorithm);
    if (typeof key === "string") { fail(key); continue; }
    let sig: Uint8Array;
    try { sig = fromBase64(t.get("b")!); } catch { fail("malformed"); continue; }
    const view = (value: Uint8Array) => value as Uint8Array<ArrayBuffer>;
    let ok = false;
    try {
      ok = algorithm === "ed25519-sha256"
        ? await crypto.subtle.verify({ name: "Ed25519" }, key, view(sig), view(await sha256(data)))
        : await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, view(sig), view(data));
    } catch { ok = false; }
    if (ok) { if (!result.passed.includes(domain)) result.passed.push(domain); }
    else fail("signature");
  }
  return result;
}

/** TXT records over DNS-over-HTTPS (the JSON API Cloudflare's and Google's resolvers answer). */
export function dohLookup(fetcher: typeof fetch, endpoint = "https://cloudflare-dns.com/dns-query"): TxtLookup {
  return async name => {
    const url = new URL(endpoint);
    url.searchParams.set("name", name);
    url.searchParams.set("type", "TXT");
    const response = await fetcher(url.href, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`DNS lookup failed: HTTP ${response.status}`);
    const answer = await response.json() as { Status?: number; Answer?: { type: number; data: string }[] };
    if (answer.Status !== 0 && answer.Status !== 3) throw new Error(`DNS lookup failed: status ${answer.Status}`);
    return (answer.Answer ?? []).filter(record => record.type === 16).map(record => [...record.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(part => part[1]!.replace(/\\(.)/g, "$1")).join("") || record.data);
  };
}

