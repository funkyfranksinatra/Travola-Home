// lib/payouts.ts — deposit preferences, and the translation to Stripe.
//
// Everything in here is pure except `syncFromStripe`, `ensureAccount`,
// `onboardingLink` and `dashboardLink`, which are the only four places
// that touch the network. That split is deliberate: the validation rules
// below are the ones an owner runs into constantly, and they are worth
// unit-testing without a Stripe account.
//
// A note on what Travola can and cannot do, because the UI copy depends
// on getting this right:
//
//   • Card revenue from a closed check goes to the restaurant's OWN
//     Stripe account and is paid out to the restaurant's OWN bank. It
//     does not pass through a Travola balance.
//   • Tips ride along with that revenue. Travola CANNOT deposit a tip
//     into a server's personal account — that would be a payroll
//     product with its own licensing. `tipHandling` records what the
//     restaurant intends to do, so the POS and the reports can say it.
//   • Stripe's fee comes off before the deposit. Travola takes nothing
//     out of a payout today.
import { prisma } from "./prisma";
import { stripe, stripeConfigured, stripeTestMode } from "./stripe";

export const PAYOUT_INTERVALS = ["daily", "weekly", "monthly", "manual"] as const;
export type PayoutInterval = (typeof PAYOUT_INTERVALS)[number];

export const TIP_HANDLING = ["with_payout", "cash_nightly", "payroll"] as const;
export type TipHandling = (typeof TIP_HANDLING)[number];

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Stripe names weekly anchors, we store 0-6. One table, both directions. */
const STRIPE_WEEKLY = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export const MAX_DELAY_DAYS = 30;

export type PayoutPrefs = {
  payoutInterval: PayoutInterval;
  payoutWeeklyAnchor: number;
  payoutMonthlyAnchor: number;
  payoutDelayDays: number | null;
  statementDescriptor: string | null;
  payoutNotifyEmail: string | null;
  tipHandling: TipHandling;
  tipNote: string | null;
};

// ── Validation ────────────────────────────────────────────────────
// Every rule here exists because Stripe enforces it and returns a
// developer-facing error when it is broken. Catching it locally means
// the owner reads "Between 5 and 22 characters" instead of a stack of
// Stripe jargon, and means we never send a request we know will fail.

export type FieldError = { field: string; message: string };

/** Stripe rejects these outright in a statement descriptor. */
const DESCRIPTOR_BANNED = /["'<>\\*]/;

export function validateDescriptor(value: string): FieldError | null {
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 22) {
    return { field: "statementDescriptor", message: "Between 5 and 22 characters — Stripe's limit, not ours." };
  }
  if (DESCRIPTOR_BANNED.test(trimmed)) {
    return { field: "statementDescriptor", message: "No quotes, angle brackets, backslashes or asterisks." };
  }
  if (!/[a-zA-Z]/.test(trimmed)) {
    return { field: "statementDescriptor", message: "Needs at least one letter, or a guest cannot tell who charged them." };
  }
  return null;
}

export function validateEmail(value: string): FieldError | null {
  const trimmed = value.trim();
  // Deliberately loose. The purpose is to catch a typo, not to relitigate
  // RFC 5322 — an address that looks fine and bounces is Stripe's to report.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed)) {
    return { field: "payoutNotifyEmail", message: "That does not look like an email address." };
  }
  return null;
}

/** Validate a whole edit. Returns every problem, not just the first —
 *  a form that reveals its objections one at a time is a form people
 *  give up on. */
export function validatePrefs(edits: Partial<PayoutPrefs>): FieldError[] {
  const errors: FieldError[] = [];

  if (edits.payoutInterval !== undefined && !PAYOUT_INTERVALS.includes(edits.payoutInterval)) {
    errors.push({ field: "payoutInterval", message: "Pick daily, weekly, monthly or manual." });
  }
  if (edits.tipHandling !== undefined && !TIP_HANDLING.includes(edits.tipHandling)) {
    errors.push({ field: "tipHandling", message: "Pick one of the tip options." });
  }
  if (edits.payoutWeeklyAnchor !== undefined) {
    const n = edits.payoutWeeklyAnchor;
    if (!Number.isInteger(n) || n < 0 || n > 6) {
      errors.push({ field: "payoutWeeklyAnchor", message: "Pick a day of the week." });
    }
  }
  if (edits.payoutMonthlyAnchor !== undefined) {
    const n = edits.payoutMonthlyAnchor;
    if (!Number.isInteger(n) || n < 1 || n > 31) {
      errors.push({ field: "payoutMonthlyAnchor", message: "Pick a date between 1 and 31." });
    }
  }
  if (edits.payoutDelayDays !== undefined && edits.payoutDelayDays !== null) {
    const n = edits.payoutDelayDays;
    if (!Number.isInteger(n) || n < 0 || n > MAX_DELAY_DAYS) {
      errors.push({ field: "payoutDelayDays", message: `Between 0 and ${MAX_DELAY_DAYS} days, or leave it on Stripe's minimum.` });
    }
  }
  if (edits.statementDescriptor !== undefined && edits.statementDescriptor !== null && edits.statementDescriptor !== "") {
    const problem = validateDescriptor(edits.statementDescriptor);
    if (problem) errors.push(problem);
  }
  if (edits.payoutNotifyEmail !== undefined && edits.payoutNotifyEmail !== null && edits.payoutNotifyEmail !== "") {
    const problem = validateEmail(edits.payoutNotifyEmail);
    if (problem) errors.push(problem);
  }
  if (edits.tipNote !== undefined && edits.tipNote !== null && edits.tipNote.length > 280) {
    errors.push({ field: "tipNote", message: "Keep the note under 280 characters." });
  }
  return errors;
}

// ── Plain-language description ────────────────────────────────────

/** One sentence an owner can check at a glance. This is the single most
 *  read string on the page: it is how someone confirms they set what
 *  they meant to without re-reading four separate controls. */
export function describeSchedule(prefs: Pick<PayoutPrefs, "payoutInterval" | "payoutWeeklyAnchor" | "payoutMonthlyAnchor" | "payoutDelayDays">) {
  const delay =
    prefs.payoutDelayDays == null
      ? "at Stripe's minimum hold for your account"
      : prefs.payoutDelayDays === 0
        ? "the same day they settle"
        : `${prefs.payoutDelayDays} day${prefs.payoutDelayDays === 1 ? "" : "s"} after they settle`;

  switch (prefs.payoutInterval) {
    case "manual":
      return "Nothing is sent automatically. Funds sit in Stripe until you request a payout from the Stripe dashboard.";
    case "weekly":
      return `Sent every ${WEEKDAYS[prefs.payoutWeeklyAnchor] ?? "Friday"}, covering payments released ${delay}.`;
    case "monthly": {
      const day = prefs.payoutMonthlyAnchor;
      const tail = day > 28 ? " (or the last day, in a shorter month)" : "";
      return `Sent on day ${day} of each month${tail}, covering payments released ${delay}.`;
    }
    case "daily":
    default:
      return `Sent every day, covering payments released ${delay}.`;
  }
}

/** What Stripe's own flags mean, in a sentence, for each status. */
export function describeStatus(row: {
  status: string;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason?: string | null;
}) {
  switch (row.status) {
    case "active":
      return "Verified. Card payments on closed checks are deposited to this account.";
    case "onboarding":
      return "Stripe has not finished verifying this account. Deposits start once it does.";
    case "restricted":
      return row.chargesEnabled
        ? "Stripe is holding deposits until it receives the outstanding information below."
        : "Stripe has paused this account until it receives the outstanding information below.";
    case "disabled":
      return "Stripe has disabled this account. Nothing can be deposited until it is resolved with Stripe.";
    case "not_started":
    default:
      return "No bank account is connected, so card payments have nowhere to be deposited.";
  }
}

/** Derive our status from Stripe's flags. Never set by hand: a status
 *  that can disagree with the booleans beside it is a bug waiting to be
 *  reported as "it says active but I have no money". */
export function statusFrom(account: {
  details_submitted?: boolean;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  requirements?: { disabled_reason?: string | null; currently_due?: string[] | null; past_due?: string[] | null } | null;
}): string {
  const disabled = account.requirements?.disabled_reason ?? null;
  if (disabled && /rejected|closed/.test(disabled)) return "disabled";
  if (account.payouts_enabled && account.charges_enabled) return "active";
  if (!account.details_submitted) return "onboarding";
  // Details in, but Stripe is still withholding something.
  return "restricted";
}

// ── Reading and writing the row ───────────────────────────────────

export const DEFAULT_PREFS: PayoutPrefs = {
  payoutInterval: "daily",
  payoutWeeklyAnchor: 5,
  payoutMonthlyAnchor: 1,
  payoutDelayDays: null,
  statementDescriptor: null,
  payoutNotifyEmail: null,
  tipHandling: "with_payout",
  tipNote: null,
};

/** The row, created on first read so every later write is a plain update. */
export async function loadAccount(restaurantId: string) {
  const existing = await prisma.payoutAccount.findUnique({ where: { restaurantId } });
  if (existing) return existing;
  return prisma.payoutAccount.create({
    data: { restaurantId, provider: stripeConfigured() ? "stripe" : "stub" },
  });
}

/** Map our stored preferences onto Stripe's account-update shape. */
export function stripeSettingsFrom(prefs: PayoutPrefs) {
  const schedule: Record<string, unknown> =
    prefs.payoutInterval === "manual"
      ? { interval: "manual" }
      : prefs.payoutInterval === "weekly"
        ? { interval: "weekly", weekly_anchor: STRIPE_WEEKLY[prefs.payoutWeeklyAnchor] ?? "friday" }
        : prefs.payoutInterval === "monthly"
          ? { interval: "monthly", monthly_anchor: prefs.payoutMonthlyAnchor }
          : { interval: "daily" };

  // Stripe treats "minimum" as the string literal, not a number, and
  // rejects delay_days entirely on a manual schedule.
  if (prefs.payoutInterval !== "manual") {
    schedule.delay_days = prefs.payoutDelayDays == null ? "minimum" : prefs.payoutDelayDays;
  }

  const settings: Record<string, unknown> = { payouts: { schedule } };
  if (prefs.statementDescriptor) {
    settings.payments = { statement_descriptor: prefs.statementDescriptor.trim() };
  }
  return settings;
}

/** Read Stripe's view of an account into our columns. Best-effort by
 *  design — a failed sync records itself and leaves the cache alone
 *  rather than blanking a page that was rendering fine a second ago. */
export async function syncFromStripe(restaurantId: string, stripeAccountId: string) {
  try {
    const account = await stripe().accounts.retrieve(stripeAccountId);
    const external = account.external_accounts?.data?.find((item) => item.object === "bank_account") as
      | { bank_name?: string | null; last4?: string | null; currency?: string | null }
      | undefined;
    const due = [
      ...(account.requirements?.currently_due ?? []),
      ...(account.requirements?.past_due ?? []),
    ];
    return await prisma.payoutAccount.update({
      where: { restaurantId },
      data: {
        provider: "stripe",
        status: statusFrom(account),
        detailsSubmitted: Boolean(account.details_submitted),
        chargesEnabled: Boolean(account.charges_enabled),
        payoutsEnabled: Boolean(account.payouts_enabled),
        requirementsDue: [...new Set(due)] as never,
        requirementsDueAt: account.requirements?.current_deadline
          ? new Date(account.requirements.current_deadline * 1000)
          : null,
        disabledReason: account.requirements?.disabled_reason ?? null,
        bankName: external?.bank_name ?? null,
        bankLast4: external?.last4 ?? null,
        bankCurrency: external?.currency ?? account.default_currency ?? null,
        country: account.country ?? null,
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
    });
  } catch (error) {
    console.error("[payouts] sync failed:", error);
    await prisma.payoutAccount
      .update({
        where: { restaurantId },
        data: { lastSyncError: (error as Error)?.message?.slice(0, 300) ?? "sync failed" },
      })
      .catch(() => {});
    return null;
  }
}

export { stripeConfigured, stripeTestMode };
