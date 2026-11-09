import { NextResponse } from "next/server";
import { setupError } from "@/lib/auth";
import { env } from "@/lib/env";
import { oidc, oidcConfig } from "@/lib/oauth";
import { STATE_COOKIE, sign, cookieOptions } from "@/lib/session";
export async function GET() {
  const error = await setupError();
  if (error) return new Response(error, { status: 503 });
  const e = await env(), state = crypto.randomUUID(), nonce = crypto.randomUUID();
  const verifier = oidc.randomPKCECodeVerifier();
  const callback = new URL("/auth/callback", e.APP_URL).href;
  const url = e.AUTH_PROVIDER === "oidc" ? oidc.buildAuthorizationUrl(await oidcConfig(e), {
    redirect_uri: callback, scope: "openid profile email", state, nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
  }) : new URL("https://github.com/login/oauth/authorize");
  if (e.AUTH_PROVIDER === "github") url.search = new URLSearchParams({ client_id: e.GITHUB_CLIENT_ID!, redirect_uri: callback, scope: "read:org", state }).toString();
  const response = NextResponse.redirect(url);
  response.cookies.set(STATE_COOKIE, await sign({ state, nonce, verifier }, e.SESSION_SECRET!, "oauth", 600), cookieOptions(e.APP_URL!, 600));
  return response;
}
