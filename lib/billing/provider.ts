// lib/billing/provider.ts — one seam between Travola Home and money.
//
// There is no payment processor connected yet, and pretending otherwise
// would either block this whole page on a Stripe account or bake Stripe's
// shapes into every component. Instead Travola Home talks to this
// interface, and a `stub` implementation keeps the full subscription
// lifecycle in our own database.
//
// The stub is not a mock: it is the real state machine. Plans change,
// cancellations schedule for period end, invoices are issued and listed —
// all of it durable, all of it audit-logged. When a processor is wired up,
// its adapter satisfies this same interface, the stored Subscription row
// gains provider ids, and NO component changes. That is the least costly
// path to a billing page that works today and is not thrown away later.
import type { PlanKey } from "./plans";

export type SubscriptionView = {
  plan: PlanKey;
  planName: string;
  status: "trialing" | "active" | "past_due" | "canceled" | "paused";
  interval: "month" | "year";
  priceCents: number;
  currency: string;
  seats: number;
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  cancelReason: string | null;
  provider: string;
  /** True when no processor is connected and nothing is actually charged. */
  simulated: boolean;
  billingContact: {
    name?: string; email?: string; phone?: string;
    line1?: string; line2?: string; city?: string; region?: string; postal?: string; country?: string;
  } | null;
};

export type InvoiceView = {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  paidAt: string | null;
  description: string;
  hostedUrl: string | null;
  pdfUrl: string | null;
};

export interface BillingProvider {
  readonly key: string;
  /** Never throws for a restaurant with no subscription — it creates the trial. */
  getSubscription(restaurantId: string): Promise<SubscriptionView>;
  listInvoices(restaurantId: string, limit?: number): Promise<InvoiceView[]>;
  changePlan(restaurantId: string, plan: PlanKey, interval: "month" | "year"): Promise<SubscriptionView>;
  cancel(restaurantId: string, opts: { reason?: string; immediate?: boolean }): Promise<SubscriptionView>;
  resume(restaurantId: string): Promise<SubscriptionView>;
  updateContact(restaurantId: string, contact: SubscriptionView["billingContact"]): Promise<SubscriptionView>;
}
