// app/api/settings/route.ts — the handful of facts that shape everything else.
//
// Service hours, days open and the restaurant's timezone are not cosmetic:
// they are the denominators behind seat utilisation and revenue per seat
// hour, and the clock the analysis tab reads an hour in. Getting them
// wrong quietly moves numbers on other pages, which is why they are
// editable here rather than buried.
//
// These rows belong to the floor app. Two rules follow from that:
//   1. `prefs` is MERGED, never replaced. It also carries the floor app's
//      tour state, auto-assign flag and quote settings, and a blind
//      overwrite would silently reset a manager's preferences there.
//   2. Renaming the restaurant rewrites `nameKey`, which is the sign-in
//      identifier for ALL THREE apps. It is allowed, because a typo in the
//      name would otherwise be permanent, but the response says plainly
//      what just changed.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withTenant, requireRestaurant } from "@/lib/tenant";
import { appLinks } from "@/lib/apps";
import { audit } from "@/lib/audit";
import { nameKey } from "@/lib/restaurant-auth";
import { mergePrefs } from "@/lib/settings-prefs";

export const dynamic = "force-dynamic";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function safeTimeZone(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  return withTenant(request, async (restaurantId) => {
    const [restaurant, settings, counts] = await Promise.all([
      prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { name: true, nameKey: true, recoveryEmail: true, createdAt: true },
      }),
      prisma.restaurantSettings.findUnique({ where: { restaurantId } }),
      Promise.all([
        prisma.table.count({ where: { restaurantId, active: true } }),
        prisma.floor.count({ where: { restaurantId, active: true } }),
        prisma.menuItem.count({ where: { restaurantId, active: true } }),
        prisma.server.count({ where: { restaurantId, active: true } }),
      ]),
    ]);

    const prefs = (settings?.prefs ?? {}) as Record<string, unknown>;
    const location = (prefs.location ?? {}) as Record<string, unknown>;
    const daysOpenRaw = Array.isArray(prefs.daysOpen) ? prefs.daysOpen : [];

    return Response.json({
      restaurant: {
        name: restaurant?.name ?? "",
        nameKey: restaurant?.nameKey ?? "",
        recoveryEmail: restaurant?.recoveryEmail ?? "",
        since: restaurant?.createdAt?.toISOString() ?? null,
      },
      service: {
        openMinutes: settings?.openMinutes ?? null,
        closeMinutes: settings?.closeMinutes ?? null,
        daysOpen: DAY_NAMES.map((_, index) =>
          typeof daysOpenRaw[index] === "boolean" ? (daysOpenRaw[index] as boolean) : true,
        ),
        timeZone: safeTimeZone(location.timeZone) ?? "UTC",
        turnMinutes: Number(prefs.turnTime) || 90,
        largePartySize: Number(prefs.largeParty) || 10,
        holdWindowMinutes: Number(prefs.holdWindow) || 15,
        reservationBufferMinutes: Number(prefs.resBuffer) || 0,
        locationName: typeof location.name === "string" ? location.name : "",
        address: typeof location.address === "string" ? location.address : "",
      },
      inventory: { tables: counts[0], floors: counts[1], menuItems: counts[2], staff: counts[3] },
      links: appLinks(),
      dayNames: DAY_NAMES,
    });
  });
}

export async function PATCH(request: Request) {
  let restaurantId: string;
  try {
    restaurantId = requireRestaurant(request);
  } catch (error) {
    return error as Response;
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Nothing to save." }, { status: 400 });

  const notes: string[] = [];

  // ── Identity ───────────────────────────────────────────────────────
  if (typeof body.name === "string" && body.name.trim()) {
    const name = body.name.trim().slice(0, 120);
    const key = nameKey(name);
    if (!key) return NextResponse.json({ error: "That name cannot be used." }, { status: 400 });
    const clash = await prisma.restaurant.findFirst({
      where: { nameKey: key, NOT: { id: restaurantId } },
      select: { id: true },
    });
    if (clash) {
      return NextResponse.json({ error: "Another restaurant already uses that name." }, { status: 409 });
    }
    const current = await prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { name: true, nameKey: true } });
    if (current && current.nameKey !== key) {
      notes.push(`Everyone now signs in to all three apps with "${name}" instead of "${current.name}".`);
      await audit({
        restaurantId, action: "settings.renamed", req: request,
        summary: `Renamed the restaurant from "${current.name}" to "${name}" — this is the sign-in name for all three apps`,
      });
    }
    await prisma.restaurant.update({ where: { id: restaurantId }, data: { name, nameKey: key } });
  }

  if (typeof body.recoveryEmail === "string") {
    await prisma.restaurant.update({
      where: { id: restaurantId },
      data: { recoveryEmail: body.recoveryEmail.trim().slice(0, 200) || null },
    });
  }

  // ── Service ────────────────────────────────────────────────────────
  const existing = await prisma.restaurantSettings.findUnique({ where: { restaurantId } });

  const minuteOf = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed < 24 * 60 ? Math.round(parsed) : null;
  };
  const openMinutes = body.openMinutes === undefined ? undefined : minuteOf(body.openMinutes);
  const closeMinutes = body.closeMinutes === undefined ? undefined : minuteOf(body.closeMinutes);

  let timeZone: string | undefined;
  if (body.timeZone !== undefined) {
    const zone = safeTimeZone(body.timeZone);
    if (!zone) return NextResponse.json({ error: "That is not a timezone this browser recognises." }, { status: 400 });
    timeZone = zone;
    notes.push("Hourly figures on the analysis tab now read in that clock.");
  }

  // Merged, never replaced — see lib/settings-prefs.ts.
  const prefs = mergePrefs((existing?.prefs ?? {}) as Record<string, unknown>, {
    daysOpen: body.daysOpen,
    timeZone,
    address: body.address,
    locationName: body.locationName,
    turnMinutes: body.turnMinutes,
    largePartySize: body.largePartySize,
    holdWindowMinutes: body.holdWindowMinutes,
    reservationBufferMinutes: body.reservationBufferMinutes,
  });

  await prisma.restaurantSettings.upsert({
    where: { restaurantId },
    // `prefs` is merged above, never replaced — it also carries the floor
    // app's own settings.
    update: {
      ...(openMinutes !== undefined ? { openMinutes } : {}),
      ...(closeMinutes !== undefined ? { closeMinutes } : {}),
      prefs: prefs as never,
    },
    create: {
      id: "main",
      restaurantId,
      openMinutes: openMinutes ?? 16 * 60,
      closeMinutes: closeMinutes ?? 22 * 60,
      prefs: prefs as never,
    },
  });

  await audit({
    restaurantId, action: "settings.updated", req: request,
    summary: "Updated restaurant settings",
    detail: { keys: Object.keys(body) },
  });

  return NextResponse.json({ ok: true, notes });
}
