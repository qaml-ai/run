import * as oidc from "openid-client";
import type { User } from "./session.ts";
type Env = Record<string, string | undefined>;
const allowlist = (value: string | undefined) => (value ?? "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
/** A configured issuer authenticates identity; these lists separately grant access to this app. */
export function configurationError(e: Env): string | null {
  if (e.AUTH_PROVIDER === "oidc" && !allowlist(e.OIDC_ALLOWED_DOMAINS).length && !allowlist(e.OIDC_ALLOWED_EMAILS).length)
    return "Set OIDC_ALLOWED_DOMAINS or OIDC_ALLOWED_EMAILS to allow sign-in. Access is closed without an allow-list.";
  if (!e.APP_URL || !e.SESSION_SECRET || e.SESSION_SECRET.length < 32)
    return "Set APP_URL and SESSION_SECRET (at least 32 characters). See README.md.";
  if (e.AUTH_PROVIDER === "github" && e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET && e.GITHUB_ORG) return null;
  if (e.AUTH_PROVIDER === "oidc" && e.OIDC_ISSUER?.startsWith("https://") && e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET) return null;
  return "Set AUTH_PROVIDER and the GitHub organization or OIDC credentials. See README.md.";
}
/** Call only with the ID token claims validated by authorizationCodeGrant. */
export function oidcIdentity(claims: Record<string, unknown> | undefined, e: Env): User | null {
  const domains = allowlist(e.OIDC_ALLOWED_DOMAINS), emails = allowlist(e.OIDC_ALLOWED_EMAILS);
  if ((!domains.length && !emails.length) || !claims || typeof claims.sub !== "string" || !claims.sub ||
      claims.email_verified !== true || typeof claims.email !== "string") return null;
  const email = claims.email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  const domain = email.split("@")[1];
  if (!domains.includes(domain) && !emails.includes(email)) return null;
  // Google hosted-domain admission uses the signed hd claim, never a login hint or email suffix alone.
  if (e.OIDC_ISSUER?.replace(/\/$/, "") === "https://accounts.google.com" &&
      (typeof claims.hd !== "string" || claims.hd.toLowerCase() !== domain)) return null;
  return { userId: `${e.OIDC_ISSUER}:${claims.sub}`, name: typeof claims.name === "string" ? claims.name : email };
}
export async function oidcConfig(e: Record<string, string | undefined>) {
  if (!e.OIDC_ISSUER?.startsWith("https://")) throw new Error("OIDC requires an HTTPS issuer");
  return oidc.discovery(new URL(e.OIDC_ISSUER), e.OIDC_CLIENT_ID!, e.OIDC_CLIENT_SECRET!);
}
export async function githubIdentity(token: string, org: string, fetcher: typeof fetch = fetch): Promise<User | null> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "camelrun-app" };
  const member = await fetcher(`https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`, { headers, redirect: "manual" });
  if (member.status === 404) return null;
  if (!member.ok) throw new Error("Membership lookup failed");
  if ((await member.json()).state !== "active") return null;
  const response = await fetcher("https://api.github.com/user", { headers, redirect: "manual" });
  if (!response.ok) throw new Error("User lookup failed");
  const user = await response.json();
  if (typeof user.login !== "string" || typeof user.id !== "number") return null;
  return { userId: `github:${user.id}`, name: user.login };
}
export { oidc };
