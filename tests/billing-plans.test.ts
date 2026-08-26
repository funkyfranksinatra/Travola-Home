// tests/billing-plans.test.ts — pricing that must not drift.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PLANS, PLAN_BY_KEY, isPlanKey, priceCents } from "../lib/billing/plans.ts";

test("yearly is exactly ten months on every plan", () => {
  for (const plan of PLANS) {
    assert.equal(
      plan.yearlyCents,
      plan.monthlyCents * 10,
      `${plan.name} yearly price drifted from the "two months free" promise`,
    );
  }
});

test("plans are ordered by price and every key resolves", () => {
  const prices = PLANS.map((plan) => plan.monthlyCents);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b), "plans must read cheapest first");
  for (const plan of PLANS) {
    assert.ok(isPlanKey(plan.key));
    assert.equal(PLAN_BY_KEY[plan.key].name, plan.name);
    assert.ok(plan.features.length > 0, `${plan.name} has nothing to sell`);
  }
});

test("prices are whole cents, never floats", () => {
  for (const plan of PLANS) {
    assert.equal(plan.monthlyCents % 1, 0);
    assert.equal(plan.yearlyCents % 1, 0);
  }
});

test("unknown plan keys are rejected rather than defaulted", () => {
  assert.equal(isPlanKey("platinum"), false);
  assert.equal(isPlanKey(null), false);
  assert.equal(isPlanKey(undefined), false);
  assert.equal(isPlanKey(""), false);
});

test("priceCents picks the right column for the interval", () => {
  assert.equal(priceCents("standard", "month"), PLAN_BY_KEY.standard.monthlyCents);
  assert.equal(priceCents("standard", "year"), PLAN_BY_KEY.standard.yearlyCents);
});
