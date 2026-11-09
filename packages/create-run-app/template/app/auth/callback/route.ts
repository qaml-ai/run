import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { setupError } from "@/lib/auth";
import { env } from "@/lib/env";
import { githubIdentity, oidcIdentity, oidc, oidcConfig } from "@/lib/oauth";
import { COOKIE, STATE_COOKIE, verify, sign, cookieOptions, type User } from "@/lib/session";
export async function GET(request: Request) {
  const e = await env(), jar = await cookies();
  const token = jar.get(STATE_COOKIE)?.value;
  jar.delete(STATE_COOKIE); jar.delete(COOKIE);
  const error = await setupError();
  if (error) return new Response(error, { status: 503 });
  try {
    const flow = await verify(token, e.SESSION_SECRET, "oauth"), incoming = new URL(request.url);
    if (!flow || typeof flow.state !== "string" || flow.state !== incoming.searchParams.get("state") || !incoming.searchParams.get("code")) throw new Error("Invalid OAuth response");
    let user: User | null;
    if (e.AUTH_PROVIDER === "oidc") {
      const callback = new URL("/auth/callback", e.APP_URL); callback.search = incoming.search;
      const tokens = await oidc.authorizationCodeGrant(await oidcConfig(e), callback, {
        expectedState: flow.state, expectedNonce: String(flow.nonce), pkceCodeVerifier: String(flow.verifier), idTokenExpected: true,
      });
      const claims = tokens.claims();
      user = oidcIdentity(claims, e);
    } else {
      const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", redirect: "manual", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: e.GITHUB_CLIENT_ID, client_secret: e.GITHUB_CLIENT_SECRET, code: incoming.searchParams.get("code"), redirect_uri: new URL("/auth/callback", e.APP_URL).href }) });
      const data = await response.json();
      if (!response.ok || typeof data.access_token !== "string") throw new Error("OAuth exchange failed");
      user = await githubIdentity(data.access_token, e.GITHUB_ORG!);
    }
    if (!user) throw new Error("Access denied");
    const response = NextResponse.redirect(new URL("/", e.APP_URL));
    response.cookies.set(COOKIE, await sign(user, e.SESSION_SECRET!, "session", 28800), cookieOptions(e.APP_URL!, 28800));
    return response;
  } catch { return NextResponse.redirect(new URL("/?auth=denied", e.APP_URL)); }
}
