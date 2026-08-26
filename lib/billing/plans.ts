// lib/billing/plans.ts — the plan catalogue.
//
// Kept as data, in one file, so the pricing page, the change-plan flow and
// the invoice description all read from the same source. Annual is priced
// at ten months, which is the convention every operator already recognises
// from OpenTable and Toast — two months free, stated plainly rather than
// as a percentage they have to work out.
export type PlanKey = "starter" | "standard" | "pro";

export type Plan = {
  key: PlanKey;
  name: string;
  blurb: string;
  monthlyCents: number;
  /** Ten months, billed once. */
  yearlyCents: number;
  features: string[];
  /** Shown struck through on plans the restaurant has outgrown. */
  limits: string[];
};

export const PLANS: Plan[] = [
  {
    key: "starter",
    name: "Starter",
    blurb: "The floor manager and the POS, for a single room finding its feet.",
    monthlyCents: 9900,
    yearlyCents: 99000,
    features: [
      "Floor manager: layout, reservations, waitlist",
      "POS: orders, kitchen display, checks",
      "One POS terminal",
      "90 days of history in the analysis tab",
      "Email support",
    ],
    limits: ["No AI shift intelligence", "No weekly forecasts"],
  },
  {
    key: "standard",
    name: "Standard",
    blurb: "Adds the shift intelligence layer — the reason most rooms move up.",
    monthlyCents: 24900,
    yearlyCents: 249000,
    features: [
      "Everything in Starter",
      "AI shift intelligence: cover forecasts, section planning",
      "Unlimited POS terminals",
      "Full history in the analysis tab, including imported data",
      "Menu importer (PDF and photo)",
      "Data export",
    ],
    limits: ["No weekly external research forecasts"],
  },
  {
    key: "pro",
    name: "Pro",
    blurb: "For multi-floor rooms that plan the week, not the night.",
    monthlyCents: 44900,
    yearlyCents: 449000,
    features: [
      "Everything in Standard",
      "Weekly research forecasts: weather, local events, seasonality",
      "Forecast accuracy scoring and auto-correction",
      "Multiple floors and service periods",
      "Priority support",
    ],
    limits: [],
  },
];

export const PLAN_BY_KEY: Record<PlanKey, Plan> = Object.fromEntries(
  PLANS.map((plan) => [plan.key, plan]),
) as Record<PlanKey, Plan>;

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && value in PLAN_BY_KEY;
}

export function priceCents(plan: PlanKey, interval: "month" | "year") {
  const row = PLAN_BY_KEY[plan];
  return interval === "year" ? row.yearlyCents : row.monthlyCents;
}
