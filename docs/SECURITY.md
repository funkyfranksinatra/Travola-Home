# Credentials, sessions and destructive actions

## One credential, three products

A restaurant's name and four-digit code sign it in to Travola-OS, the POS and the
Console. All three hash with the identical scheme (`scrypt$<salt>$<derived>`) and
all three normalise the restaurant name through the **same** `nameKey` function,
copied verbatim between repos — which is what makes "Volario's" typed on an iPad
with a curly apostrophe resolve to the restaurant registered from a desktop.

Sessions are HMAC-signed cookies over a shared `SESSION_SECRET`. The cookie
**names** differ (`travola_console_session` / `travola_pos_session` /
the floor app's) so one device can hold all three at once and signing out of one
does not sign out the others. The signatures are interchangeable, so moving all
three onto `travola.app` subdomains and sharing one cookie later is a rename,
not a rewrite.

## The owner code

`Restaurant.adminPasscodeHash` is a **second** credential, separate from the
four digits the whole floor knows. It gates:

- deleting restaurant data
- changing the restaurant code
- changing the owner code itself

Until an owner sets one, the Console falls back to the restaurant passcode **and
nags on the overview page**, because a code every server knows is not an owner
credential.

Proving it opens a **ten-minute window** stamped into the session cookie. A
tablet left signed in on the pass cannot delete a restaurant three hours later.

## Deleting data

Four independent guards, none a substitute for another:

1. A signed session.
2. A **fresh** admin window (proved in the last ten minutes).
3. The owner code **again, in the request body**.
4. The restaurant's own name, typed exactly — not the word `DELETE`. Typing the
   name is the step that stops the wrong restaurant being deleted.

Plus an explicit scope, never inferred:

| Scope | Removes | Keeps |
|---|---|---|
| `history` | Reservations, guests, waitlist, shifts, checks, payments, sessions, events, forecasts | Floor plan, staff, menu, settings — so the restaurant works from tonight |
| `everything` | The above plus floor plan, staff, menu, settings; cancels the subscription | The account and the audit log |

**The account and the audit log always survive.** The owner can still sign in and
see that the deletion happened, who did it and when. A wipe that erases the
evidence of itself is not a feature.

Deletes run in one transaction, child-before-parent. A foreign-key error half way
through a destructive operation is the worst possible moment to fail, so if any
statement fails, nothing is removed.

## Audit log

Every consequential act is recorded: sign-ins, admin unlocks, credential
rotations, PIN resets, staff revocations, plan changes, cancellations, exports
and deletions. It is exportable as CSV like any other table.

## Staff are deactivated, never deleted

An ex-employee's name is on two years of checks and reservations. Deleting the
row would either fail on a foreign key or orphan the history and quietly change
the numbers on the analysis tab. Revoking access — which clears the PIN
immediately — is what "delete this ex-employee" actually means.

## Rate limits

Per-instance, in-memory, 60-second windows: 10 sign-in attempts, 8 credential
changes, 6 admin unlocks, 4 deletion attempts. Enough to blunt guessing at pilot
scale; durable rate limiting lands with multi-tenant hardening.
