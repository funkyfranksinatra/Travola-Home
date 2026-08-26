// app/api/webhooks/stripe/route.ts — Stripe telling us what changed.
//
// Verification is not instant and it is not one-shot: an Express account
// can go from onboarding to active hours later, and from active back to
// restricted months later when Stripe asks for a renewed document. If
// the only way our cache updates is an owner opening the settings page,
// then the day their payouts get paused is a day they find out by
// noticing no money arrived.
//
// Two rules this file exists to obey:
//
//   1. VERIFY THE SIGNATURE against the raw body. An unverified webhook
//      endpoint is an unauthenticated write endpoint that anyone on the
//      internet can post to. Without STRIPE_WEBHOOK_SECRET set we reject
//      everything rather than trusting the payload.
//   2. ALWAYS RETURN 200 once verified, even when our own handling
//      fails. Stripe retries non-2xx for days; a bug on our side that
//      returns 500 turns into a retry storm that outlives the bug.
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { statusFrom } from "@/lib/payouts";

export const dynamic = "force-dynamic";

/** Events worth acting on. Everything else is acknowledged and dropped —
 *  an endpoint subscribed to the firehose does more parsing than work. */
const HANDLED = new Set(["account.updated", "account.application.deauthorized"]);

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  const signature = request.headers.get("stripe-signature");

  if (!stripeConfigured() || !secret) {
    // Not "ok". A deployment that cannot verify must not pretend it
    // processed anything, or a misconfiguration looks like success in
    // the Stripe dashboard forever.
    return NextResponse.json({ error: "Webhooks are not configured on this deployment." }, { status: 503 });
  }
  if (!signature) {
    return NextResponse.json({ error: "Missing signature." }, { status: 400 });
  }

  // The RAW body, before any JSON parsing — the signature is over these
  // exact bytes and re-serialising breaks it.
  const payload = await request.text();

  let event;
  try {
    event = stripe().webhooks.constructEvent(payload, signature, secret);
  } catch (error) {
    console.warn("[stripe-webhook] signature rejected:", (error as Error)?.message);
    return NextResponse.json({ error: "Signature verification failed." }, { status: 400 });
  }

  if (!HANDLED.has(event.type)) {
    return NextResponse.json({ received: true, ignored: event.type });
  }

  try {
    if (event.type === "account.updated") {
      const account = event.data.object as {
        id: string;
        details_submitted?: boolean;
        charges_enabled?: boolean;
        payouts_enabled?: boolean;
        default_currency?: string | null;
        country?: string | null;
        external_accounts?: { data?: Array<Record<string, unknown>> } | null;
        requirements?: {
          disabled_reason?: string | null;
          currently_due?: string[] | null;
          past_due?: string[] | null;
          current_deadline?: number | null;
        } | null;
      };

      const row = await prisma.payoutAccount.findUnique({ where: { stripeAccountId: account.id } });
      // A webhook for an account we have since disconnected is not an
      // error — it is a race we lost, and dropping it is correct.
      if (!row) return NextResponse.json({ received: true, unknownAccount: true });

      const bank = account.external_accounts?.data?.find((item) => item.object === "bank_account") as
        | { bank_name?: string | null; last4?: string | null; currency?: string | null }
        | undefined;
      const due = [
        ...(account.requirements?.currently_due ?? []),
        ...(account.requirements?.past_due ?? []),
      ];

      await prisma.payoutAccount.update({
        where: { stripeAccountId: account.id },
        data: {
          status: statusFrom(account),
          detailsSubmitted: Boolean(account.details_submitted),
          chargesEnabled: Boolean(account.charges_enabled),
          payoutsEnabled: Boolean(account.payouts_enabled),
          requirementsDue: [...new Set(due)] as never,
          requirementsDueAt: account.requirements?.current_deadline
            ? new Date(account.requirements.current_deadline * 1000)
            : null,
          disabledReason: account.requirements?.disabled_reason ?? null,
          bankName: bank?.bank_name ?? null,
          bankLast4: bank?.last4 ?? null,
          bankCurrency: bank?.currency ?? account.default_currency ?? null,
          country: account.country ?? null,
          lastSyncedAt: new Date(),
          lastSyncError: null,
        },
      });
    }

    if (event.type === "account.application.deauthorized") {
      const accountId = (event.account ?? (event.data.object as { id?: string })?.id) as string | undefined;
      if (accountId) {
        await prisma.payoutAccount.updateMany({
          where: { stripeAccountId: accountId },
          data: {
            status: "disabled",
            payoutsEnabled: false,
            chargesEnabled: false,
            disabledReason: "deauthorized",
            lastSyncedAt: new Date(),
          },
        });
      }
    }
  } catch (error) {
    // Logged loudly, acknowledged anyway. See rule 2 at the top.
    console.error("[stripe-webhook] handling failed:", error);
  }

  return NextResponse.json({ received: true });
}
