// lib/analytics/math.ts — every pure calculation the analysis tab makes.
//
// Deliberately free of Prisma, Next and Date.now(): this file is what the
// unit tests exercise, because these are the places a dashboard lies.
// Percent change with a zero base, an "average of averages", a median on
// an empty array and a growth number computed against a partial month are
// all quiet ways to print a confident wrong number.

/**
 * Percent change, or null when the comparison is meaningless.
 *
 * A zero base is NOT "infinite growth" and NOT "100%": going from 0 to 40
 * covers has no percentage. Returning null makes the UI say "no prior
 * period" instead of "+∞%", which is the honest answer.
 */
export function pctChange(current: number | null | undefined, prior: number | null | undefined): number | null {
  if (current == null || prior == null) return null;
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return null;
  if (prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/** Mean of the finite values, or null when there are none. */
export function mean(values: Array<number | null | undefined>): number | null {
  const clean = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!clean.length) return null;
  return clean.reduce((sum, v) => sum + v, 0) / clean.length;
}

/**
 * Median — the right centre for turn time and check size, both of which
 * are right-skewed (one four-hour anniversary table drags a mean turn
 * time up by minutes that no shift actually experienced).
 */
export function median(values: Array<number | null | undefined>): number | null {
  const clean = values
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

/**
 * A weighted mean. Use this wherever a per-day average is rolled up to a
 * period average: averaging the daily averages gives a Tuesday with four
 * covers the same weight as a Saturday with two hundred.
 */
export function weightedMean(
  rows: Array<{ value: number | null | undefined; weight: number | null | undefined }>,
): number | null {
  let total = 0;
  let weight = 0;
  for (const row of rows) {
    if (typeof row.value !== "number" || !Number.isFinite(row.value)) continue;
    const w = typeof row.weight === "number" && Number.isFinite(row.weight) ? row.weight : 0;
    if (w <= 0) continue;
    total += row.value * w;
    weight += w;
  }
  return weight > 0 ? total / weight : null;
}

/** Service period from a local clock hour, matching the ShiftPeriod enum. */
export function periodForHour(hour: number): "BRUNCH" | "LUNCH" | "DINNER" {
  if (hour < 11) return "BRUNCH";
  if (hour < 16) return "LUNCH";
  return "DINNER";
}

/**
 * Menu-engineering quadrant (Kasavana–Smith).
 *
 * Popularity is measured against 70% of a fair equal share — the standard
 * cutoff — rather than against the mean, which a single runaway seller
 * would drag high enough to label the whole menu unpopular. Profit is
 * approximated by price, because Travola Home has no food-cost data: the
 * quadrant is therefore advisory, and the UI says so.
 */
export function quadrantFor(opts: {
  quantity: number;
  totalQuantity: number;
  itemCount: number;
  priceCents: number;
  medianPriceCents: number;
}): "star" | "plowhorse" | "puzzle" | "dog" {
  const fairShare = opts.itemCount > 0 ? opts.totalQuantity / opts.itemCount : 0;
  const popular = opts.quantity >= fairShare * 0.7 && fairShare > 0;
  // A zero-price line is never "high margin". Without the `> 0` guard an
  // empty menu (every figure zero) labels itself a menu of puzzles —
  // "high-priced but rarely ordered" — which is exactly backwards, and a
  // comped or zero-priced item in real data gets the same wrong badge.
  const highMargin = opts.priceCents > 0 && opts.priceCents >= opts.medianPriceCents;
  if (popular && highMargin) return "star";
  if (popular && !highMargin) return "plowhorse";
  if (!popular && highMargin) return "puzzle";
  return "dog";
}

/**
 * Revenue per available seat hour — the hotel/restaurant yield metric
 * that combines "did we fill the room" with "did we charge enough",
 * which neither covers nor average check tells you alone.
 */
export function revPASH(opts: {
  revenueCents: number | null;
  seats: number;
  serviceHoursPerDay: number;
  serviceDays: number;
}): number | null {
  if (opts.revenueCents == null) return null;
  const seatHours = opts.seats * opts.serviceHoursPerDay * opts.serviceDays;
  if (seatHours <= 0) return null;
  return opts.revenueCents / seatHours;
}

/**
 * Seat utilisation: covers served against the covers the room could
 * physically have served at the observed turn time.
 */
export function seatUtilisationPct(opts: {
  covers: number;
  seats: number;
  serviceHoursPerDay: number;
  turnMinutes: number;
  serviceDays: number;
}): number | null {
  if (opts.seats <= 0 || opts.turnMinutes <= 0 || opts.serviceDays <= 0) return null;
  const turnsPerDay = (opts.serviceHoursPerDay * 60) / opts.turnMinutes;
  const capacity = opts.seats * turnsPerDay * opts.serviceDays;
  if (capacity <= 0) return null;
  return (opts.covers / capacity) * 100;
}

/**
 * Is a month complete enough to compare?
 *
 * Growth month-over-month against a month that is four days old reads as
 * a catastrophic collapse. When the latest month is still running we
 * compare like-for-like: the same day-of-month cut in both months.
 */
export function monthIsComplete(month: string, today: Date): boolean {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return false;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const isCurrent = today.getUTCFullYear() === y && today.getUTCMonth() + 1 === m;
  return !isCurrent || today.getUTCDate() >= lastDay;
}

/** UTC-midnight Date for a YYYY-MM-DD key (the serviceDate convention). */
export function serviceDateOf(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

export function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** "2026-08" -> "Aug 2026" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} ${y}`;
}

/** The month key twelve months earlier — for year-over-year pairing. */
export function priorYearMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

export function priorMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function dayName(dow: number): string {
  return DAY_NAMES[dow] ?? "";
}

/** Format an hour (0–23) as "6 pm" / "11 am". */
export function hourLabel(hour: number): string {
  if (hour === 0) return "12 am";
  if (hour === 12) return "12 pm";
  return hour < 12 ? `${hour} am` : `${hour - 12} pm`;
}

/** Postgres BIGINT / NUMERIC come back as bigint or string from raw SQL. */
export function num(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** num(), but never null — for counters where absent means zero. */
export function count(value: unknown): number {
  return num(value) ?? 0;
}
