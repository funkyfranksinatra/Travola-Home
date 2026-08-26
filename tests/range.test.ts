// tests/range.test.ts — the window the analysis tab computes over.
//
// Ranges anchor to TODAY, not to the last day with data. That is
// deliberate: a restaurant whose bookings stopped three weeks ago should
// see an empty three weeks, not a window that quietly slides back to hide
// them. The staleness banner in analysis.ts is what explains it.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveRange } from "../lib/analytics/analysis.ts";
import { dateKeyOf } from "../lib/analytics/math.ts";

const bounds = {
  firstServiceDate: new Date(Date.UTC(2025, 0, 1)),
  lastServiceDate: new Date(Date.UTC(2026, 7, 3)),
};
const today = new Date(Date.UTC(2026, 7, 26, 14, 30));

test("preset ranges end today and are inclusive of both ends", () => {
  const thirty = resolveRange("30d", bounds, today);
  assert.equal(dateKeyOf(thirty.to), "2026-08-26");
  assert.equal(dateKeyOf(thirty.from), "2026-07-28", "30 days inclusive, not 31");
  assert.equal(thirty.days, 30);

  const ninety = resolveRange("90d", bounds, today);
  assert.equal(dateKeyOf(ninety.from), "2026-05-29");
  assert.equal(ninety.days, 90);

  const year = resolveRange("365d", bounds, today);
  assert.equal(dateKeyOf(year.from), "2025-08-27");
});

test("a preset range strips the time of day so it is a clean service date", () => {
  const range = resolveRange("30d", bounds, today);
  assert.equal(range.to.toISOString(), "2026-08-26T00:00:00.000Z");
});

test("all-time starts at the first record and still runs to today", () => {
  const range = resolveRange("all", bounds, today);
  assert.equal(dateKeyOf(range.from), "2025-01-01");
  assert.equal(dateKeyOf(range.to), "2026-08-26");
  assert.equal(range.label, "All time");
  assert.ok(range.days > 600);
});

test("a restaurant with no history at all still gets a usable window", () => {
  const range = resolveRange("all", { firstServiceDate: null, lastServiceDate: null }, today);
  assert.ok(range.from instanceof Date && range.to instanceof Date);
  assert.ok(range.days >= 1, "never zero or negative days, which would divide by zero downstream");
});

test("custom ranges are honoured, and fall back when half-specified", () => {
  const custom = resolveRange("custom", bounds, today, { from: "2025-03-01", to: "2025-03-31" });
  assert.equal(dateKeyOf(custom.from), "2025-03-01");
  assert.equal(dateKeyOf(custom.to), "2025-03-31");
  assert.equal(custom.days, 31);

  // Missing an end: fall back to the 90-day preset rather than computing
  // a window against undefined.
  const partial = resolveRange("custom", bounds, today, { from: "2025-03-01" });
  assert.equal(partial.days, 90);
});

test("a single-day custom range counts as one day, not zero", () => {
  const single = resolveRange("custom", bounds, today, { from: "2026-02-14", to: "2026-02-14" });
  assert.equal(single.days, 1);
});
