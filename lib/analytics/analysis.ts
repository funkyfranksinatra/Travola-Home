// lib/analytics/analysis.ts — assembles the analysis tab.
//
// One request in, one AnalysisResult out. The rules this file follows,
// which are the difference between a dashboard an owner trusts and one
// they stop opening after a week:
//
//   1. Never print a number the data cannot support. Every metric
//      carries an availability state and, when it is not `ready`, the
//      reason in plain English.
//   2. Never compare against nothing. A percent change with a zero or
//      missing base is null, not "+100%".
//   3. Roll up weighted, not averaged-of-averages. A Tuesday with four
//      covers does not get the same vote as a Saturday with two hundred.
//   4. Say what was excluded. Outlier turn times are dropped and counted,
//      not silently absorbed.
import type { AnalysisContext } from "./context";
import { loadContext } from "./context";
import * as q from "./queries";
import {
  addDays, count, dateKeyOf, dayName, hourLabel, mean, median, monthIsComplete,
  monthLabel, num, pctChange, priorMonth, priorYearMonth, revPASH, quadrantFor,
  seatUtilisationPct, serviceDateOf, weightedMean,
} from "./math";
import type {
  AnalysisResult, Availability, Metric, MetricGroup, MenuMixRow, SeriesPoint, ServiceShiftRow, Trend,
} from "./types";

export type RangeKey = "30d" | "90d" | "365d" | "all" | "custom";

/** How many service days a metric wants before it stops apologising. */
const THIN_SAMPLE_DAYS = 14;

function metric(
  key: string, label: string, group: MetricGroup, unit: Metric["unit"],
  value: number | string | null,
  opts: { available?: Availability; reason?: string; sampleSize?: number; trend?: Trend | null; hint?: string } = {},
): Metric {
  const available: Availability =
    opts.available ?? (value == null ? "insufficient" : "ready");
  return {
    key, label, group, unit, value, available,
    reason: opts.reason, sampleSize: opts.sampleSize,
    trend: opts.trend ?? null, hint: opts.hint,
  };
}

function trend(current: number | null, prior: number | null, basis: string, goodWhen: Trend["goodWhen"]): Trend | null {
  const pct = pctChange(current, prior);
  return pct == null ? null : { pct, basis, goodWhen };
}

/** Resolve the requested window against the data that actually exists. */
export function resolveRange(
  key: RangeKey,
  bounds: { firstServiceDate: Date | null; lastServiceDate: Date | null },
  today: Date,
  custom?: { from?: string; to?: string },
) {
  const last = bounds.lastServiceDate ?? today;
  const first = bounds.firstServiceDate ?? addDays(today, -30);
  const todayKey = dateKeyOf(today);

  // `days` is ALWAYS the inclusive span of [from, to]. It is not
  // decorative: the comparison window is built by stepping back exactly
  // this many days, so a `days` that disagrees with the window silently
  // compares against a misaligned period.
  const span = (from: Date, to: Date) =>
    Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);

  if (key === "custom" && custom?.from && custom?.to) {
    const from = serviceDateOf(custom.from);
    const to = serviceDateOf(custom.to);
    return { from, to, days: span(from, to), label: `${custom.from} to ${custom.to}` };
  }
  if (key === "all") {
    const to = serviceDateOf(todayKey);
    // `last` is unused for the window itself — an all-time range still
    // ends today, so a gap since the final record shows as a gap.
    void last;
    return { from: first, to, days: span(first, to), label: "All time" };
  }
  const preset = key === "30d" ? 30 : key === "365d" ? 365 : 90;
  const to = serviceDateOf(todayKey);
  return { from: addDays(to, -(preset - 1)), to, days: preset, label: `Last ${preset} days` };
}

export async function buildAnalysis(opts: {
  restaurantId: string;
  range: RangeKey;
  custom?: { from?: string; to?: string };
  /** Injected so tests are deterministic. */
  now?: Date;
}): Promise<AnalysisResult> {
  const now = opts.now ?? new Date();
  const ctx = await loadContext(opts.restaurantId);
  const bounds = await q.loadBounds(opts.restaurantId);
  const range = resolveRange(opts.range, bounds, now, opts.custom);

  // The immediately preceding window of equal length, for every trend.
  const priorTo = addDays(range.from, -1);
  const priorFrom = addDays(priorTo, -(range.days - 1));
  const basis = `vs previous ${range.days} days`;

  const [
    rollup, priorRollup, moneyDays, priorMoneyDays,
    monthlyCovers, monthlyRevenue, hourly, dow, partySize,
    itemMix, neverSold, servers, waitlist, priorWaitlist,
    guests, pace, forecast, dailyCovers, weekHeat,
  ] = await Promise.all([
    q.loadShiftRollup(opts.restaurantId, range.from, range.to),
    q.loadShiftRollup(opts.restaurantId, priorFrom, priorTo),
    q.loadMoneyByDay(opts.restaurantId, ctx.timeZone, range.from, range.to),
    q.loadMoneyByDay(opts.restaurantId, ctx.timeZone, priorFrom, priorTo),
    q.loadMonthlyCovers(opts.restaurantId),
    q.loadMonthlyRevenue(opts.restaurantId, ctx.timeZone),
    q.loadHourly(opts.restaurantId, range.from, range.to),
    q.loadDayOfWeek(opts.restaurantId, range.from, range.to),
    q.loadPartySize(opts.restaurantId, range.from, range.to),
    q.loadItemMix(opts.restaurantId, ctx.timeZone, range.from, range.to),
    q.loadNeverSold(opts.restaurantId),
    q.loadServerPerformance(opts.restaurantId, range.from, range.to),
    q.loadWaitlist(opts.restaurantId, range.from, range.to),
    q.loadWaitlist(opts.restaurantId, priorFrom, priorTo),
    q.loadGuestRetention(opts.restaurantId, range.from, range.to),
    q.loadPace(opts.restaurantId, range.from, range.to),
    q.loadForecastAccuracy(opts.restaurantId, range.from, range.to),
    q.loadDailyCovers(opts.restaurantId, range.from, range.to),
    q.loadWeekHeatmap(opts.restaurantId, range.from, range.to),
  ]);

  // ── Shift table ────────────────────────────────────────────────────
  const moneyByDay = new Map(moneyDays.map((row) => [dateKeyOf(row.d), row]));
  const shifts: ServiceShiftRow[] = rollup.map((row) => {
    const dateKey = dateKeyOf(row.d);
    const money = moneyByDay.get(dateKey);
    const covers = count(row.covers);
    const parties = count(row.parties);
    // Money is per service DAY, not per period. Attributing a day's
    // revenue to the dinner row (where practically all of it is earned)
    // beats splitting it evenly across periods that did not earn it.
    const isPrimaryPeriod = row.period === "DINNER";
    const revenue = money && isPrimaryPeriod ? count(money.revenue) : null;
    const checks = money && isPrimaryPeriod ? count(money.checks) : 0;
    const moneyGuests = money && isPrimaryPeriod ? count(money.guests) : 0;
    return {
      date: dateKey,
      period: row.period as ServiceShiftRow["period"],
      dayOfWeek: row.dow,
      covers,
      parties,
      avgPartySize: num(row.avg_party),
      avgTurnMinutes: num(row.median_turn) ?? num(row.avg_turn),
      walkInParties: count(row.walk_in_parties),
      noShows: count(row.no_shows),
      cancellations: count(row.cancellations),
      avgSeatDelayMinutes: (() => {
        const value = num(row.avg_seat_delay);
        return value == null ? null : Math.round(value * 10) / 10;
      })(),
      revenueCents: revenue,
      checks,
      avgCheckCents: revenue != null && checks > 0 ? Math.round(revenue / checks) : null,
      ppaCents: revenue != null && moneyGuests > 0 ? Math.round(revenue / moneyGuests) : null,
      imported: parties > 0 && count(row.imported_parties) === parties,
    };
  });

  // ── Window totals ──────────────────────────────────────────────────
  const totals = summarise(rollup);
  const priorTotals = summarise(priorRollup);
  const serviceDays = new Set(rollup.map((r) => dateKeyOf(r.d))).size;
  const priorServiceDays = new Set(priorRollup.map((r) => dateKeyOf(r.d))).size;

  const revenueCents = moneyDays.length ? moneyDays.reduce((s, r) => s + count(r.revenue), 0) : null;
  const priorRevenueCents = priorMoneyDays.length ? priorMoneyDays.reduce((s, r) => s + count(r.revenue), 0) : null;
  const checksCount = moneyDays.reduce((s, r) => s + count(r.checks), 0);
  const moneyGuestCount = moneyDays.reduce((s, r) => s + count(r.guests), 0);
  const tipCents = moneyDays.reduce((s, r) => s + count(r.tips), 0);
  const subtotalCents = moneyDays.reduce((s, r) => s + count(r.subtotal), 0);

  const hasMoney = checksCount > 0;
  const moneyGap: { available: Availability; reason: string } = {
    available: "awaiting_pos",
    reason:
      count(bounds.closedChecks) > 0
        ? "No checks were closed inside this window."
        : "No checks have been closed in the POS yet. This fills in automatically once service runs on the POS.",
  };

  const thin = serviceDays > 0 && serviceDays < THIN_SAMPLE_DAYS;
  const thinNote = `Only ${serviceDays} service ${serviceDays === 1 ? "day" : "days"} of data in this window.`;
  const state = (ready: boolean): { available: Availability; reason?: string } =>
    !ready
      ? { available: "insufficient", reason: "No service history in this window." }
      : thin
        ? { available: "partial", reason: thinNote }
        : { available: "ready" };

  const metrics: Metric[] = [];

  // ── Volume & demand ────────────────────────────────────────────────
  metrics.push(metric("covers", "Covers served", "volume", "people", totals.covers || null, {
    ...state(totals.covers > 0),
    sampleSize: totals.parties,
    trend: trend(totals.covers, priorTotals.covers, basis, "up"),
    hint: serviceDays ? `${Math.round(totals.covers / serviceDays)} per service day` : undefined,
  }));
  metrics.push(metric("parties", "Parties seated", "volume", "count", totals.parties || null, {
    ...state(totals.parties > 0),
    trend: trend(totals.parties, priorTotals.parties, basis, "up"),
  }));
  metrics.push(metric("avg_party", "Average table size", "volume", "people", totals.avgParty, {
    ...state(totals.avgParty != null),
    sampleSize: totals.parties,
    trend: trend(totals.avgParty, priorTotals.avgParty, basis, "neutral"),
    hint: "Guests per seated party.",
  }));
  metrics.push(metric("service_days", "Service days", "volume", "count", serviceDays || null, {
    ...state(serviceDays > 0),
    trend: trend(serviceDays, priorServiceDays, basis, "neutral"),
  }));
  const walkInSharePct = totals.parties > 0 ? (totals.walkInParties / totals.parties) * 100 : null;
  metrics.push(metric("walk_in_share", "Walk-in share", "volume", "percent", walkInSharePct, {
    ...state(totals.parties > 0),
    trend: trend(walkInSharePct, priorTotals.parties > 0 ? (priorTotals.walkInParties / priorTotals.parties) * 100 : null, basis, "neutral"),
    hint: "Share of parties that arrived without a booking.",
  }));
  const peak = [...hourly].sort((a, b) => count(b.covers) - count(a.covers))[0];
  metrics.push(metric("peak_hour", "Peak hour", "volume", "text", peak && count(peak.covers) > 0 ? hourLabel(peak.bucket) : null, {
    ...state(Boolean(peak && count(peak.covers) > 0)),
    hint: peak ? `${count(peak.covers).toLocaleString("en-US")} covers seated in that hour across the window.` : undefined,
  }));
  const busiestDow = [...dow].sort((a, b) => count(b.covers) - count(a.covers))[0];
  metrics.push(metric("busiest_day", "Busiest day", "volume", "text", busiestDow && count(busiestDow.covers) > 0 ? dayName(busiestDow.bucket) : null, {
    ...state(Boolean(busiestDow && count(busiestDow.covers) > 0)),
  }));

  // ── Money ──────────────────────────────────────────────────────────
  const avgCheck = hasMoney ? Math.round((revenueCents ?? 0) / checksCount) : null;
  const priorAvgCheck = priorMoneyDays.length
    ? Math.round((priorRevenueCents ?? 0) / Math.max(1, priorMoneyDays.reduce((s, r) => s + count(r.checks), 0)))
    : null;
  metrics.push(metric("avg_check", "Average bill", "money", "cents", avgCheck, {
    ...(hasMoney ? state(true) : moneyGap),
    sampleSize: checksCount,
    trend: trend(avgCheck, priorAvgCheck, basis, "up"),
    hint: "Total per closed check, tip included.",
  }));
  const medianCheck = hasMoney ? median(moneyDays.map((r) => num(r.median_check))) : null;
  metrics.push(metric("median_check", "Median bill", "money", "cents", medianCheck, {
    ...(hasMoney ? state(true) : moneyGap),
    hint: "Half of bills land under this. Less swayed by one big party than the average.",
  }));
  const ppa = hasMoney && moneyGuestCount > 0 ? Math.round((revenueCents ?? 0) / moneyGuestCount) : null;
  metrics.push(metric("ppa", "Per-person average", "money", "cents", ppa, {
    ...(hasMoney ? state(true) : moneyGap),
    sampleSize: moneyGuestCount,
  }));
  metrics.push(metric("revenue", "Revenue", "money", "cents", hasMoney ? revenueCents : null, {
    ...(hasMoney ? state(true) : moneyGap),
    trend: trend(revenueCents, priorRevenueCents, basis, "up"),
    sampleSize: moneyDays.length,
    hint: moneyDays.length && revenueCents ? `${money(Math.round(revenueCents / moneyDays.length))} per day with POS revenue` : undefined,
  }));
  const tipPct = hasMoney && subtotalCents > 0 ? (tipCents / subtotalCents) * 100 : null;
  metrics.push(metric("tip_pct", "Tip rate", "money", "percent", tipPct, {
    ...(hasMoney ? state(true) : moneyGap),
    hint: "Tips as a share of pre-tax subtotal — a proxy for how service landed.",
  }));
  // Revenue-derived rates divide by the days that ACTUALLY had revenue,
  // not by every service day in the window. Dividing a month of POS
  // revenue across a 90-day window that predates the POS understates the
  // rate by a factor of three and makes the restaurant look unprofitable.
  const moneyDayCount = moneyDays.length;
  const rev = revPASH({
    revenueCents: hasMoney ? revenueCents : null,
    seats: ctx.seats,
    serviceHoursPerDay: ctx.serviceHoursPerDay,
    serviceDays: Math.max(1, moneyDayCount),
  });
  metrics.push(metric("revpash", "Revenue per seat hour", "money", "cents", rev != null ? Math.round(rev) : null, {
    ...(hasMoney ? state(true) : moneyGap),
    sampleSize: moneyDayCount,
    hint: `Across ${ctx.seats} seats and ${ctx.serviceHoursPerDay.toFixed(1)}h of service, over the ${moneyDayCount} ${moneyDayCount === 1 ? "day" : "days"} with POS revenue.`,
  }));

  // ── Throughput & pace ──────────────────────────────────────────────
  const turnMinutes = totals.turnMinutes;
  metrics.push(metric("turn_time", "Average table turn", "throughput", "minutes", turnMinutes, {
    ...state(turnMinutes != null),
    sampleSize: totals.turnSample,
    trend: trend(turnMinutes, priorTotals.turnMinutes, basis, "down"),
    reason: totals.turnOutliers > 0
      ? `${totals.turnOutliers} ${totals.turnOutliers === 1 ? "table" : "tables"} excluded as never-cleared (turn outside ${q.TURN_MIN_MINUTES}–${q.TURN_MAX_MINUTES} min).`
      : undefined,
    hint: "Seated to finished, median across parties.",
  }));
  const utilisation = seatUtilisationPct({
    covers: totals.covers, seats: ctx.seats,
    serviceHoursPerDay: ctx.serviceHoursPerDay,
    turnMinutes: turnMinutes ?? ctx.defaultTurnMinutes,
    serviceDays: Math.max(1, serviceDays),
  });
  metrics.push(metric("seat_utilisation", "Seat utilisation", "throughput", "percent", utilisation, {
    ...state(utilisation != null && totals.covers > 0),
    hint: "Covers served against what the room could physically seat at the observed turn time.",
  }));
  const seatDelay = weightedMean(rollup.map((r) => ({ value: num(r.avg_seat_delay), weight: count(r.parties) })));
  metrics.push(metric("seat_delay", "Seated vs booked time", "throughput", "minutes", seatDelay, {
    ...state(seatDelay != null),
    trend: trend(seatDelay, weightedMean(priorRollup.map((r) => ({ value: num(r.avg_seat_delay), weight: count(r.parties) }))), basis, "down"),
    hint: "Positive means parties waited past their booked time.",
  }));
  // These two come from TableSession, not from checks — name the right
  // source when they are missing, or an owner goes looking in the wrong
  // place for the fix.
  const paceGap: { available: Availability; reason: string } = {
    available: "awaiting_pos",
    reason: count(bounds.tableSessions) === 0
      ? "No table sessions recorded yet. These are written when the floor app seats a party and the POS settles its check."
      : "No table session in this window carries the timestamps this needs.",
  };
  const seatToOrder = num(pace.avg_seat_to_order);
  metrics.push(metric("seat_to_order", "Seated to first order", "throughput", "minutes", seatToOrder, {
    ...(seatToOrder != null ? state(true) : paceGap),
    sampleSize: count(pace.sessions),
    hint: "How long a table waits before anything is rung in.",
  }));
  const paidToClear = num(pace.avg_paid_to_clear);
  metrics.push(metric("paid_to_clear", "Paid to cleared", "throughput", "minutes", paidToClear, {
    ...(paidToClear != null ? state(true) : paceGap),
    hint: "Dead time between settling the check and the table being re-seatable.",
  }));
  const quoted = num(waitlist.avg_quoted);
  const actual = num(waitlist.avg_actual);
  metrics.push(metric("quote_accuracy", "Wait quote error", "throughput", "minutes",
    quoted != null && actual != null ? actual - quoted : null, {
    ...state(quoted != null && actual != null),
    sampleSize: count(waitlist.entries),
    hint: "Positive means guests waited longer than the host promised.",
  }));

  // ── Reliability ────────────────────────────────────────────────────
  const bookedParties = totals.parties - totals.walkInParties;
  const noShowPct = bookedParties + totals.noShows > 0 ? (totals.noShows / (bookedParties + totals.noShows)) * 100 : null;
  metrics.push(metric("no_show_rate", "No-show rate", "reliability", "percent", noShowPct, {
    ...state(totals.parties > 0),
    sampleSize: totals.noShows,
    trend: trend(noShowPct, priorTotals.parties > 0 ? (priorTotals.noShows / Math.max(1, priorTotals.parties - priorTotals.walkInParties + priorTotals.noShows)) * 100 : null, basis, "down"),
  }));
  const cancelPct = totals.parties + totals.cancellations > 0
    ? (totals.cancellations / (totals.parties + totals.cancellations)) * 100 : null;
  metrics.push(metric("cancellation_rate", "Cancellation rate", "reliability", "percent", cancelPct, {
    ...state(totals.parties > 0),
    sampleSize: totals.cancellations,
    trend: trend(cancelPct, priorTotals.parties + priorTotals.cancellations > 0
      ? (priorTotals.cancellations / (priorTotals.parties + priorTotals.cancellations)) * 100 : null, basis, "down"),
  }));
  const walkAwayPct = count(waitlist.entries) > 0 ? (count(waitlist.left) / count(waitlist.entries)) * 100 : null;
  metrics.push(metric("walk_away_rate", "Waitlist walk-aways", "reliability", "percent", walkAwayPct, {
    ...state(count(waitlist.entries) > 0),
    sampleSize: count(waitlist.entries),
    trend: trend(walkAwayPct, count(priorWaitlist.entries) > 0 ? (count(priorWaitlist.left) / count(priorWaitlist.entries)) * 100 : null, basis, "down"),
    hint: "Walk-ins who gave up before being seated — demand you had and lost.",
  }));
  const vipPct = totals.parties > 0 ? (totals.vipParties / totals.parties) * 100 : null;
  metrics.push(metric("vip_share", "VIP share", "reliability", "percent", vipPct, {
    ...state(totals.parties > 0),
  }));

  // ── Guests ─────────────────────────────────────────────────────────
  const totalGuests = count(guests.total_guests);
  const repeatPct = totalGuests > 0 ? (count(guests.repeat_guests) / totalGuests) * 100 : null;
  metrics.push(metric("repeat_rate", "Repeat-guest rate", "guests", "percent", repeatPct, {
    ...state(totalGuests > 0),
    sampleSize: totalGuests,
    hint: "Guests who came back more than once inside this window.",
  }));
  const repeatCovers = count(guests.repeat_covers);
  const newCovers = count(guests.new_covers);
  const repeatCoverPct = repeatCovers + newCovers > 0 ? (repeatCovers / (repeatCovers + newCovers)) * 100 : null;
  metrics.push(metric("repeat_covers", "Covers from returning guests", "guests", "percent", repeatCoverPct, {
    ...state(repeatCovers + newCovers > 0),
  }));

  // ── Forecast accuracy ──────────────────────────────────────────────
  const errors = forecast
    .filter((row) => row.predicted != null && row.actual != null && row.actual > 0)
    .map((row) => Math.abs((row.predicted as number) - (row.actual as number)) / (row.actual as number) * 100);
  const mape = errors.length ? mean(errors) : null;
  metrics.push(metric("forecast_error", "Forecast error", "forecast", "percent", mape, {
    ...(errors.length
      ? errors.length < 7 ? { available: "partial" as const, reason: `Only ${errors.length} forecast days to score.` } : { available: "ready" as const }
      : { available: "insufficient" as const, reason: "No published forecast overlaps a completed service day yet." }),
    sampleSize: errors.length,
    hint: "Average gap between predicted and actual covers. Lower is better.",
  }));

  // ── Menu mix ───────────────────────────────────────────────────────
  const menuMix = buildMenuMix(itemMix, neverSold, hasMoney, moneyGap.reason);

  // ── Series ─────────────────────────────────────────────────────────
  const monthlyCoverPoints: SeriesPoint[] = monthlyCovers.map((row) => ({
    key: row.month, label: monthLabel(row.month), value: count(row.covers), sample: count(row.parties),
  }));
  const monthlyRevenuePoints: SeriesPoint[] = monthlyRevenue.map((row) => ({
    key: row.month, label: monthLabel(row.month), value: count(row.revenue), sample: count(row.parties),
  }));

  const series = {
    monthlyCovers: monthlyCoverPoints,
    monthlyRevenue: monthlyRevenuePoints,
    dayOfWeek: Array.from({ length: 7 }, (_, i) => {
      const row = dow.find((r) => r.bucket === i);
      return { key: String(i), label: dayName(i), value: row ? count(row.covers) : 0, sample: row ? count(row.parties) : 0 };
    }),
    hourly: hourly
      .filter((row) => count(row.parties) > 0)
      .map((row) => ({ key: String(row.bucket), label: hourLabel(row.bucket), value: count(row.covers), sample: count(row.parties) })),
    partySize: partySize.map((row) => ({
      key: String(row.bucket),
      label: row.bucket >= 12 ? "12+" : String(row.bucket),
      value: count(row.parties),
      sample: count(row.covers),
    })),
    turnByPartySize: partySize
      .filter((row) => num(row.avg_turn) != null)
      .map((row) => ({
        key: String(row.bucket),
        label: row.bucket >= 12 ? "12+" : String(row.bucket),
        value: Math.round(num(row.avg_turn) as number),
        sample: count(row.parties),
      })),
    dailyCovers: dailyCovers.map((row) => ({
      key: dateKeyOf(row.d),
      label: dateKeyOf(row.d),
      value: count(row.covers),
      sample: count(row.parties),
    })),
    weekHeatmap: weekHeat.map((row) => ({ dow: row.dow, hour: row.hour, covers: count(row.covers) })),
    // The prior-year series is built below, once the month keys are known.
    monthlyCoversPriorYear: [] as SeriesPoint[],
  };

  // Year-over-year on ONE axis: the same measure, shifted twelve months,
  // so the two lines share a scale. Two y-axes would be a lie.
  const coverByMonth = new Map(monthlyCoverPoints.map((p) => [p.key, p.value]));
  series.monthlyCoversPriorYear = monthlyCoverPoints.map((point) => ({
    key: point.key,
    label: point.label,
    value: coverByMonth.get(priorYearMonth(point.key)) ?? null,
  }));

  // ── Growth ─────────────────────────────────────────────────────────
  const growth = buildGrowth(monthlyCoverPoints, monthlyRevenuePoints, now);

  // ── Coverage & gaps ────────────────────────────────────────────────
  const gaps: AnalysisResult["coverage"]["gaps"] = [];
  if (!hasMoney) {
    gaps.push({
      source: "POS checks",
      blocks: ["Average bill", "Median bill", "Per-person average", "Revenue", "Tip rate", "Revenue per seat hour", "Most and least sold items", "Revenue growth"],
      note: count(bounds.closedChecks) === 0
        ? "No check has been closed on the POS yet. These fill in on their own once a service runs through it — nothing to import."
        : "The POS has closed checks, but none inside this window. Widen the range.",
    });
  }
  if (count(bounds.tableSessions) === 0) {
    gaps.push({
      source: "Table sessions",
      blocks: ["Seated to first order", "Paid to cleared"],
      note: "Written when the floor app seats a party and the POS settles its check. Starts as soon as both run on the same service.",
    });
  }
  // A window whose data stops early makes every trend look like a
  // collapse. Say so, rather than letting the reader infer a crash.
  if (bounds.lastServiceDate) {
    const staleDays = Math.round((range.to.getTime() - bounds.lastServiceDate.getTime()) / 86_400_000);
    if (staleDays > 3) {
      gaps.push({
        source: "Recent service",
        blocks: ["Every trend and comparison in this window"],
        note: `Nothing has been recorded since ${dateKeyOf(bounds.lastServiceDate)} — ${staleDays} days ago. Declines shown here are the gap in the data, not necessarily a drop in business.`,
      });
    }
  }
  if (count(bounds.waitlistEntries) === 0) {
    gaps.push({
      source: "Waitlist",
      blocks: ["Wait quote error", "Waitlist walk-aways"],
      note: "Recorded when walk-ins are quoted through the floor app rather than a paper list.",
    });
  }

  return {
    range: { from: dateKeyOf(range.from), to: dateKeyOf(range.to), label: range.label, days: range.days },
    coverage: {
      firstServiceDate: bounds.firstServiceDate ? dateKeyOf(bounds.firstServiceDate) : null,
      lastServiceDate: bounds.lastServiceDate ? dateKeyOf(bounds.lastServiceDate) : null,
      serviceDays,
      reservations: count(bounds.reservations),
      importedReservations: count(bounds.importedReservations),
      closedChecks: count(bounds.closedChecks),
      tableSessions: count(bounds.tableSessions),
      gaps,
    },
    metrics,
    shifts,
    series,
    growth,
    menuMix,
    staff: servers.map((row) => ({
      serverId: row.serverId,
      name: row.name,
      shifts: count(row.shifts),
      covers: count(row.covers),
      parties: count(row.parties),
      avgTurnMinutes: num(row.avg_turn) != null ? Math.round(num(row.avg_turn) as number) : null,
      avgCheckCents: num(row.avg_check) != null ? Math.round(num(row.avg_check) as number) : null,
    })),
    generatedAt: now.toISOString(),
  };
}

// ── helpers ──────────────────────────────────────────────────────────

/** Mirrors lib/format.ts's money(): cents below $1,000, whole dollars
 *  above, thousands separated. Two formatters that disagree make one page
 *  look like two people built it. */
function money(cents: number) {
  const dollars = cents / 100;
  const showCents = Math.abs(dollars) < 1000;
  return dollars.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  });
}

function summarise(rows: q.ShiftRollupRow[]) {
  const covers = rows.reduce((s, r) => s + count(r.covers), 0);
  const parties = rows.reduce((s, r) => s + count(r.parties), 0);
  return {
    covers,
    parties,
    noShows: rows.reduce((s, r) => s + count(r.no_shows), 0),
    cancellations: rows.reduce((s, r) => s + count(r.cancellations), 0),
    walkInParties: rows.reduce((s, r) => s + count(r.walk_in_parties), 0),
    vipParties: rows.reduce((s, r) => s + count(r.vip_parties), 0),
    turnOutliers: rows.reduce((s, r) => s + count(r.turn_outliers), 0),
    // Weighted by parties, never a mean of daily means.
    avgParty: covers > 0 && parties > 0 ? covers / parties : null,
    turnMinutes: (() => {
      const value = weightedMean(rows.map((r) => ({ value: num(r.avg_turn), weight: count(r.parties) })));
      return value == null ? null : Math.round(value);
    })(),
    turnSample: rows.reduce((s, r) => s + count(r.parties), 0),
  };
}

function buildMenuMix(
  rows: q.ItemRow[],
  neverSold: Array<{ name: string; priceCents: number }>,
  hasMoney: boolean,
  reason: string,
): AnalysisResult["menuMix"] {
  if (!hasMoney || !rows.length) {
    return {
      available: "awaiting_pos",
      reason,
      top: [], bottom: [], neverSold: neverSold.slice(0, 20),
    };
  }
  const totalQuantity = rows.reduce((s, r) => s + count(r.quantity), 0);
  const medianPrice = median(rows.map((r) => num(r.price))) ?? 0;
  const mapped: MenuMixRow[] = rows.map((r) => {
    const quantity = count(r.quantity);
    return {
      name: r.name,
      quantity,
      revenueCents: count(r.revenue),
      priceCents: Math.round(num(r.price) ?? 0),
      sharePct: totalQuantity > 0 ? (quantity / totalQuantity) * 100 : 0,
      quadrant: quadrantFor({
        quantity, totalQuantity, itemCount: rows.length,
        priceCents: num(r.price) ?? 0, medianPriceCents: medianPrice,
      }),
    };
  });
  const sorted = [...mapped].sort((a, b) => b.quantity - a.quantity);
  // A short menu would otherwise print the same dish as both the best
  // and the worst seller. Split the list rather than slicing both ends.
  const half = Math.floor(sorted.length / 2);
  const top = sorted.slice(0, Math.min(10, half || sorted.length));
  const bottom = sorted.slice(Math.max(top.length, sorted.length - 10)).reverse();
  return {
    available: rows.length < 5 ? "partial" : "ready",
    reason: rows.length < 5 ? `Only ${rows.length} distinct items sold in this window.` : undefined,
    top,
    bottom,
    neverSold: neverSold.slice(0, 20),
  };
}

function buildGrowth(
  coverPoints: SeriesPoint[],
  revenuePoints: SeriesPoint[],
  now: Date,
): AnalysisResult["growth"] {
  const covers = new Map(coverPoints.map((p) => [p.key, p.value ?? 0]));
  const revenue = new Map(revenuePoints.map((p) => [p.key, p.value ?? 0]));
  const months = [...new Set([...covers.keys(), ...revenue.keys()])].sort();

  // Growth is measured from the last COMPLETE month. Comparing a month
  // that is four days old against a full one reads as a collapse.
  const complete = months.filter((m) => monthIsComplete(m, now));
  const latest = complete[complete.length - 1] ?? null;

  const coversMoM = latest ? pctChange(covers.get(latest) ?? null, covers.get(priorMonth(latest)) ?? null) : null;
  const coversYoY = latest ? pctChange(covers.get(latest) ?? null, covers.get(priorYearMonth(latest)) ?? null) : null;
  const revenueMoM = latest ? pctChange(revenue.get(latest) ?? null, revenue.get(priorMonth(latest)) ?? null) : null;
  const revenueYoY = latest ? pctChange(revenue.get(latest) ?? null, revenue.get(priorYearMonth(latest)) ?? null) : null;

  const monthTable = months
    .slice(-24)
    .reverse()
    .map((month) => {
      const priorKey = priorYearMonth(month);
      const coversNow = covers.get(month) ?? 0;
      const coversPrior = covers.has(priorKey) ? covers.get(priorKey) ?? 0 : null;
      const revenueNow = revenue.has(month) ? revenue.get(month) ?? 0 : null;
      const revenuePrior = revenue.has(priorKey) ? revenue.get(priorKey) ?? 0 : null;
      return {
        month,
        label: monthLabel(month),
        complete: monthIsComplete(month, now),
        covers: coversNow,
        coversPrior,
        coversDeltaPct: pctChange(coversNow, coversPrior),
        revenueCents: revenueNow,
        revenuePriorCents: revenuePrior,
        revenueDeltaPct: pctChange(revenueNow, revenuePrior),
      };
    });

  return { coversMoM, coversYoY, revenueMoM, revenueYoY, monthTable };
}
