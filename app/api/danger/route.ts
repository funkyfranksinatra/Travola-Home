// app/api/danger/route.ts — deleting a restaurant's data.
//
// The most dangerous endpoint in the product, so every guard is stacked
// rather than chosen between:
//
//   1. A signed session (you are this restaurant).
//   2. A FRESH admin credential — proved in the last ten minutes, not at
//      sign-in three hours ago. A tablet left unlocked on the pass cannot
//      do this.
//   3. The restaurant's own name, typed exactly. Not "DELETE": typing the
//      name is the step that stops someone deleting the wrong restaurant.
//   4. An explicit scope. "Clear history" and "clear everything" are
//      different acts and are never inferred from each other.
//
// What is deliberately NOT deleted, in either scope: the Restaurant row
// and the audit log. The account survives so the owner can still sign in
// and SEE that the deletion happened, who did it and when. A wipe that
// also erases the evidence of itself is not a feature.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRestaurant } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { allowAttempt, nameKey, verifyAdminPasscode } from "@/lib/restaurant-auth";
import { hasFreshAdmin } from "@/lib/session";
import { billing } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Child-before-parent. Getting this order wrong is a foreign-key error
 *  half way through a destructive operation, which is the worst possible
 *  moment to fail. */
const HISTORY_TABLES = [
  `DELETE FROM "Payment" WHERE "restaurantId" = $1`,
  `DELETE FROM "CheckItem" WHERE "checkId" IN (SELECT id FROM "Check" WHERE "restaurantId" = $1)`,
  `DELETE FROM "Check" WHERE "restaurantId" = $1`,
  `DELETE FROM "TableSession" WHERE "restaurantId" = $1`,
  `DELETE FROM "ServiceEvent" WHERE "restaurantId" = $1`,
  `DELETE FROM "ReservationTable" WHERE "reservationId" IN (SELECT id FROM "Reservation" WHERE "restaurantId" = $1)`,
  `DELETE FROM "Reservation" WHERE "restaurantId" = $1`,
  `DELETE FROM "WaitlistEntry" WHERE "restaurantId" = $1`,
  `DELETE FROM "ShiftServer" WHERE "restaurantId" = $1`,
  `DELETE FROM "Shift" WHERE "restaurantId" = $1`,
  `DELETE FROM "Guest" WHERE "restaurantId" = $1`,
  `DELETE FROM "ShiftForecast" WHERE "restaurantId" = $1`,
  `DELETE FROM "ForecastAccuracy" WHERE "restaurantId" = $1`,
  `DELETE FROM "DailyBriefing" WHERE "restaurantId" = $1`,
  `DELETE FROM "ServiceDayStaff" WHERE "restaurantId" = $1`,
];

const SETUP_TABLES = [
  `DELETE FROM "MenuItem" WHERE "restaurantId" = $1`,
  `DELETE FROM "MenuCategory" WHERE "restaurantId" = $1`,
  `DELETE FROM "Server" WHERE "restaurantId" = $1`,
  `DELETE FROM "Table" WHERE "restaurantId" = $1`,
  `DELETE FROM "Floor" WHERE "restaurantId" = $1`,
  `DELETE FROM "RestaurantSettings" WHERE "restaurantId" = $1`,
];

export async function POST(request: Request) {
  let restaurantId: string;
  try {
    restaurantId = requireRestaurant(request);
  } catch (error) {
    return error as Response;
  }
  if (!allowAttempt(request, "console-danger", 4)) {
    return NextResponse.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const scope = String(body?.scope ?? "");
  const confirmName = String(body?.confirmName ?? "");
  const passcode = String(body?.passcode ?? "");

  if (scope !== "history" && scope !== "everything") {
    return NextResponse.json({ error: "Choose what to delete." }, { status: 400 });
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });
  if (!restaurant) return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });

  // The admin credential must be proved in THIS request as well as being
  // fresh in the session. Two independent checks, because the cost of
  // getting this wrong is a customer's entire history.
  const proof = await verifyAdminPasscode(restaurantId, passcode);
  if (!proof.ok) return NextResponse.json({ error: "That code is not right." }, { status: 401 });
  if (!hasFreshAdmin(request)) {
    return NextResponse.json(
      { error: "Unlock admin actions first, then try again." },
      { status: 403 },
    );
  }
  if (nameKey(confirmName) !== nameKey(restaurant.name)) {
    return NextResponse.json(
      { error: `Type the restaurant name exactly — "${restaurant.name}" — to confirm.` },
      { status: 400 },
    );
  }

  // Count first, so the audit entry and the confirmation can say what was
  // actually removed rather than "some rows".
  const before = {
    reservations: await prisma.reservation.count({ where: { restaurantId } }),
    guests: await prisma.guest.count({ where: { restaurantId } }),
    checks: await prisma.check.count({ where: { restaurantId } }),
    waitlist: await prisma.waitlistEntry.count({ where: { restaurantId } }),
  };

  const statements = scope === "everything" ? [...HISTORY_TABLES, ...SETUP_TABLES] : HISTORY_TABLES;

  try {
    await prisma.$transaction(
      statements.map((sql) => prisma.$executeRawUnsafe(sql, restaurantId)),
      { timeout: 50_000 },
    );
  } catch (error) {
    console.error("[danger] delete failed:", error);
    return NextResponse.json(
      { error: "The deletion did not complete and nothing was removed. Try again, or contact support." },
      { status: 500 },
    );
  }

  if (scope === "everything") {
    // Leaving a subscription billing against an emptied account is the
    // kind of detail that turns a clean exit into a chargeback.
    await billing().cancel(restaurantId, { reason: "All restaurant data deleted", immediate: true }).catch(() => undefined);
  }

  await audit({
    restaurantId,
    action: "data.delete",
    req: request,
    summary:
      scope === "everything"
        ? `Deleted ALL restaurant data — ${before.reservations.toLocaleString("en-US")} reservations, ${before.guests.toLocaleString("en-US")} guests, the floor plan, staff and menu — and cancelled the subscription`
        : `Deleted all service history — ${before.reservations.toLocaleString("en-US")} reservations, ${before.guests.toLocaleString("en-US")} guests, ${before.checks.toLocaleString("en-US")} checks`,
    detail: { scope, before },
  });

  return NextResponse.json({ ok: true, scope, removed: before });
}
