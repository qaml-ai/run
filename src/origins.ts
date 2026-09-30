/**
 * The origins the runtime answers at. AGENT_PUBLIC_URL is where it sends people: the console, file links, emails,
 * OAuth pages, the URL its tools show. AGENT_PUBLIC_ALIASES are other names it serves in full, such as an earlier
 * domain kept working; on them, browser pages move to the public URL (sign-in cookies live there), and an MCP
 * endpoint's protected-resource metadata names the resource as it was reached (RFC 9728 has clients check that).
 *
 * AGENT_ISSUER names the runtime in the identity tokens it signs and as an OAuth authorization server. It defaults to
 * the public URL, and stays put when the public URL moves: tool servers check it, as MCP clients do their issuer.
 */
export class PublicOrigins {
  /** AGENT_PUBLIC_URL; without it, the address this node listens on, once known. */
  canonical: string;
  readonly aliases: readonly string[];
  private readonly fixedIssuer?: string;

  constructor(canonical: string, aliases: string[] = [], issuer?: string) {
    this.canonical = origin(canonical, "AGENT_PUBLIC_URL");
    this.aliases = aliases.map(alias => origin(alias, "AGENT_PUBLIC_ALIASES")).filter(alias => alias !== this.canonical);
    if (issuer !== undefined) {
      this.fixedIssuer = origin(issuer, "AGENT_ISSUER");
      if (this.fixedIssuer !== this.canonical && !this.aliases.includes(this.fixedIssuer)) throw new Error("AGENT_ISSUER must be AGENT_PUBLIC_URL or one of AGENT_PUBLIC_ALIASES: its keys and metadata are served there");
    }
  }

  get issuer() { return this.fixedIssuer ?? this.canonical; }
  get all() { return [this.canonical, ...this.aliases]; }

  /** The origin a request was sent to, when it is one of these (a forwarded request's original host), else the public URL. */
  of(headers: Headers): string {
    for (const host of [headers.get("x-forwarded-host")?.split(",")[0], headers.get("host")]) {
      const name = host?.trim().toLowerCase();
      const found = name && this.all.find(value => new URL(value).host === name);
      if (found) return found;
    }
    return this.canonical;
  }

  /** Whether a request came in on an alias. */
  alias(headers: Headers) { return this.of(headers) !== this.canonical; }
}

/** An http(s) origin, as written without a trailing slash. */
function origin(value: string, name: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error(`${name} must be an http(s) origin such as https://run.example.com, not ${JSON.stringify(value)}`); }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== trimmed) throw new Error(`${name} must be an http(s) origin such as https://run.example.com, not ${JSON.stringify(value)}`);
  return trimmed;
}

/** The runtime's origins from its environment; `fallback` is where it listens, when AGENT_PUBLIC_URL is unset. */
export function publicOrigins(env: NodeJS.ProcessEnv, fallback: string) {
  const aliases = (env.AGENT_PUBLIC_ALIASES ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!env.AGENT_PUBLIC_URL && (aliases.length || env.AGENT_ISSUER)) throw new Error("AGENT_PUBLIC_ALIASES and AGENT_ISSUER need AGENT_PUBLIC_URL");
  return new PublicOrigins(env.AGENT_PUBLIC_URL || fallback, aliases, env.AGENT_ISSUER || undefined);
}
