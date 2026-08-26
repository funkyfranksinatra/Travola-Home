// scripts/seed-fixture.mts — a production-SHAPED local fixture.
//
// Not a demo seed. Its job is to reproduce the awkward parts of the real
// database so the analysis engine is exercised against them before a
// customer is:
//   · nineteen months of history, most of it imported from another system
//   · dinner-only service, times stored as LOCAL wall clock in naive
//     columns (the floor app's convention)
//   · a handful of never-cleared tables with absurd turn times
//   · repeat guests, no-shows, cancellations, walk-ins
//   · closed POS checks for the recent weeks ONLY — so both the
//     money-present and money-absent branches are covered in one run
//
// Deterministic: a fixed-seed PRNG, so a failing assertion is reproducible.
import { PrismaClient } from "../lib/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

let seed = 1337;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)];
const between = (low: number, high: number) => low + Math.floor(rand() * (high - low + 1));
const gaussian = (m: number, sd: number) =>
  Math.round(m + sd * Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand()));

const RESTAURANT_ID = "fixture-restaurant";
const START = new Date(Date.UTC(2025, 0, 1));
const END = new Date(Date.UTC(2026, 7, 3));
/** Checks exist only for the last 30 service days. */
const MONEY_FROM = new Date(Date.UTC(2026, 6, 5));

const utcDate = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
/** LOCAL wall clock in a naive column — the floor app's convention. */
const localAt = (day: Date, hour: number, minute: number) =>
  new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute));

async function main() {
  console.log("wiping…");
  for (const table of [
    "Payment", "CheckItem", "Check", "MenuItem", "MenuCategory", "ShiftForecast",
    "ForecastAccuracy", "DailyBriefing", "TableSession", "ServiceEvent",
    "ReservationTable", "Reservation", "WaitlistEntry", "ShiftServer", "Shift",
    "Guest", "Server", "Table", "Floor", "RestaurantSettings", "ServiceDayStaff",
    "AuditLog", "DataExport", "Invoice", "Subscription", "Restaurant",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
  }

  await prisma.restaurant.create({
    data: {
      id: RESTAURANT_ID, name: "Fixture Bistro", nameKey: "fixture bistro",
      passcodeHash: "scrypt$fixture$fixture",
    },
  });
  await prisma.restaurantSettings.create({
    data: {
      id: "main", restaurantId: RESTAURANT_ID, openMinutes: 16 * 60, closeMinutes: 21 * 60,
      prefs: {
        turnTime: "90",
        daysOpen: [true, false, true, true, true, true, true],
        location: { name: "Fixture Bistro", timeZone: "America/Denver" },
      },
    },
  });
  await prisma.floor.create({ data: { id: "f1", name: "Dining", restaurantId: RESTAURANT_ID, sortOrder: 0 } });

  const tables = Array.from({ length: 20 }, (_, i) => ({
    id: `t${i + 1}`, name: String(i + 1), capacity: [2, 2, 4, 4, 4, 6][i % 6],
    restaurantId: RESTAURANT_ID, floorId: "f1", x: (i % 5) * 100, y: Math.floor(i / 5) * 100,
  }));
  await prisma.table.createMany({ data: tables });

  const serverNames = ["Ana", "Ben", "Cleo", "Dev", "Esme", "Finn"];
  const servers = serverNames.map((name, i) => ({
    id: `s${i + 1}`, name, restaurantId: RESTAURANT_ID, roles: ["waiter"], pin: String(1100 + i),
  }));
  await prisma.server.createMany({ data: servers });

  // ── Guests: a long tail plus a loyal core, so repeat rate is real ──
  const guestCount = 3200;
  const guests = Array.from({ length: guestCount }, (_, i) => ({
    id: `g${i}`, name: `Guest ${i}`, restaurantId: RESTAURANT_ID,
    phone: `555${String(i).padStart(7, "0")}`,
    vip: i % 97 === 0,
  }));
  for (let i = 0; i < guests.length; i += 500) {
    await prisma.guest.createMany({ data: guests.slice(i, i + 500) });
  }

  // ── Reservations ───────────────────────────────────────────────────
  const reservations: any[] = [];
  let outliersPlanted = 0;
  for (let day = new Date(START); day <= END; day.setUTCDate(day.getUTCDate() + 1)) {
    const dow = day.getUTCDay();
    if (dow === 1) continue; // closed Mondays
    const serviceDate = utcDate(day);
    const imported = serviceDate < new Date(Date.UTC(2026, 5, 1));
    // Weekend lift, plus a mild upward trend across the 19 months.
    const monthsIn = (serviceDate.getUTCFullYear() - 2025) * 12 + serviceDate.getUTCMonth();
    const trendFactor = 1 + monthsIn * 0.012;
    const base = (dow === 5 || dow === 6) ? 34 : dow === 0 ? 26 : 20;
    const partyCount = Math.max(4, Math.round(gaussian(base * trendFactor, 5)));

    for (let p = 0; p < partyCount; p += 1) {
      const roll = rand();
      const status = roll < 0.03 ? "NO_SHOW" : roll < 0.07 ? "CANCELLED" : "FINISHED";
      const partySize = pick([2, 2, 2, 3, 4, 4, 4, 5, 6, 8]);
      const hour = between(16, 20);
      const minute = pick([0, 15, 30, 45]);
      const target = localAt(serviceDate, hour, minute);
      const seated = status === "FINISHED"
        ? new Date(target.getTime() + between(-5, 25) * 60_000)
        : null;
      let turn: number | null = null;
      if (status === "FINISHED") {
        turn = Math.max(20, gaussian(88 + partySize * 3, 22));
        // Plant the never-cleared tables the real data carries.
        if (!imported && outliersPlanted < 30 && rand() < 0.004) {
          turn = between(700, 14000);
          outliersPlanted += 1;
        }
      }
      const walkIn = !imported && rand() < 0.22;
      reservations.push({
        id: `r${reservations.length}`,
        guestId: `g${Math.floor(Math.pow(rand(), 1.7) * guestCount)}`,
        restaurantId: RESTAURANT_ID,
        partySize, status,
        source: imported ? "OPENTABLE_IMPORT" : walkIn ? "WALK_IN" : "MESAOS",
        targetTime: target,
        seatedTime: seated,
        finishedTime: seated && turn ? new Date(seated.getTime() + turn * 60_000) : null,
        cancelledAt: status === "CANCELLED" ? new Date(target.getTime() - 3600_000) : null,
        serviceDate,
        dayOfWeek: dow,
        turnMinutes: turn,
        serverId: pick(servers).id,
        vip: rand() < 0.02,
      });
    }
  }
  console.log(`reservations: ${reservations.length} (${outliersPlanted} never-cleared planted)`);
  for (let i = 0; i < reservations.length; i += 1000) {
    await prisma.reservation.createMany({ data: reservations.slice(i, i + 1000) });
  }

  // ── Waitlist (recent months only) ──────────────────────────────────
  const waitlist: any[] = [];
  for (let day = new Date(Date.UTC(2026, 5, 1)); day <= END; day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() === 1) continue;
    for (let i = 0; i < between(0, 6); i += 1) {
      const serviceDate = utcDate(day);
      const arrival = localAt(serviceDate, between(17, 20), between(0, 59));
      const quoted = pick([15, 20, 30, 45]);
      const left = rand() < 0.12;
      const actual = left ? null : Math.max(2, gaussian(quoted + 6, 10));
      waitlist.push({
        id: `w${waitlist.length}`, restaurantId: RESTAURANT_ID,
        name: `Walk-in ${i}`, partySize: pick([2, 2, 3, 4]),
        status: left ? "LEFT" : "SEATED", source: "WALK_IN",
        arrivalTime: arrival, quotedMinutes: quoted,
        seatedTime: left ? null : new Date(arrival.getTime() + (actual ?? 0) * 60_000),
        leftTime: left ? new Date(arrival.getTime() + quoted * 60_000) : null,
        actualWaitMinutes: actual,
        serviceDate, dayOfWeek: day.getUTCDay(),
      });
    }
  }
  await prisma.waitlistEntry.createMany({ data: waitlist });
  console.log(`waitlist: ${waitlist.length}`);

  // ── Menu ───────────────────────────────────────────────────────────
  const categories = [
    { id: "c1", name: "Starters", items: [["Caesar Salad", 1400], ["Burrata", 1800], ["Calamari", 1600], ["Soup", 1100], ["Beet Salad", 1300]] },
    { id: "c2", name: "Mains", items: [["Ribeye", 4800], ["Salmon", 3200], ["Burger", 2200], ["Cacio e Pepe", 2400], ["Chicken", 2800], ["Short Rib", 3600], ["Risotto", 2600]] },
    { id: "c3", name: "Desserts", items: [["Tiramisu", 1200], ["Panna Cotta", 1100], ["Affogato", 900]] },
    { id: "c4", name: "Drinks", items: [["House Red", 1400], ["House White", 1400], ["Negroni", 1600], ["Espresso", 500], ["Sparkling Water", 700]] },
  ];
  for (const [ci, cat] of categories.entries()) {
    await prisma.menuCategory.create({ data: { id: cat.id, restaurantId: RESTAURANT_ID, name: cat.name, sortOrder: ci } });
    await prisma.menuItem.createMany({
      data: cat.items.map(([name, price], i) => ({
        id: `${cat.id}-i${i}`, restaurantId: RESTAURANT_ID, categoryId: cat.id,
        name: name as string, priceCents: price as number,
        station: cat.id === "c4" ? "bar" : "kitchen", sortOrder: i,
      })),
    });
  }
  // One dish nobody has ever ordered — the "never sold" case.
  await prisma.menuItem.create({
    data: { id: "c2-ghost", restaurantId: RESTAURANT_ID, categoryId: "c2", name: "Sweetbreads", priceCents: 3400, station: "kitchen", sortOrder: 99 },
  });

  const menuItems = await prisma.menuItem.findMany({ where: { restaurantId: RESTAURANT_ID } });
  const sellable = menuItems.filter((m) => m.name !== "Sweetbreads");

  // ── Checks: the last 30 service days only ──────────────────────────
  // POS timestamps are REAL UTC instants (now()), unlike the floor app's
  // local wall clock — the fixture reproduces that seam on purpose.
  const DENVER_OFFSET_HOURS = 6;
  const checks: any[] = [];
  const checkItems: any[] = [];
  const payments: any[] = [];
  const sessions: any[] = [];
  for (const res of reservations) {
    if (res.status !== "FINISHED") continue;
    if (res.serviceDate < MONEY_FROM) continue;
    if (!res.seatedTime) continue;
    const checkId = `chk${checks.length}`;
    const openedLocal = new Date(res.seatedTime.getTime() + 12 * 60_000);
    const openedAt = new Date(openedLocal.getTime() + DENVER_OFFSET_HOURS * 3600_000);
    const lines = between(2, 5);
    let subtotal = 0;
    for (let i = 0; i < lines; i += 1) {
      // Bias toward mains so the mix has a clear top seller.
      const item = rand() < 0.45 ? pick(sellable.filter((m) => m.categoryId === "c2")) : pick(sellable);
      const quantity = rand() < 0.2 ? 2 : 1;
      subtotal += item.priceCents * quantity;
      checkItems.push({
        id: `ci${checkItems.length}`, checkId, menuItemId: item.id,
        nameSnapshot: item.name, priceCents: item.priceCents, quantity,
        course: item.categoryId === "c1" ? 1 : item.categoryId === "c3" ? 3 : 2,
        modifiers: [], station: item.station, state: "bumped",
      });
    }
    const tax = Math.round(subtotal * 0.084);
    const tip = Math.round(subtotal * (0.18 + rand() * 0.08));
    const total = subtotal + tax + tip;
    const closedAt = new Date(openedAt.getTime() + (res.turnMinutes ?? 90) * 60_000);
    checks.push({
      id: checkId, restaurantId: RESTAURANT_ID, tableLabel: pick(tables).name,
      serverId: res.serverId, serverName: "", status: "closed",
      openedAt, closedAt,
      subtotalCents: subtotal, taxCents: tax, tipCents: tip, totalCents: total,
      guestCount: res.partySize,
    });
    payments.push({
      id: `pay${payments.length}`, restaurantId: RESTAURANT_ID, checkId,
      method: rand() < 0.85 ? "card" : "cash", amountCents: total - tip, tipCents: tip,
      createdAt: closedAt,
    });
    sessions.push({
      id: `sess${sessions.length}`, restaurantId: RESTAURANT_ID,
      serviceDate: res.serviceDate, primaryTableId: pick(tables).id,
      tableIds: [pick(tables).id], serverId: res.serverId,
      guestCount: res.partySize,
      seatedAt: new Date(res.seatedTime.getTime() + DENVER_OFFSET_HOURS * 3600_000),
      firstOrderAt: new Date(res.seatedTime.getTime() + DENVER_OFFSET_HOURS * 3600_000 + between(4, 18) * 60_000),
      checkPaidAt: closedAt,
      clearedAt: new Date(closedAt.getTime() + between(3, 14) * 60_000),
      turnMinutes: res.turnMinutes,
      paidToClearMinutes: between(3, 14),
      checkId, subtotalCents: subtotal, totalCents: total, tipCents: tip,
      ppaCents: Math.round(total / res.partySize),
      origin: "floor",
    });
  }
  for (let i = 0; i < checks.length; i += 500) await prisma.check.createMany({ data: checks.slice(i, i + 500) });
  for (let i = 0; i < checkItems.length; i += 1000) await prisma.checkItem.createMany({ data: checkItems.slice(i, i + 1000) });
  for (let i = 0; i < payments.length; i += 500) await prisma.payment.createMany({ data: payments.slice(i, i + 500) });
  for (let i = 0; i < sessions.length; i += 500) await prisma.tableSession.createMany({ data: sessions.slice(i, i + 500) });
  console.log(`checks: ${checks.length}, lines: ${checkItems.length}, sessions: ${sessions.length}`);

  // ── Forecasts for the recent weeks, so accuracy has something to score
  const forecasts: any[] = [];
  for (let day = new Date(Date.UTC(2026, 6, 1)); day <= END; day.setUTCDate(day.getUTCDate() + 1)) {
    const key = day.toISOString().slice(0, 10);
    forecasts.push({
      id: `f${forecasts.length}`, restaurantId: RESTAURANT_ID, date: key, source: "weekly",
      payload: { date: key, covers: { expected: between(70, 130), low: 60, high: 150, confidence: "medium" } },
    });
  }
  await prisma.shiftForecast.createMany({ data: forecasts });
  console.log(`forecasts: ${forecasts.length}`);

  await prisma.$disconnect();
  console.log("done");
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
