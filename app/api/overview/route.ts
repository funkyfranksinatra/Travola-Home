// app/api/overview/route.ts — the landing screen's single call.
//
// Everything the plan view needs to answer "what is happening and what do
// I owe": who this restaurant is, what it is paying, what tonight looks
// like, and the headline of the next AI forecast.
import { prisma } from "@/lib/prisma";
import { withTenant } from "@/lib/tenant";
import { billing } from "@/lib/billing";
import { hasAdminPasscode } from "@/lib/restaurant-auth";
import { adminWindowRemaining } from "@/lib/session";
import { CONSOLE_SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  return withTenant(request, async (restaurantId) => {
    const today = todayKey();
    const [restaurant, subscription, invoices, staffCount, tableCount, openChecks, forecast, lastService, adminSet] =
      await Promise.all([
        prisma.restaurant.findUnique({
          where: { id: restaurantId },
          select: { name: true, recoveryEmail: true, createdAt: true },
        }),
        billing().getSubscription(restaurantId),
        billing().listInvoices(restaurantId, 3),
        prisma.server.count({ where: { restaurantId, active: true } }),
        prisma.table.count({ where: { restaurantId, active: true } }),
        prisma.check.count({ where: { restaurantId, status: "open" } }),
        prisma.shiftForecast.findFirst({
          where: { restaurantId, date: { gte: today } },
          orderBy: [{ date: "asc" }, { createdAt: "desc" }],
        }),
        prisma.reservation.findFirst({
          where: { restaurantId },
          orderBy: { serviceDate: "desc" },
          select: { serviceDate: true },
        }),
        hasAdminPasscode(restaurantId),
      ]);

    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${CONSOLE_SESSION_COOKIE}=`))
      ?.slice(CONSOLE_SESSION_COOKIE.length + 1);

    const payload = (forecast?.payload ?? null) as Record<string, unknown> | null;
    const covers = (payload?.covers ?? null) as Record<string, unknown> | null;

    return Response.json({
      restaurant: {
        name: restaurant?.name ?? "",
        recoveryEmail: restaurant?.recoveryEmail ?? null,
        since: restaurant?.createdAt?.toISOString() ?? null,
      },
      subscription,
      recentInvoices: invoices,
      floor: {
        staffCount,
        tableCount,
        openChecks,
        lastServiceDate: lastService?.serviceDate?.toISOString().slice(0, 10) ?? null,
      },
      nextForecast: forecast
        ? {
            date: forecast.date,
            source: forecast.source,
            expectedCovers: Number(covers?.expected ?? 0) || null,
            low: Number(covers?.low ?? 0) || null,
            high: Number(covers?.high ?? 0) || null,
            confidence: String(covers?.confidence ?? ""),
          }
        : null,
      security: {
        adminPasscodeSet: adminSet,
        adminWindowMs: adminWindowRemaining(cookie),
      },
      links: {
        floor: process.env.NEXT_PUBLIC_FLOOR_URL ?? "",
        pos: process.env.NEXT_PUBLIC_POS_URL ?? "",
      },
    });
  });
}
