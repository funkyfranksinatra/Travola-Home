// lib/stripe.ts — the Stripe client, constructed lazily and never eagerly.
//
// Same discipline as lib/prisma.ts, for the same reason: a module that
// throws at import time takes the whole route graph down with it, and a
// deployment without a Stripe key must still render every page. Nothing
// here touches the network until a route actually asks it to.
//
// Travola runs Stripe Connect **Express**. The restaurant gets its own
// Stripe account, completes Stripe's KYC on Stripe's pages, and money
// moves card → restaurant bank without passing through a Travola-owned
// balance. That is the whole reason this file is small: the hard parts
// (identity verification, bank validation, payout mechanics, the dispute
// flow) are Stripe's problem by design, not ours.
import Stripe from "stripe";

/** Pinned. An unpinned API version means Stripe can change the shape of
 *  a response under a deployment that has not been touched in months. */
export const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

let client: Stripe | null = null;

export function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

/** True when the configured key is a test-mode key. Surfaced in the UI —
 *  an owner must never be able to mistake a sandbox connection for one
 *  that will actually pay them. */
export function stripeTestMode() {
  return (process.env.STRIPE_SECRET_KEY ?? "").trim().startsWith("sk_test_");
}

export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    const error = new Error(
      "STRIPE_SECRET_KEY is not set, so this deployment cannot reach Stripe.",
    );
    error.name = "StripeNotConfiguredError";
    throw error;
  }
  if (!client) {
    client = new Stripe(key, {
      apiVersion: STRIPE_API_VERSION,
      // Named so a Travola call is identifiable in the Stripe dashboard's
      // request log, which is the first place anyone looks in an incident.
      appInfo: { name: "Travola Home", url: "https://travola.app" },
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }
  return client;
}

export function isStripeNotConfigured(error: unknown) {
  return error instanceof Error && error.name === "StripeNotConfiguredError";
}

/**
 * Turn a Stripe error into something an owner can act on.
 *
 * Stripe's raw messages are written for developers ("No such account:
 * acct_1234"), and pasting one into a settings page is how a restaurant
 * owner ends up phoning you at nine on a Friday. Anything we do not
 * recognise gets a generic line and the real text goes to the log.
 */
export function stripeMessage(error: unknown): string {
  if (isStripeNotConfigured(error)) {
    return "Stripe is not connected to this deployment yet, so deposits cannot be set up.";
  }
  const raw = error as { type?: string; code?: string; message?: string };
  switch (raw?.code) {
    case "account_invalid":
      return "Stripe no longer recognises this account. Disconnect and set it up again.";
    case "rate_limit":
      return "Stripe is rate-limiting us. Wait a few seconds and try again.";
    default:
      break;
  }
  switch (raw?.type) {
    case "StripeAuthenticationError":
      return "Stripe rejected our API key. This is a Travola configuration problem, not something you can fix here.";
    case "StripeConnectionError":
      return "Could not reach Stripe. Nothing was changed — try again in a moment.";
    case "StripeInvalidRequestError":
      // These ARE usually the owner's input (a bad statement descriptor,
      // an anchor out of range), so the message is worth showing.
      return raw.message ?? "Stripe rejected that change.";
    default:
      console.error("[stripe]", error);
      return "Something went wrong talking to Stripe. Nothing was changed.";
  }
}
