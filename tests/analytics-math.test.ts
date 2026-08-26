// tests/analytics-math.test.ts — the arithmetic a dashboard lies with.
//
// Each case here is a specific way a metric can be confidently wrong,
// several of them found by running the engine against a production-shaped
// fixture rather than by imagining inputs.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  addDays, count, dateKeyOf, dayName, hourLabel, mean, median, monthIsComplete, monthLabel,
  num, pctChange, periodForHour, priorMonth, priorYearMonth, quadrantFor, revPASH,
  seatUtilisationPct, serviceDateOf, weightedMean,
} from "../lib/analytics/math.ts";

test("percent change refuses a zero base rather than inventing infinity", () => {
  assert.equal(pctChange(40, 0), null, "0 -> 40 has no percentage");
  assert.equal(pctChange(0, 0), null);
  assert.equal(pctChange(120, 100), 20);
  assert.equal(pctChange(80, 100), -20);
  assert.equal(pctChange(null, 100), null);
  assert.equal(pctChange(100, null), null);
  assert.equal(pctChange(Number.NaN, 100), null);
});

test("percent change against a negative base uses magnitude", () => {
  // Only reachable for a signed metric (seated-vs-booked minutes can be
  // negative when a room seats early). Without Math.abs the sign flips.
  assert.equal(pctChange(-5, -10), 50);
});

test("mean and median ignore nulls and disagree where it matters", () => {
  assert.equal(mean([]), null);
  assert.equal(median([]), null);
  assert.equal(mean([10, null, 20, undefined]), 15);
  // The case that motivates using median for turn time: one table that
  // sat for eleven hours.
  assert.equal(mean([90, 90, 90, 660]), 232.5);
  assert.equal(median([90, 90, 90, 660]), 90);
});

test("weighted mean does not let a quiet Tuesday outvote a full Saturday", () => {
  // Naive averaging of daily averages gives 105; weighted gives ~92.
  const rows = [
    { value: 200, weight: 2 },   // Tuesday: two parties, freak long turn
    { value: 90, weight: 200 },  // Saturday: two hundred parties
  ];
  const value = weightedMean(rows) as number;
  assert.ok(value > 89 && value < 92, `expected ~91, got ${value}`);
  assert.equal(weightedMean([{ value: 10, weight: 0 }]), null, "zero weight is not a data point");
  assert.equal(weightedMean([{ value: null, weight: 5 }]), null);
});

test("service periods follow the ShiftPeriod enum boundaries", () => {
  assert.equal(periodForHour(9), "BRUNCH");
  assert.equal(periodForHour(10), "BRUNCH");
  assert.equal(periodForHour(11), "LUNCH");
  assert.equal(periodForHour(15), "LUNCH");
  assert.equal(periodForHour(16), "DINNER");
  assert.equal(periodForHour(23), "DINNER");
});

test("menu quadrants use the 70%-of-fair-share cutoff, not the mean", () => {
  // Ten items, 1000 sold: fair share is 100, cutoff is 70.
  const base = { totalQuantity: 1000, itemCount: 10, medianPriceCents: 2000 };
  assert.equal(quadrantFor({ ...base, quantity: 200, priceCents: 3000 }), "star");
  assert.equal(quadrantFor({ ...base, quantity: 200, priceCents: 1200 }), "plowhorse");
  assert.equal(quadrantFor({ ...base, quantity: 20, priceCents: 3000 }), "puzzle");
  assert.equal(quadrantFor({ ...base, quantity: 20, priceCents: 1200 }), "dog");
  // Exactly at the cutoff counts as popular.
  assert.equal(quadrantFor({ ...base, quantity: 70, priceCents: 3000 }), "star");
  assert.equal(quadrantFor({ ...base, quantity: 69, priceCents: 3000 }), "puzzle");
  // Price exactly at the median counts as the higher band, so a menu
  // where every dish costs the same is not labelled entirely "dog".
  assert.equal(quadrantFor({ ...base, quantity: 200, priceCents: 2000 }), "star");
});

test("quadrants do not divide by zero on an empty menu", () => {
  assert.equal(
    quadrantFor({ quantity: 0, totalQuantity: 0, itemCount: 0, priceCents: 0, medianPriceCents: 0 }),
    "dog",
  );
});

test("RevPASH divides by seat hours and refuses an empty room", () => {
  // $10,000 over 100 seats x 5 hours x 2 days = 1000 seat hours = $10.
  assert.equal(revPASH({ revenueCents: 1_000_000, seats: 100, serviceHoursPerDay: 5, serviceDays: 2 }), 1000);
  assert.equal(revPASH({ revenueCents: 1000, seats: 0, serviceHoursPerDay: 5, serviceDays: 2 }), null);
  assert.equal(revPASH({ revenueCents: null, seats: 100, serviceHoursPerDay: 5, serviceDays: 2 }), null);
});

test("seat utilisation is covers against physical capacity", () => {
  // 100 seats, 5h, 90-minute turns => 3.33 turns => 333 covers/day.
  const value = seatUtilisationPct({
    covers: 333, seats: 100, serviceHoursPerDay: 5, turnMinutes: 90, serviceDays: 1,
  }) as number;
  assert.ok(value > 99 && value < 101, `expected ~100%, got ${value}`);
  assert.equal(seatUtilisationPct({ covers: 10, seats: 10, serviceHoursPerDay: 5, turnMinutes: 0, serviceDays: 1 }), null);
  assert.equal(seatUtilisationPct({ covers: 10, seats: 0, serviceHoursPerDay: 5, turnMinutes: 90, serviceDays: 1 }), null);
});

test("a month in progress is never treated as complete", () => {
  const midAugust = new Date(Date.UTC(2026, 7, 12));
  assert.equal(monthIsComplete("2026-08", midAugust), false, "the current month is partial");
  assert.equal(monthIsComplete("2026-07", midAugust), true);
  assert.equal(monthIsComplete("2025-01", midAugust), true);
  // The last day of the month IS complete.
  assert.equal(monthIsComplete("2026-08", new Date(Date.UTC(2026, 7, 31))), true);
  assert.equal(monthIsComplete("2026-08", new Date(Date.UTC(2026, 7, 30))), false);
  // February in a leap year: 29 days, not 28.
  assert.equal(monthIsComplete("2024-02", new Date(Date.UTC(2024, 1, 28))), false);
  assert.equal(monthIsComplete("2024-02", new Date(Date.UTC(2024, 1, 29))), true);
});

test("month arithmetic crosses year boundaries", () => {
  assert.equal(priorMonth("2026-01"), "2025-12");
  assert.equal(priorMonth("2026-12"), "2026-11");
  assert.equal(priorYearMonth("2026-01"), "2025-01");
  assert.equal(priorYearMonth("2026-12"), "2025-12");
  assert.equal(monthLabel("2026-08"), "Aug 2026");
});

test("service dates stay on UTC midnight regardless of host timezone", () => {
  const date = serviceDateOf("2026-08-03");
  assert.equal(date.toISOString(), "2026-08-03T00:00:00.000Z");
  assert.equal(dateKeyOf(date), "2026-08-03");
  assert.equal(dateKeyOf(addDays(date, -1)), "2026-08-02");
  assert.equal(dateKeyOf(addDays(date, 30)), "2026-09-02");
  // Across a DST boundary in the restaurant's zone the UTC key must not
  // slip a day — this is why the arithmetic is in UTC, not local.
  assert.equal(dateKeyOf(addDays(serviceDateOf("2026-03-07"), 1)), "2026-03-08");
});

test("hour and day labels read like a person wrote them", () => {
  assert.equal(hourLabel(0), "12 am");
  assert.equal(hourLabel(11), "11 am");
  assert.equal(hourLabel(12), "12 pm");
  assert.equal(hourLabel(18), "6 pm");
  assert.equal(dayName(0), "Sunday");
  assert.equal(dayName(6), "Saturday");
});

test("Postgres bigint and numeric strings become numbers, junk becomes null", () => {
  assert.equal(num(42n), 42);
  assert.equal(num("3.5"), 3.5);
  assert.equal(num(null), null);
  assert.equal(num("not a number"), null);
  assert.equal(num(Number.NaN), null);
  // count() is for tallies, where absent means zero rather than unknown.
  assert.equal(count(null), 0);
  assert.equal(count(7n), 7);
});
