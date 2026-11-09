import { configurationError } from "./oauth";
import { cookies } from "next/headers";
import { env } from "./env";
import { COOKIE, verify, type User } from "./session";
export async function setupError() { return configurationError(await env()); }
export async function configured() { return await setupError() === null; }
/** Replace this hook with your own session provider. Never trust browser-supplied user ids. */
export async function authorize(_request?: Request): Promise<User | null> {
  if (!await configured()) return null;
  const claims = await verify((await cookies()).get(COOKIE)?.value, (await env()).SESSION_SECRET, "session");
  return claims && typeof claims.userId === "string" && typeof claims.name === "string" ? { userId: claims.userId, name: claims.name } : null;
}
