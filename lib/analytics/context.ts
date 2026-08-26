// lib/analytics/context.ts — the restaurant facts every metric needs.
//
// Loaded once per analysis request and threaded through, rather than
// re-queried per metric. The timezone matters more than it looks: the
// floor app stores serviceDate as a UTC-midnight DATE but stores
// targetTime/seatedTime as real timestamps, so "how many covers at 7pm"
// is only right if the hour is read in the restaurant's own clock.
// Volario's is in America/Denver; reading its 6pm seating in UTC would
// file it as midnight and put the dinner peak on the wrong day.
import { prisma } from "../prisma";

export type AnalysisContext = {
  restaurantId: string;
  restaurantName: string;
  timeZone: string;
  /** Minutes past midnight, local. Falls back to a 16:00–22:00 service. */
  openMinutes: number;
  closeMinutes: number;
  serviceHoursPerDay: number;
  /** Sunday-first flags from the floor app's settings. */
  daysOpen: boolean[];
  /** Total seats across active tables — the denominator for yield. */
  seats: number;
  tableCount: number;
  /** The floor app's configured turn time, used when none is observed. */
  defaultTurnMinutes: number;
};

const DEFAULT_OPEN = 16 * 60;
const DEFAULT_CLOSE = 22 * 60;

/** Validate a tz string before it reaches SQL as `AT TIME ZONE`. */
function safeTimeZone(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return raw;
  } catch {
    return "UTC";
  }
}

export async function loadContext(restaurantId: string): Promise<AnalysisContext> {
  const [restaurant, settings, tables] = await Promise.all([
    prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { name: true } }),
    prisma.restaurantSettings.findUnique({
      where: { restaurantId },
      select: { openMinutes: true, closeMinutes: true, prefs: true },
    }),
    prisma.table.findMany({
      where: { restaurantId, active: true },
      select: { capacity: true },
    }),
  ]);

  const prefs = (settings?.prefs ?? {}) as Record<string, unknown>;
  const location = (prefs.location ?? {}) as Record<string, unknown>;
  const daysOpenRaw = Array.isArray(prefs.daysOpen) ? prefs.daysOpen : [];
  const daysOpen = Array.from({ length: 7 }, (_, i) =>
    typeof daysOpenRaw[i] === "boolean" ? (daysOpenRaw[i] as boolean) : true,
  );

  const openMinutes = settings?.openMinutes ?? DEFAULT_OPEN;
  const closeMinutes = settings?.closeMinutes ?? DEFAULT_CLOSE;
  // A close time before the open time means service crosses midnight.
  const span = closeMinutes > openMinutes ? closeMinutes - openMinutes : closeMinutes + 24 * 60 - openMinutes;

  const turnRaw = Number(prefs.turnTime);

  return {
    restaurantId,
    restaurantName: restaurant?.name ?? "",
    timeZone: safeTimeZone(location.timeZone),
    openMinutes,
    closeMinutes,
    serviceHoursPerDay: Math.max(1, span / 60),
    daysOpen,
    seats: tables.reduce((sum, t) => sum + (t.capacity || 0), 0),
    tableCount: tables.length,
    defaultTurnMinutes: Number.isFinite(turnRaw) && turnRaw > 0 ? turnRaw : 90,
  };
}
