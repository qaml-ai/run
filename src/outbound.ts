import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from "undici";

/**
 * The one way the runtime calls URLs that tenants give it (MCP servers, HTTP tools,
 * web_fetch): only to the public internet. Every connection resolves its host
 * itself and connects to the address it checked, so a name that resolves to an
 * internal address, now or on a later lookup (DNS rebinding), never gets a
 * connection. Literal addresses are checked before connecting, redirects are
 * followed only as far as allowed and each hop is checked the same way, and
 * credentials never follow a redirect to another origin. Responses have a
 * deadline and a byte cap.
 */
export class OutboundBlocked extends Error {
  constructor(message: string) { super(message); this.name = "OutboundBlocked"; }
}

type Cidr = { bytes: Uint8Array; prefix: number };
export type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;
export interface OutboundPolicy {
  /** http:// URLs as well as https:// (tests and development only). */
  allowHttp?: boolean;
  /** Ranges reachable despite the built-in blocks, e.g. 127.0.0.1/32 for a test server. */
  allow?: string[];
  /** Ranges blocked on top of the built-in ones, e.g. the VPC's CIDR. Never overridden by `allow`. */
  block?: string[];
  /** Resolves host names; the system resolver by default (tests substitute one). */
  resolve?: Resolve;
}

// Loopback, unspecified, private (RFC 1918), shared address space (CGNAT), link-local (the
// instance and ECS credential endpoints at 169.254.169.254 and 169.254.170.2), IETF protocol
// assignments, documentation, benchmarking, 6to4 relay, multicast and reserved ranges.
const BLOCKED_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"];
// Unspecified, loopback and IPv4-compatible (::/96), local-use NAT64, discard, Teredo, documentation,
// unique local (fc00::/7, including the instance endpoint fd00:ec2::254), link-local, site-local, multicast.
const BLOCKED_V6 = ["::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"];

/** An address as bytes: 4 for IPv4, 16 for IPv6; undefined when it is neither. */
export function addressBytes(address: string): Uint8Array | undefined {
  const version = isIP(address);
  if (version === 4) return Uint8Array.from(address.split(".").map(Number));
  if (version !== 6) return undefined;
  let text = address.toLowerCase().split("%")[0];
  let tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = dotted[2].split(".").map(Number);
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = text.split("::");
  const groups = (part: string | undefined) => part ? part.split(":").map(group => parseInt(group, 16)) : [];
  const left = groups(halves[0]), right = groups(halves[1]);
  const zeros = halves.length > 1 ? 8 - tail.length - left.length - right.length : 0;
  const all = [...left, ...Array(Math.max(0, zeros)).fill(0), ...right, ...tail];
  if (all.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  all.forEach((group, index) => { bytes[index * 2] = group >> 8; bytes[index * 2 + 1] = group & 0xff; });
  return bytes;
}

function cidr(text: string): Cidr {
  const [address, bits] = text.trim().split("/");
  const bytes = addressBytes(address);
  const prefix = bits === undefined ? (bytes?.length ?? 0) * 8 : Number(bits);
  if (!bytes || !Number.isInteger(prefix) || prefix < 0 || prefix > bytes.length * 8) throw new Error(`Invalid CIDR ${text}`);
  return { bytes, prefix };
}

function within(bytes: Uint8Array, range: Cidr) {
  if (bytes.length !== range.bytes.length) return false;
  for (let bit = 0; bit < range.prefix; bit += 8) {
    const mask = range.prefix - bit >= 8 ? 0xff : (0xff << (8 - (range.prefix - bit))) & 0xff;
    if ((bytes[bit / 8] & mask) !== (range.bytes[bit / 8] & mask)) return false;
  }
  return true;
}

const BUILT_IN = [...BLOCKED_V4, ...BLOCKED_V6].map(cidr);
const MAPPED = cidr("::ffff:0:0/96"), NAT64 = cidr("64:ff9b::/96"), SIX_TO_FOUR = cidr("2002::/16");

/** The IPv4 address an IPv6 address carries (mapped, NAT64 or 6to4), which is what it reaches. */
function embedded(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length !== 16) return undefined;
  if (within(bytes, MAPPED) || within(bytes, NAT64)) return bytes.slice(12);
  if (within(bytes, SIX_TO_FOUR)) return bytes.slice(2, 6);
  return undefined;
}

export class Outbound {
  readonly allowHttp: boolean;
  private readonly allow: Cidr[];
  private readonly block: Cidr[];
  private readonly resolve: Resolve;
  readonly dispatcher: Agent;

  constructor(policy: OutboundPolicy = {}) {
    this.allowHttp = !!policy.allowHttp;
    this.allow = (policy.allow ?? []).map(cidr);
    this.block = (policy.block ?? []).map(cidr);
    this.resolve = policy.resolve ?? (hostname => dnsLookup(hostname, { all: true, verbatim: true }));
    const lookup: LookupFunction = (hostname, options, callback) => {
      this.addresses(hostname).then(addresses => {
        const usable = options.family ? addresses.filter(entry => entry.family === options.family) : addresses;
        if (!usable.length) throw Object.assign(new Error(`${hostname} has no ${options.family ? `IPv${options.family} ` : ""}address`), { code: "ENOTFOUND" });
        if (options.all) (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, usable);
        else callback(null, usable[0].address, usable[0].family);
      }, error => callback(error, "", 0));
    };
    // The connection itself resolves, checks and connects in one step: nothing can change in between.
    this.dispatcher = new Agent({ connect: { lookup, timeout: 10_000 }, keepAliveTimeout: 30_000, connections: 64 });
  }

  /** Why the runtime may not connect to `address`, or undefined when it may. */
  blocked(address: string): string | undefined {
    const bytes = addressBytes(address);
    if (!bytes) return "not an IP address";
    if (this.block.some(range => within(bytes, range))) return "a blocked network";
    if (this.allow.some(range => within(bytes, range))) return undefined;
    if (BUILT_IN.some(range => within(bytes, range))) return "a private, local or reserved address";
    const inner = embedded(bytes);
    return inner ? this.blocked(inner.join(".")) : undefined;
  }

  /** Every address a host resolves to, all of them allowed; one internal address blocks the host. */
  async addresses(hostname: string) {
    const addresses = await this.resolve(hostname);
    for (const { address } of addresses) {
      const reason = this.blocked(address);
      if (reason) throw new OutboundBlocked(`${hostname} resolves to ${address}, ${reason}`);
    }
    return addresses;
  }

  /** A URL the runtime may call: http(s) only, no credentials in it, and not a literal internal address. */
  check(value: string | URL): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new OutboundBlocked(`Invalid URL: ${String(value).slice(0, 200)}`); }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && this.allowHttp)) throw new OutboundBlocked(`Only https:// URLs are allowed, not ${url.protocol}//`);
    if (url.username || url.password) throw new OutboundBlocked("URLs may not carry credentials");
    // The URL parser has already normalized other spellings (decimal, octal, hex, short forms) to dotted or bracketed addresses.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(host)) {
      const reason = this.blocked(host);
      if (reason) throw new OutboundBlocked(`${host} is ${reason}`);
    }
    return url;
  }

  /**
   * Fetch a checked URL. `credentials` are headers sent only to the origin of `url`;
   * redirects are followed up to `maxRedirects` (none by default), each hop checked.
   * `timeoutMs` bounds the whole exchange, or with `stream` only until the response
   * starts (an event stream); `maxBytes` caps the body.
   */
  async fetch(input: string | URL, init: RequestInit & { secrets?: Record<string, string>; timeoutMs?: number; maxBytes?: number; maxRedirects?: number; stream?: boolean } = {}): Promise<Response> {
    const { secrets, timeoutMs = 30_000, maxBytes = 4 * 1024 * 1024, maxRedirects = 0, stream, signal, ...request } = init;
    const origin = this.check(input).origin;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new OutboundBlocked(`No response within ${timeoutMs} ms`)), timeoutMs);
    const aborted = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let url = this.check(input);
    let method = (request.method ?? "GET").toUpperCase();
    let body = request.body;
    try {
      for (let hops = 0; ; hops++) {
        const headers = new Headers(request.headers);
        if (url.origin === origin) for (const [name, value] of Object.entries(secrets ?? {})) headers.set(name, value);
        let response: UndiciResponse;
        try {
          response = await undiciFetch(url, { ...request, method, headers, body, redirect: "manual", signal: aborted, dispatcher: this.dispatcher } as unknown as UndiciRequestInit);
        } catch (error) {
          throw (error as { cause?: unknown }).cause instanceof OutboundBlocked ? (error as { cause: Error }).cause : aborted.aborted && aborted.reason instanceof Error ? aborted.reason : error;
        }
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel();
          if (hops >= maxRedirects) throw new OutboundBlocked(maxRedirects ? `More than ${maxRedirects} redirects` : `Redirects are not followed (to ${location.slice(0, 200)})`);
          url = this.check(new URL(location, url));
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
          continue;
        }
        if (stream) clearTimeout(timer);
        return capped(response as unknown as Response, url, maxBytes, () => clearTimeout(timer));
      }
    } catch (error) { clearTimeout(timer); throw error; }
  }
}

/** The response, from `url` (after redirects), with its body cut off, as an error, past `maxBytes`. */
function capped(response: Response, url: URL, maxBytes: number, done: () => void): Response {
  if (!response.body) { done(); return response; }
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) { done(); controller.error(new OutboundBlocked(`Response larger than ${maxBytes} bytes`)); return; }
      controller.enqueue(chunk);
    },
    flush() { done(); },
  }));
  return Object.defineProperty(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), "url", { value: url.toString() });
}

/** The policy operators set: AGENT_OUTBOUND_ALLOW_HTTP, AGENT_OUTBOUND_ALLOW_CIDRS and AGENT_OUTBOUND_BLOCK_CIDRS. */
export function outboundFromEnvironment(env = process.env): Outbound {
  const list = (value?: string) => (value ?? "").split(",").map(entry => entry.trim()).filter(Boolean);
  return new Outbound({ allowHttp: env.AGENT_OUTBOUND_ALLOW_HTTP === "true", allow: list(env.AGENT_OUTBOUND_ALLOW_CIDRS), block: list(env.AGENT_OUTBOUND_BLOCK_CIDRS) });
}
