import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { COOKIE } from "@/lib/session";
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL((await env()).APP_URL!).origin) return new Response("Forbidden", { status: 403 });
  (await cookies()).delete(COOKIE);
  return new Response(null, { status: 204 });
}
