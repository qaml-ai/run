import { NextResponse, type NextRequest } from "next/server";

/**
 * A stand-in for your sign-in: each browser gets a random, http-only user id, so every visitor has
 * their own agent. Replace it with your auth (Clerk, Auth.js, your session) and read that in
 * app/api/agent/route.ts instead.
 */
export function proxy(request: NextRequest) {
  // Deployed, there are no demo users unless you opt in (DEMO_AUTH=1): see app/api/agent/route.ts.
  if (process.env.NODE_ENV === "production" && process.env.DEMO_AUTH !== "1") return NextResponse.next();
  if (request.cookies.get("demo_user")) return NextResponse.next();
  const response = NextResponse.next();
  response.cookies.set("demo_user", crypto.randomUUID(), { httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
