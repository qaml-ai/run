import { SignJWT, jwtVerify } from "jose";
export const COOKIE = "run_session";
export const STATE_COOKIE = "run_oauth";
export type User = { userId: string; name: string };
const key = (secret: string) => new TextEncoder().encode(secret);
export async function sign(value: Record<string, unknown>, secret: string, purpose: string, seconds: number) {
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return new SignJWT(value).setProtectedHeader({ alg: "HS256" }).setIssuer("run-app").setAudience(purpose).setIssuedAt().setExpirationTime(`${seconds}s`).sign(key(secret));
}
export async function verify(token: string | undefined, secret: string | undefined, purpose: string) {
  if (!token || !secret || secret.length < 32) return null;
  try { return (await jwtVerify(token, key(secret), { algorithms: ["HS256"], issuer: "run-app", audience: purpose })).payload; }
  catch { return null; }
}
export function cookieOptions(origin: string, maxAge: number) {
  return { httpOnly: true, secure: new URL(origin).protocol === "https:", sameSite: "lax" as const, path: "/", maxAge };
}
