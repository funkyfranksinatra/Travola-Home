// app/api/auth/route.ts — sign in, sign out, and prove admin.
//
// The same restaurant name + passcode that opens Travola-OS and Pantry.
// One credential across three products is the whole point: a restaurant
// sets a code once and it works everywhere.
import { NextResponse } from "next/server";
import { allowAttempt, restaurantByCredentials, verifyAdminPasscode } from "@/lib/restaurant-auth";
import { clearSession, getRestaurantId, setSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { configMessage, isConfigurationFailure, operationalError } from "@/lib/env";

export async function POST(request: Request) {
  if (!allowAttempt(request, "console-login")) {
    return NextResponse.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
  }

  // Check configuration before touching the database, so a missing env
  // var is reported as a missing env var rather than as a timeout.
  const misconfigured = configMessage();
  if (misconfigured) {
    return NextResponse.json({ error: misconfigured, configuration: true }, { status: 503 });
  }

  try {
    const body = await request.json().catch(() => null);
    const name = body?.name;
    const passcode = String(body?.passcode ?? "");
    const restaurant = await restaurantByCredentials(name, passcode);
    if (!restaurant) {
      // Deliberately one message for both "no such restaurant" and "wrong
      // code": naming which half was wrong hands an attacker a directory of
      // every restaurant on the platform.
      return NextResponse.json({ error: "That restaurant name and code do not match." }, { status: 401 });
    }
    await audit({ restaurantId: restaurant.id, action: "auth.sign_in", summary: "Signed in to Travola Home", req: request });
    return setSession(
      NextResponse.json({ ok: true, restaurant: { id: restaurant.id, name: restaurant.name } }),
      restaurant.id,
    );
  } catch (error) {
    console.error("[auth] sign-in failed:", error);
    const configuration = isConfigurationFailure(error);
    return NextResponse.json(
      { error: operationalError(error), ...(configuration ? { configuration } : {}) },
      { status: configuration ? 503 : 500 },
    );
  }
}

/** Prove the admin passcode, opening the destructive-action window. */
export async function PATCH(request: Request) {
  const restaurantId = getRestaurantId(request);
  if (!restaurantId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!allowAttempt(request, "console-admin", 6)) {
    return NextResponse.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  const result = await verifyAdminPasscode(restaurantId, String(body?.passcode ?? ""));
  if (!result.ok) return NextResponse.json({ error: "That code is not right." }, { status: 401 });
  await audit({ restaurantId, action: "auth.admin_verified", summary: "Unlocked admin actions", req: request });
  return setSession(
    NextResponse.json({ ok: true, usedRestaurantPasscode: result.usedFallback }),
    restaurantId,
    true,
  );
}

export async function DELETE() {
  return clearSession(NextResponse.json({ ok: true }));
}
