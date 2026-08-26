// lib/billing/index.ts — provider selection.
//
// One env var decides. Adding Stripe later means adding a `stripe.ts` that
// satisfies BillingProvider and one more branch here; nothing above this
// line changes.
import { stubBilling } from "./stub";
import type { BillingProvider } from "./provider";

export function billing(): BillingProvider {
  switch ((process.env.BILLING_PROVIDER ?? "stub").toLowerCase()) {
    case "stub":
    default:
      return stubBilling;
  }
}

export * from "./plans";
export type { BillingProvider, InvoiceView, SubscriptionView } from "./provider";
