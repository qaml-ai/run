import { vaultAuth, vaultRequest, maskResponse, type Vault, type VaultAuth, type Networking, networkAllows } from "../../../../src/core/vault.ts";
// A native computer starts with enableInternet: true: every host is reachable
// directly. Its definition may grant HTTPS egress to named hosts: the
// Container's traffic to each host is intercepted
// (Container.interceptOutboundHttps) and handed to ComputerEgress, which makes
// the request itself. A grant with `auth` gets its credential from the
// definition's exchange endpoint, as an MCP server's does, or (`github-app`) an
// installation token the runtime mints from one of the tenant's GitHub Apps, and
// the gateway adds it outside the Container: the machine and the model never see it.
import { HttpError } from "../errors.ts";
import { ownAudience } from "../source-input-policy.ts";
import type { ExchangeAuth } from "../exchange-auth.ts";
import { GITHUB_HOSTS, githubAppAuthInput, type GitHubAppAuth } from "../../../../src/core/github-apps.ts";
import type { RuntimeIdentity } from "../tool-identity.ts";
import { INSTANCE_TYPES, type InstanceType } from "./provider.ts";

export type EgressAuth = ExchangeAuth | GitHubAppAuth | VaultAuth;
export type EgressGrant = { host: string; auth?: EgressAuth; scheme?: "bearer" | "basic" };
/** A definition's `computer`: what its agents' native computers may reach, how long they stay up idle, and their size. */
export type ComputerSettings = {
  egress?: EgressGrant[]; idleSeconds?: number; instance?: InstanceType;
  /** What idling out does: "stop" (default) discards the disk; "sleep" saves it first, so the next start or fork resumes it. */
  idle?: "stop" | "sleep";
  secrets?: VaultAuth[];
  networking?: Networking;
  mcpHosts?: string[];
};
export type EgressIdentity = { issuer: string; claims: RuntimeIdentity };
/** What the agent hands its computer object with each operation. */
export type ComputerSetup = { settings: ComputerSettings; identity: EgressIdentity };
/** A computer that restores another agent's backup, named by the runtime from the signed parent link. */
export type BackupSource = { computer: string; prefix: string };

export const COMPUTER_LIMITS = {
  grants: 32,
  idleSeconds: { min: 10, max: 3600, default: 60 },
  execMs: 600_000,
};
/** Where the Container runtime puts the CA that signs intercepted HTTPS. */
export const CONTAINER_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
/** Trusts that CA for every TLS client in the image: OpenSSL (git, curl, python) through the system bundle, Node through NODE_EXTRA_CA_CERTS. */
export const TRUST_COMMAND = `cp ${CONTAINER_CA} /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates >/dev/null`;
/** The system bundle, which holds the interception CA once TRUST_COMMAND ran. */
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
/**
 * The environment of every process on a machine with grants. Clients with their own CA store need to be pointed at
 * the interception CA: Node (npm, fetch) through NODE_EXTRA_CA_CERTS, and Python's requests and pip, which bundle
 * certifi, through REQUESTS_CA_BUNDLE and PIP_CERT. Without these, `npm install` behind the gateway failed with
 * SELF_SIGNED_CERT_IN_CHAIN. git never prompts for a credential the gateway supplies. Set both at start() and on each
 * exec: exec does not inherit start()'s env.
 */
export const EGRESS_ENV: Record<string, string> = {
  NODE_EXTRA_CA_CERTS: CONTAINER_CA,
  GIT_TERMINAL_PROMPT: "0",
  SSL_CERT_FILE: SYSTEM_BUNDLE,
  REQUESTS_CA_BUNDLE: SYSTEM_BUNDLE,
  PIP_CERT: SYSTEM_BUNDLE,
};
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const RESERVED = /(^|\.)(localhost|local|internal|localdomain|home|lan|test|invalid|example)$/;
const bad = (message: string) => new HttpError(400, message);

type UrlCheck = (value: unknown) => URL;
/**
 * Checks a definition's `computer`. `checkUrl` applies the runtime's outbound policy to an exchange URL, as it does
 * for an MCP server's. Hosts are DNS names (no IP literal, port, wildcard or private-use name).
 */
export function computerSettingsInput(value: unknown, checkUrl: UrlCheck, tenant: string): ComputerSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad("computer must be an object");
  const extra = Object.keys(value).find(key => !["egress", "idleSeconds", "instance", "idle", "secrets"].includes(key));
  if (extra) throw bad(`computer: Unrecognized key: "${extra}"`);
  const input = value as { secrets?: unknown; egress?: unknown; idleSeconds?: unknown; instance?: unknown; idle?: unknown }, settings: ComputerSettings = {};
  if (input.secrets !== undefined) {
    if (!Array.isArray(input.secrets) || input.secrets.length > 64) throw bad("computer.secrets must contain at most 64 vault references");
    settings.secrets = input.secrets.map(vaultAuth);
    if (new Set(settings.secrets.map(s => s.name)).size !== settings.secrets.length) throw bad("Secret names must be unique");
  }
  if (input.idle !== undefined) {
    if (input.idle !== "stop" && input.idle !== "sleep") throw bad('computer.idle must be "stop" or "sleep"');
    settings.idle = input.idle;
  }
  if (input.instance !== undefined) {
    // The deployment's COMPUTER_INSTANCE is the default; a definition picks another size for its agents.
    if (!INSTANCE_TYPES.includes(input.instance as InstanceType)) throw bad(`computer.instance must be one of ${INSTANCE_TYPES.join(", ")}`);
    settings.instance = input.instance as InstanceType;
  }
  if (input.idleSeconds !== undefined) {
    const { min, max } = COMPUTER_LIMITS.idleSeconds;
    if (!Number.isInteger(input.idleSeconds) || (input.idleSeconds as number) < min || (input.idleSeconds as number) > max)
      throw bad(`computer.idleSeconds must be an integer from ${min} to ${max}`);
    settings.idleSeconds = input.idleSeconds as number;
  }
  if (input.egress !== undefined) {
    if (!Array.isArray(input.egress) || input.egress.length > COMPUTER_LIMITS.grants)
      throw bad(`computer.egress must be a list of at most ${COMPUTER_LIMITS.grants} hosts`);
    const seen = new Set<string>();
    settings.egress = input.egress.map((entry, index) => {
      const where = `computer.egress[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw bad(`${where} must be {host, auth?, scheme?}`);
      const unknown = Object.keys(entry).find(key => !["host", "auth", "scheme"].includes(key));
      if (unknown) throw bad(`${where}: Unrecognized key: "${unknown}"`);
      const { host, auth, scheme } = entry as Record<string, unknown>;
      if (typeof host !== "string" || !HOST.test(host) || RESERVED.test(host))
        throw bad(`${where}.host must be a public DNS name in lowercase, without scheme, port or wildcard`);
      if (seen.has(host)) throw bad(`${where}.host ${host} is listed twice`);
      seen.add(host);
      const grant: EgressGrant = { host };
      if (scheme !== undefined) {
        if (scheme !== "bearer" && scheme !== "basic") throw bad(`${where}.scheme must be bearer or basic`);
        if (auth === undefined) throw bad(`${where}.scheme needs auth`);
      }
      if (auth !== undefined && (auth as { type?: unknown } | null)?.type === "github-app") {
        // An installation token goes only to GitHub's own hosts: git over HTTPS takes it as Basic x-access-token, the API as a bearer token.
        if (!(GITHUB_HOSTS as readonly string[]).includes(host)) throw bad(`${where}.auth github-app is for GitHub's hosts: ${GITHUB_HOSTS.join(", ")}`);
        try { grant.auth = githubAppAuthInput(auth, `${where}.auth`); } catch (error) { throw bad((error as Error).message); }
        grant.scheme = (scheme as EgressGrant["scheme"]) ?? (host === "github.com" ? "basic" : "bearer");
      } else if (auth !== undefined && (auth as {type?: unknown}).type === "vault") {
        grant.auth = vaultAuth(auth); grant.scheme = (scheme as EgressGrant["scheme"]) ?? "bearer";
      } else if (auth !== undefined) {
        if (!auth || typeof auth !== "object" || Array.isArray(auth) || (auth as { type?: unknown }).type !== "exchange")
          throw bad(`${where}.auth is { type: "exchange", url, audience? } or { type: "github-app", app, repositories?, permissions? }`);
        const extraAuth = Object.keys(auth).find(key => !["type", "url", "audience"].includes(key));
        if (extraAuth) throw bad(`${where}.auth: Unrecognized key: "${extraAuth}"`);
        const { url, audience } = auth as { url?: unknown; audience?: unknown };
        if (typeof url !== "string" || !url) throw bad(`${where}.auth is { type: "exchange", url, audience? }`);
        let exchange: URL;
        try { exchange = checkUrl(url); } catch (error) { throw bad(`${where}.auth.url: ${(error as Error).message}`); }
        if (audience !== undefined && (typeof audience !== "string" || !ownAudience(audience, exchange, tenant)))
          throw bad(`${where}.auth.audience must be a URL on the exchange's own origin or a name of your tenant's own`);
        grant.auth = { type: "exchange", url: exchange.href, ...(audience ? { audience: audience as string } : {}) };
        grant.scheme = (scheme as EgressGrant["scheme"]) ?? "bearer";
      }
      return grant;
    });
  }
  return settings;
}

/** The exchange request names the grant as its server, so the endpoint can tell computer egress from an MCP server. */
export const grantSource = (grant: EgressGrant & { auth: ExchangeAuth }) => ({ name: `computer:${grant.host}`, url: `https://${grant.host}`, auth: grant.auth });

/** How an Authorization header carries an exchanged token: `basic` is what Git over HTTPS sends to GitHub (x-access-token). */
export function authorization(grant: EgressGrant, token: string) {
  return grant.scheme === "basic" ? `Basic ${btoa(`x-access-token:${token}`)}` : `Bearer ${token}`;
}

/** The computer's description of its network, for the tool the model reads. */
export function egressDescription(settings?: ComputerSettings) {
  const authed = settings?.egress?.filter(grant => grant.auth).map(grant => grant.host) ?? [];
  return (settings?.networking?.type === "limited" ? "Network access is limited to allowed hosts." : "Internet access.") +
    (settings?.secrets?.length ? ` Vault placeholders are in environment variables: ${settings.secrets.map(s => s.name).join(", ")}.` : "") +
    (authed.length ? ` Requests to ${authed.join(", ")} are authenticated by the runtime: use plain https:// URLs and never put credentials in commands, files or remotes.` : "");
}

const HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"];
export type EgressDeps = {
  /** The credential for an authenticated grant, from the exchange cache. */
  networking?: Networking;
  mcpHosts?: string[];
  vault?: { service: Vault; tenant: string; refs: VaultAuth[] };
  credential(grant: EgressGrant & { auth: EgressAuth }): Promise<{ token: string; refused(): void }>;
  /** Sends the upstream request (the Worker's fetch, after the runtime's outbound checks). */
  send(request: Request): Promise<Response>;
  /** A loopback origin standing in for every granted host, only in TEST_MODE. */
  testUpstream?: URL;
};

/**
 * Forwards one intercepted request to its granted host. The Container's own Authorization header is dropped for an
 * authenticated grant, so whatever the machine sends, the upstream sees only the runtime's credential. A credential
 * the upstream refuses (401/403) is dropped from the cache; a request without a body is sent once more with a new one.
 */
export async function forwardEgress(request: Request, grant: EgressGrant, deps: EgressDeps): Promise<Response> {
  let secretValues: string[] = [];
  if (deps.vault) {
    try { const filled = await vaultRequest(request, deps.vault.refs, deps.vault.service, deps.vault.tenant); request = filled.request; secretValues = filled.values; }
    catch { return Response.json({ error: "Vault request refused" }, { status: 403 }); }
  }
  const incoming = new URL(request.url);
  if (deps.networking && !networkAllows(deps.networking, incoming, deps.mcpHosts)) return Response.json({ error: "Network destination is not allowed" }, { status: 403 });
  if (grant.host !== "*" && incoming.hostname !== grant.host) return Response.json({ error: `Egress is granted to ${grant.host}, not ${incoming.hostname}` }, { status: 403 });
  const target = new URL(incoming.href); target.protocol = "https:"; target.port = ""; target.username = ""; target.password = "";
  if (deps.testUpstream) { target.protocol = deps.testUpstream.protocol; target.host = deps.testUpstream.host; }
  const headers = new Headers(request.headers);
  for (const name of HOP) headers.delete(name);
  if (deps.testUpstream) headers.set("x-camelrun-egress-host", grant.host);
  const body = request.body && !["GET", "HEAD"].includes(request.method) ? request.body : undefined;
  const send = async () => {
    let credential: { token: string; refused(): void } | undefined;
    if (grant.auth) {
      headers.delete("authorization");
      try { credential = await deps.credential(grant as EgressGrant & { auth: EgressAuth }); }
      catch (error) { return { response: Response.json({ error: `camelRun egress credential for ${grant.host}: ${(error as Error).message}` }, { status: 502 }) }; }
      secretValues.push(credential.token);
      headers.set("authorization", authorization(grant, credential.token));
    }
    const response = await deps.send(new Request(target, { method: request.method, headers, body, redirect: "manual", ...(body ? { duplex: "half" } : {}) } as RequestInit));
    return { response, credential };
  };
  let first;
  try { first = await send(); } catch { return Response.json({ error: "Egress request failed" }, { status: 502 }); }
  let { response, credential } = first;
  // GitHub answers 403 for what a scoped token may not do, which a new token would not change: only its 401 is a refusal.
  const refusal = grant.auth?.type === "github-app" ? [401] : [401, 403];
  if (credential && refusal.includes(response.status)) {
    credential.refused();
    if (!body) { await response.body?.cancel(); try { ({ response } = await send()); } catch { return Response.json({ error: "Egress request failed" }, { status: 502 }); } }
  }
  return secretValues.length ? maskResponse(response, secretValues) : response;
}
