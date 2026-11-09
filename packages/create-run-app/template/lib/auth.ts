import { cookies } from "next/headers";
import { env } from "./env";
import { COOKIE, verify, type User } from "./session";
export async function configured() {
  const e = await env();
  return !!(e.APP_URL && e.SESSION_SECRET && e.SESSION_SECRET.length >= 32 &&
    (e.AUTH_PROVIDER === "github" ? e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET && e.GITHUB_ORG :
      e.AUTH_PROVIDER === "oidc" && e.OIDC_ISSUER && e.OIDC_CLIENT_ID && e.OIDC_CLIENT_SECRET));
}
/** Replace this hook with your own session provider. Never trust browser-supplied user ids. */
export async function authorize(_request?: Request): Promise<User | null> {
  if (!await configured()) return null;
  const claims = await verify((await cookies()).get(COOKIE)?.value, (await env()).SESSION_SECRET, "session");
  return claims && typeof claims.userId === "string" && typeof claims.name === "string" ? { userId: claims.userId, name: claims.name } : null;
}
