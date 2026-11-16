import { vaultAuth, type VaultAuth } from "../../../../src/core/vault.ts";
import { HttpError } from "../errors.ts";
import { ownAudience } from "../source-input-policy.ts";
import type { ExchangeAuth } from "../exchange-auth.ts";
import { GITHUB_HOSTS, githubAppAuthInput, type GitHubAppAuth } from "../../../../src/core/github-apps.ts";
import { INSTANCE_TYPES, type InstanceType } from "./meter.ts";

export type EgressAuth = ExchangeAuth | GitHubAppAuth | VaultAuth;
export type EgressGrant = { host: string; auth?: EgressAuth; scheme?: "bearer" | "basic" };
/** A definition's machine size and the legacy settings retained for existing definitions. */
export type ComputerSettings = {
  egress?: EgressGrant[]; idleSeconds?: number; instance?: InstanceType;
  idle?: "stop" | "sleep";
  secrets?: VaultAuth[];
};
const COMPUTER_LIMITS = { grants: 32, idleSeconds: { min: 10, max: 3600 } };
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
