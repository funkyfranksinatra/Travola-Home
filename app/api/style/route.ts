// app/api/style/route.ts — pick one of the three visual treatments.
//
// A cookie, not a database column: the point is to compare the three on a
// real screen with real data before committing. See lib/style.ts.
import { NextResponse } from "next/server";
import { resolveStyle, STYLE_COOKIE, STYLES } from "@/lib/style";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const style = String(body?.style ?? "");
  if (!(STYLES as readonly string[]).includes(style)) {
    return NextResponse.json({ error: "Unknown style." }, { status: 400 });
  }
  const response = NextResponse.json({ ok: true, style: resolveStyle(style) });
  response.cookies.set(STYLE_COOKIE, style, {
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
