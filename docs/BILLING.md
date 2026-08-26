# Billing

## Why there is a stub

No payment processor is connected to Travola yet. There were two bad options and
one good one:

1. Block the whole Console on setting up a processor. Slow, and it makes the
   billing page's design hostage to an account nobody has opened yet.
2. Hard-code a processor's shapes into the components. Cheap now, a rewrite later.
3. **Put a seam in.** The Console talks to a `BillingProvider` interface. A
   `stub` implementation keeps the full subscription lifecycle in our own
   database. When a processor is wired up, its adapter satisfies the same
   interface, the stored `Subscription` row gains provider ids, and **no
   component changes.**

The stub is not a mock. Plans change, cancellations schedule for period end,
invoices are issued and listed — all durable, all audit-logged. What it does not
do is move money, and every screen says so plainly. An owner who believes they
have cancelled a live charge and has not is a support ticket at best.

## The plans

| Plan | Monthly | Yearly | For |
|---|---|---|---|
| Starter | $99 | $990 | Floor manager + POS, one terminal, 90 days of history |
| Standard | $249 | $2,490 | Adds AI shift intelligence, unlimited terminals, full history, menu importer |
| Pro | $449 | $4,490 | Adds weekly research forecasts, accuracy scoring, multi-floor |

Yearly is ten months — two free, stated plainly rather than as a percentage the
operator has to work out. A unit test enforces the 10× relationship so the
promise cannot silently drift.

## Behaviour worth knowing

- **Cancelling defaults to period end.** A restaurant that cancels on the 3rd has
  paid through the month and keeps its floor plan until then. Immediate
  cancellation is possible but is never the default.
- **A plan change un-cancels.** An owner who upgrades has plainly changed their
  mind about leaving; leaving a scheduled cancellation in place would end the
  subscription they just paid more for.
- **Billing details are a snapshot**, not a join. Changing the address does not
  rewrite invoices already issued.
- **Deleting all restaurant data cancels the subscription immediately.** Billing
  against an emptied account is how a clean exit turns into a chargeback.

## Connecting a real processor

1. Write `lib/billing/stripe.ts` implementing `BillingProvider`.
2. Add the branch in `lib/billing/index.ts`.
3. Set `BILLING_PROVIDER=stripe` and the price ids.
4. Add a webhook route that writes `Subscription` and `Invoice` rows — the
   Console renders from those columns, never from live API calls, so the billing
   page does not go blank when the processor has a bad minute.
