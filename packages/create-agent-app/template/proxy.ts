import { NextResponse, type NextRequest } from "next/server";

/**
 * A stand-in for your sign-in: each browser gets a random, http-only user id, so every visitor has
 * their own agent. Replace it with your auth (Clerk, Auth.js, your session) and read that in
 * app/api/agent/route.ts instead.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.get("demo_user")) return NextResponse.next();
  const response = NextResponse.next();
  response.cookies.set("demo_user", crypto.randomUUID(), { httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
