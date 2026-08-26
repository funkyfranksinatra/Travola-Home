// app/api/staff/route.ts — logins: staff PINs and restaurant credentials.
//
// This is the page an owner reaches for the morning after someone quits,
// so the destructive half is deliberately blunt: revoking a PIN is one
// click and takes effect on the next POS sign-in.
//
// A note on why staff are DEACTIVATED and not deleted: every reservation,
// check and section assignment they ever touched references them. Deleting
// the row would either fail on a foreign key or orphan two years of
// history and quietly change the numbers on the analysis tab. Deactivating
// revokes access — which is what "delete this ex-employee" actually means
// — and keeps the record honest.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withTenant, requireRestaurant } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { hashPasscode, hasAdminPasscode, verifyAdminPasscode, allowAttempt } from "@/lib/restaurant-auth";
import { setSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withTenant(request, async (restaurantId) => {
    const [servers, restaurant, adminSet] = await Promise.all([
      prisma.server.findMany({
        where: { restaurantId },
        orderBy: [{ active: "desc" }, { name: "asc" }],
        select: { id: true, name: true, roles: true, active: true, pin: true, onShift: true, createdAt: true },
      }),
      prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { name: true, recoveryEmail: true } }),
      hasAdminPasscode(restaurantId),
    ]);

    const lastSeen = await prisma.reservation.groupBy({
      by: ["serverId"],
      where: { restaurantId, serverId: { not: null } },
      _max: { serviceDate: true },
    });
    const seen = new Map(lastSeen.map((row) => [row.serverId, row._max.serviceDate]));

    return Response.json({
      restaurant: { name: restaurant?.name ?? "", recoveryEmail: restaurant?.recoveryEmail ?? null },
      adminPasscodeSet: adminSet,
      // The PIN itself is never returned — only whether one is set. A
      // manager who forgets a server's PIN resets it; they do not read it
      // off a screen that anyone walking past can see.
      staff: servers.map((row) => ({
        id: row.id,
        name: row.name,
        roles: row.roles,
        active: row.active,
        hasPin: Boolean(row.pin),
        onShift: row.onShift,
        addedAt: row.createdAt.toISOString(),
        lastServiceDate: seen.get(row.id)?.toISOString().slice(0, 10) ?? null,
      })),
    });
  });
}

/** Staff actions: reset a PIN, revoke access, restore access. */
export async function PATCH(request: Request) {
  return withTenant(request, async (restaurantId) => {
    const body = await request.json().catch(() => null);
    const serverId = String(body?.serverId ?? "");
    const action = String(body?.action ?? "");
    const server = await prisma.server.findFirst({ where: { id: serverId, restaurantId } });
    if (!server) return Response.json({ error: "No such staff member." }, { status: 404 });

    if (action === "set_pin") {
      const pin = String(body?.pin ?? "");
      if (!/^\d{4}$/.test(pin)) return Response.json({ error: "A PIN is four digits." }, { status: 400 });
      // The unique index is (restaurantId, pin): two servers sharing a PIN
      // would make every check ambiguous, so the collision is caught here
      // with a readable message rather than surfacing as a 500.
      const clash = await prisma.server.findFirst({
        where: { restaurantId, pin, NOT: { id: serverId } },
        select: { name: true },
      });
      if (clash) return Response.json({ error: `${clash.name} already uses that PIN.` }, { status: 409 });
      await prisma.server.update({ where: { id: serverId }, data: { pin } });
      await audit({ restaurantId, action: "staff.pin_reset", summary: `Set a new POS PIN for ${server.name}`, req: request });
      return Response.json({ ok: true });
    }

    if (action === "clear_pin") {
      await prisma.server.update({ where: { id: serverId }, data: { pin: null } });
      await audit({ restaurantId, action: "staff.pin_reset", summary: `Removed ${server.name}'s POS PIN`, req: request });
      return Response.json({ ok: true });
    }

    if (action === "deactivate") {
      await prisma.server.update({
        where: { id: serverId },
        data: { active: false, pin: null, onShift: false },
      });
      await audit({
        restaurantId, action: "staff.deactivated", req: request,
        summary: `Revoked ${server.name}'s access and cleared their PIN`,
        detail: { serverId, name: server.name },
      });
      return Response.json({ ok: true });
    }

    if (action === "reactivate") {
      await prisma.server.update({ where: { id: serverId }, data: { active: true } });
      await audit({ restaurantId, action: "staff.reactivated", summary: `Restored ${server.name}'s access`, req: request });
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Unknown action." }, { status: 400 });
  });
}

/** Restaurant-level credentials: rotate the passcode, set the admin code. */
export async function POST(request: Request) {
  let restaurantId: string;
  try {
    restaurantId = requireRestaurant(request);
  } catch (error) {
    return error as Response;
  }
  if (!allowAttempt(request, "console-credentials", 8)) {
    return NextResponse.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  const action = String(body?.action ?? "");
  const next = String(body?.passcode ?? "");

  if (!/^\d{4}$/.test(next)) {
    return NextResponse.json({ error: "A code is four digits." }, { status: 400 });
  }

  // Both of these change who can get in, so both require proving the
  // current admin credential in the same request — a signed-in tablet left
  // on the pass must not be able to lock the owner out.
  const proof = await verifyAdminPasscode(restaurantId, String(body?.currentPasscode ?? ""));
  if (!proof.ok) {
    return NextResponse.json({ error: "Your current code is not right." }, { status: 401 });
  }

  if (action === "rotate_passcode") {
    await prisma.restaurant.update({
      where: { id: restaurantId },
      data: { passcodeHash: await hashPasscode(next) },
    });
    await audit({
      restaurantId, action: "credentials.passcode_rotated", req: request,
      summary: "Changed the restaurant code used to sign in to all three apps",
    });
    return setSession(
      NextResponse.json({
        ok: true,
        note: "Everyone signing in to the floor manager, the POS or the Console will need the new code.",
      }),
      restaurantId,
      true,
    );
  }

  if (action === "set_admin_passcode") {
    await prisma.restaurant.update({
      where: { id: restaurantId },
      data: { adminPasscodeHash: await hashPasscode(next) },
    });
    await audit({
      restaurantId, action: "credentials.admin_passcode_set", req: request,
      summary: "Set a separate owner code for irreversible actions",
    });
    return setSession(NextResponse.json({ ok: true }), restaurantId, true);
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
