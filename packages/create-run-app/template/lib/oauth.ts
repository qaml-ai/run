import * as oidc from "openid-client";
import type { User } from "./session.ts";
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
