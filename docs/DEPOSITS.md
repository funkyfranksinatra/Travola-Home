# Deposits — Stripe Connect Express

Where a restaurant's card revenue goes, and why it is built the way it is.

## The shape of it

Travola runs **Stripe Connect Express**. Each restaurant gets its own Stripe
account. Money moves:

    guest's card → the restaurant's own Stripe account → the restaurant's own bank

It does **not** pass through a Travola-owned balance at any point.

That is the single most important decision in this file, and it was made for
three reasons:

1. **Licensing.** A platform that takes custody of other businesses' revenue is
   doing money transmission, with the registration, bonding and audit burden
   that implies in every state it operates in. Express avoids the question
   entirely.
2. **Trust.** An owner will type an SSN and a routing number into a page with
   Stripe's name on it. They will hesitate on ours, and they are right to.
3. **Cost.** Stripe owns KYC, identity document review, ongoing requirement
   collection, the dispute flow and the payout dashboard. Building any of that
   ourselves is a team, not a sprint.

The trade is that onboarding and the payout dashboard are Stripe-branded pages
we send people to, not screens we control. For Phase 1 that is the right trade.

## What Travola never sees

The bank account number, the SSN, the identity documents. Stripe collects those
on its own pages. The `PayoutAccount` row caches the **last four digits**, the
bank name, the country and the currency — enough to let an owner confirm the
destination is the one they meant, and nothing more.

## Status is derived, never set

`status` is computed from Stripe's own three booleans on every sync
(`statusFrom`), and is never assigned by hand:

| Stripe says | We say | What the owner reads |
|---|---|---|
| `details_submitted: false` | `onboarding` | Stripe has not finished verifying this account. |
| `payouts_enabled && charges_enabled` | `active` | Verified. Card payments are deposited to this account. |
| details in, a flag still false | `restricted` | Stripe is holding deposits until it receives what is listed. |
| `disabled_reason` is rejected/closed | `disabled` | Stripe has disabled this account. |

A status that can disagree with the flags beside it is a bug that gets reported
as *"it says active but I have no money"*. Deriving it makes that impossible.

Note that **connected ≠ paid**. Stripe will happily accept an account and still
withhold payouts pending a document. The status line always reflects
`payouts_enabled` — the flag that decides whether money actually moves — not the
one that is easiest to make green.

## The cache, and why we render from it

Every screen renders from the `PayoutAccount` columns, never from a live API
call. A settings page must not go blank because Stripe had a bad minute. The
cache is refreshed three ways:

- on opening the unlocked panel (a live `accounts.retrieve`),
- on the **Refresh** button,
- from the `account.updated` **webhook**.

The webhook is the one that matters in practice. Verification is not instant and
not one-shot: an account can go active hours later, and back to restricted
months later when Stripe asks for a renewed document. Without the webhook, the
day a restaurant's payouts get paused is a day they find out by noticing no
money arrived.

`lastSyncedAt` is surfaced in the UI so a stale cache is never presented as
live truth.

## Webhook rules

Both of these are load-bearing:

1. **Verify the signature against the raw body.** An unverified webhook endpoint
   is an unauthenticated write endpoint that anyone on the internet can post to.
   With no `STRIPE_WEBHOOK_SECRET` the route returns 503 for everything rather
   than trusting the payload.
2. **Always return 200 once verified**, even when our own handling throws.
   Stripe retries non-2xx for days; a bug that returns 500 becomes a retry storm
   that outlives the bug.

## Preferences

| Preference | Pushed to Stripe? |
|---|---|
| Payout interval, weekly/monthly anchor, delay days | Yes — `settings.payouts.schedule` |
| Statement descriptor | Yes — `settings.payments.statement_descriptor` |
| Payout notification email | **No.** See below. |
| Tip handling and note | **No** — Travola-side only. See below. |

### The email is not Stripe's

The platform is **not authorised to edit `email` on an Express account** —
Stripe returns `StripePermissionError`, because that address belongs to the
account holder and they change it in the Express dashboard. We found this by
trying it. `payoutNotifyEmail` is therefore a Travola-side preference and the UI
says so explicitly rather than implying it rewires Stripe's own notifications.

### Tips

Card tips are deposited with the rest of the card revenue. **Travola cannot send
a tip to a server's own bank account** — that is a payroll product with its own
licensing. `tipHandling` records what the restaurant intends to do so the POS
and the reports can say the same thing the owner does. It changes no money
movement, and the UI does not pretend otherwise.

### Validation

`validatePrefs` enforces the rules Stripe enforces, locally, and returns **every**
problem rather than the first — a form that reveals its objections one at a time
is a form people abandon. The rules that bite most often:

- Statement descriptor: 5–22 characters, at least one letter, no `" ' < > \ *`.
- `delay_days` is **never sent on a manual schedule** — Stripe rejects the pair.
- A "Stripe's minimum" delay is stored as `null` and sent as the literal string
  `"minimum"`, not as `0`. They are different things and confusing them means
  the restaurant is paid on the wrong day.

## The lock

Deposit settings sit behind a **fresh** re-auth, not just a session:

1. A signed session (you are this restaurant).
2. The restaurant's **name**, typed. Not a dropdown, not read from the session.
3. The **owner code**, or the restaurant code when no owner code is set yet.

Proved within the last ten minutes — the same `ADMIN_WINDOW_MS` the delete route
uses, so a tablet left unlocked on the pass locks itself out. The locked panel
returns nothing about the account: not the bank, not the status. A locked screen
that leaks the bank's name is locked in name only.

Failure is deliberately vague — *"That restaurant name and code do not match"* —
because telling an attacker they got the name right turns two secrets into one.
Unlock attempts are rate-limited to six a minute and every unlock is audited.

### This is a placeholder

When manager accounts land (email + password + emailed confirmation code, Phase
6 of the roadmap), **only the `unlock` action changes.** Every other action
already asks nothing except "is the admin window fresh". That was the point of
routing it through the existing session claim rather than inventing a second
token.

## Disconnecting

`disconnect` forgets the account **here**. It deliberately does not call
`accounts.del`.

The restaurant's Stripe account holds their transaction history, their tax
documents and possibly a pending payout. Travola forgetting the link is
Travola's decision to make. Destroying the account is theirs, in Stripe, with
Stripe's own warnings in front of them.

Preferences survive a disconnect, so reconnecting does not mean setting the
schedule up again.

## What is not built yet

- **Charging a card.** This is the deposit destination only. Taking payment on a
  check is the POS's job and is not wired to Connect yet.
- **A platform fee.** Travola takes nothing out of a payout today. Adding an
  `application_fee_percent` later is a change to the charge call, not to this.
- **Payout history.** The Express dashboard shows it. Bringing it in-app is a
  later phase, not a Phase 1 gap.
