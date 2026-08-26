// tests/payouts.test.ts — the deposit rules, without a Stripe account.
//
// Every case here is one an owner hits in the settings form, or one
// Stripe would reject with a developer-facing error if we let it
// through. Both are worth catching locally.
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  DEFAULT_PREFS,
  describeSchedule,
  describeStatus,
  statusFrom,
  stripeSettingsFrom,
  validateDescriptor,
  validateEmail,
  validatePrefs,
  type PayoutPrefs,
} from "../lib/payouts";

const prefs = (over: Partial<PayoutPrefs> = {}): PayoutPrefs => ({ ...DEFAULT_PREFS, ...over });

// ── statement descriptor ─────────────────────────────────────────

test("a descriptor under five characters is rejected", () => {
  assert.ok(validateDescriptor("AB"));
});

test("a descriptor over twenty-two characters is rejected", () => {
  assert.ok(validateDescriptor("A".repeat(23)));
});

test("a descriptor at the boundaries is accepted", () => {
  assert.equal(validateDescriptor("ABCDE"), null);
  assert.equal(validateDescriptor("A".repeat(22)), null);
});

test("the characters Stripe bans are rejected", () => {
  for (const bad of ['VOLARIO"S', "VOLARIO'S BAR", "VOLARIOS <BAR>", "VOLARIOS*BAR", "VOLARIOS\\BAR"]) {
    assert.ok(validateDescriptor(bad), `${bad} should be rejected`);
  }
});

test("a descriptor of only digits is rejected — a guest cannot recognise it", () => {
  assert.ok(validateDescriptor("1234567"));
});

test("surrounding whitespace does not count toward the length", () => {
  assert.equal(validateDescriptor("   VOLARIOS   "), null);
});

// ── email ────────────────────────────────────────────────────────

test("an obvious typo is caught, a real address is not", () => {
  assert.ok(validateEmail("nope"));
  assert.ok(validateEmail("owner@localhost"));
  assert.equal(validateEmail("owner@volarios.com"), null);
});

// ── anchors and delay ────────────────────────────────────────────

test("a weekly anchor outside 0-6 is rejected", () => {
  assert.equal(validatePrefs({ payoutWeeklyAnchor: 7 }).length, 1);
  assert.equal(validatePrefs({ payoutWeeklyAnchor: -1 }).length, 1);
  assert.equal(validatePrefs({ payoutWeeklyAnchor: 0 }).length, 0);
  assert.equal(validatePrefs({ payoutWeeklyAnchor: 6 }).length, 0);
});

test("a monthly anchor outside 1-31 is rejected", () => {
  assert.equal(validatePrefs({ payoutMonthlyAnchor: 0 }).length, 1);
  assert.equal(validatePrefs({ payoutMonthlyAnchor: 32 }).length, 1);
  assert.equal(validatePrefs({ payoutMonthlyAnchor: 31 }).length, 0);
});

test("null delay means Stripe's minimum and is allowed", () => {
  assert.equal(validatePrefs({ payoutDelayDays: null }).length, 0);
});

test("a negative or absurd delay is rejected", () => {
  assert.equal(validatePrefs({ payoutDelayDays: -1 }).length, 1);
  assert.equal(validatePrefs({ payoutDelayDays: 31 }).length, 1);
  assert.equal(validatePrefs({ payoutDelayDays: 0 }).length, 0);
});

test("every problem is reported at once, not one at a time", () => {
  const problems = validatePrefs({
    payoutMonthlyAnchor: 99,
    payoutDelayDays: -5,
    statementDescriptor: "X",
    payoutNotifyEmail: "nope",
  });
  assert.equal(problems.length, 4);
});

test("an unknown interval or tip option is rejected", () => {
  assert.equal(validatePrefs({ payoutInterval: "fortnightly" as never }).length, 1);
  assert.equal(validatePrefs({ tipHandling: "crypto" as never }).length, 1);
});

// ── mapping to Stripe ────────────────────────────────────────────

test("a manual schedule never carries delay_days — Stripe rejects the pair", () => {
  const settings = stripeSettingsFrom(prefs({ payoutInterval: "manual", payoutDelayDays: 4 })) as {
    payouts: { schedule: Record<string, unknown> };
  };
  assert.equal(settings.payouts.schedule.interval, "manual");
  assert.ok(!("delay_days" in settings.payouts.schedule));
});

test("a null delay is sent as the literal 'minimum', not as 0", () => {
  const settings = stripeSettingsFrom(prefs({ payoutDelayDays: null })) as {
    payouts: { schedule: Record<string, unknown> };
  };
  assert.equal(settings.payouts.schedule.delay_days, "minimum");
});

test("a zero delay is sent as 0 and not confused with minimum", () => {
  const settings = stripeSettingsFrom(prefs({ payoutDelayDays: 0 })) as {
    payouts: { schedule: Record<string, unknown> };
  };
  assert.equal(settings.payouts.schedule.delay_days, 0);
});

test("weekly anchors map onto Stripe's day names", () => {
  const settings = stripeSettingsFrom(prefs({ payoutInterval: "weekly", payoutWeeklyAnchor: 0 })) as {
    payouts: { schedule: Record<string, unknown> };
  };
  assert.equal(settings.payouts.schedule.weekly_anchor, "sunday");
});

test("an empty descriptor is omitted rather than sent as a blank string", () => {
  const settings = stripeSettingsFrom(prefs({ statementDescriptor: null })) as Record<string, unknown>;
  assert.ok(!("payments" in settings));
});

// ── status derivation ────────────────────────────────────────────

test("payouts and charges both enabled is the only route to active", () => {
  assert.equal(statusFrom({ payouts_enabled: true, charges_enabled: true, details_submitted: true }), "active");
  assert.equal(statusFrom({ payouts_enabled: false, charges_enabled: true, details_submitted: true }), "restricted");
  assert.equal(statusFrom({ payouts_enabled: true, charges_enabled: false, details_submitted: true }), "restricted");
});

test("details not yet submitted reads as onboarding, not restricted", () => {
  assert.equal(statusFrom({ details_submitted: false }), "onboarding");
});

test("a rejected account is disabled even if a flag says otherwise", () => {
  assert.equal(
    statusFrom({
      payouts_enabled: true,
      charges_enabled: true,
      details_submitted: true,
      requirements: { disabled_reason: "rejected.fraud" },
    }),
    "disabled",
  );
});

// ── the sentence an owner reads ──────────────────────────────────

test("the schedule sentence names the day for a weekly schedule", () => {
  assert.match(describeSchedule(prefs({ payoutInterval: "weekly", payoutWeeklyAnchor: 2 })), /Tuesday/);
});

test("a monthly anchor past 28 warns about short months", () => {
  assert.match(describeSchedule(prefs({ payoutInterval: "monthly", payoutMonthlyAnchor: 31 })), /last day/);
  assert.doesNotMatch(describeSchedule(prefs({ payoutInterval: "monthly", payoutMonthlyAnchor: 15 })), /last day/);
});

test("a manual schedule says plainly that nothing is sent", () => {
  assert.match(describeSchedule(prefs({ payoutInterval: "manual" })), /Nothing is sent automatically/);
});

test("one day is singular", () => {
  assert.match(describeSchedule(prefs({ payoutDelayDays: 1 })), /1 day after/);
  assert.match(describeSchedule(prefs({ payoutDelayDays: 2 })), /2 days after/);
});

test("not connected says money has nowhere to go, not that all is well", () => {
  const line = describeStatus({
    status: "not_started",
    payoutsEnabled: false,
    chargesEnabled: false,
    detailsSubmitted: false,
  });
  assert.match(line, /nowhere to be deposited/);
});
