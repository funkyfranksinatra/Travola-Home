// proxy.ts — page-level boundary (Next 16's middleware).
//
// Every screen except the login page needs a signed restaurant session.
// Without this, a cookie-less browser lands on a shell that spins while
// its API calls 401 behind it. Each API route still validates the session
// for its own reads and writes — this is a redirect, not the security
// boundary.
import { NextResponse, type NextRequest } from "next/server";
import { getRestaurantId } from "@/lib/session";

export function proxy(request: NextRequest) {
  if (getRestaurantId(request)) return NextResponse.next();
  return NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/", "/analysis", "/predictions", "/staff", "/billing", "/data"],
};
