import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";
import { addressBytes, BUILT_IN, cidr, within, embedded } from "./security-addresses.ts";
import { OutboundBlocked, guardedFetch } from "./security-fetch-policy.ts";
export { OutboundBlocked };

export type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;
export type OutboundPolicy = { allowHttp?: boolean; allow?: string[]; block?: string[]; origins?: string[]; resolve?: Resolve };

/** Reuses src's address policy; Workers fetch performs another DNS lookup that this preflight cannot pin. */
export class Outbound {
  readonly allowHttp: boolean;
  private readonly allow;
  private readonly block;
  private readonly resolve: Resolve;
  private readonly origins: Set<string>;
  constructor(policy: OutboundPolicy = {}) {
    this.allowHttp = !!policy.allowHttp;
    this.allow = (policy.allow ?? []).map(cidr);
    this.block = (policy.block ?? []).map(cidr);
    this.origins = new Set((policy.origins ?? []).map(value => {
      let url: URL;
      try { url = new URL(value.trim()); } catch { throw new Error(`Invalid origin ${value}`); }
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`An allowed origin is http or https: ${value}`);
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(`An allowed origin is an exact origin, scheme://host:port with no path: ${value}`);
      return url.origin;
    }));
    this.resolve = policy.resolve ?? (async hostname => {
      const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
      const addresses = results.flatMap((result, index) => result.status === "fulfilled" ? result.value.map(address => ({ address, family: index ? 6 : 4 })) : []);
      if (!addresses.length) throw Object.assign(new Error("Host does not resolve"), { code: "ENOTFOUND" });
      return addresses;
    });
  }
  blocked(address: string, origin = false): string | undefined {
    const bytes = addressBytes(address);
    if (!bytes) return "not an IP address";
    if (this.block.some(range => within(bytes, range))) return "a blocked network";
    if (origin || this.allow.some(range => within(bytes, range))) return undefined;
    if (BUILT_IN.some(range => within(bytes, range))) return "a private, local or reserved address";
    const inner = embedded(bytes);
    return inner ? this.blocked(inner.join(".")) : undefined;
  }
  check(value: string | URL): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new OutboundBlocked("Invalid URL"); }
    const origin = this.origins.has(url.origin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (this.allowHttp || origin))) throw new OutboundBlocked(`Only https:// URLs are allowed, not ${url.protocol}//`);
    if (url.username || url.password) throw new OutboundBlocked("URLs may not carry credentials");
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(host)) {
      const reason = this.blocked(host, origin);
      if (reason) throw new OutboundBlocked(`${host} is ${reason}`);
    }
    return url;
  }
  async reachable(value: string | URL): Promise<URL> {
    const url = this.check(value), host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (!isIP(host)) {
      for (const { address } of await this.resolve(host)) {
        const reason = this.blocked(address, this.origins.has(url.origin));
        if (reason) throw new OutboundBlocked(`${host} resolves to ${address}, ${reason}`);
      }
    }
    return url;
  }
  async fetch(value: string | URL, init: Parameters<typeof guardedFetch>[1] = {}) {
    return guardedFetch.call(this, value, init);
  }
}

/** Configured providers may use exact operator origins; model-selected web URLs do not. */
export function modelOutbound(env: Record<string, unknown>): Outbound {
  const list = (key: string) => typeof env[key] === "string" ? (env[key] as string).split(",").map(value => value.trim()).filter(Boolean) : undefined;
  return new Outbound({ allowHttp: env.AGENT_OUTBOUND_ALLOW_HTTP === "true", allow: list("AGENT_OUTBOUND_ALLOW_CIDRS"), block: list("AGENT_OUTBOUND_BLOCK_CIDRS"), origins: list("AGENT_OUTBOUND_ALLOW_ORIGINS") });
}
