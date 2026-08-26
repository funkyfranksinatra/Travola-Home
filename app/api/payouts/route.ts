// app/api/payouts/route.ts — where a restaurant's money goes.
//
// Guarded like the danger route rather than like a settings page,
// because the consequence of getting this wrong is that a restaurant's
// takings land in someone else's bank account. Three guards, stacked:
//
//   1. A signed session (you are this restaurant).
//   2. The restaurant's own NAME, typed. Not a dropdown, not inferred
//      from the session — typing it is what stops a shared tablet in
//      the wrong hands from reaching this screen at all.
//   3. The owner code, or the restaurant code when no owner code has
//      been set yet. Proved in the last ten minutes, not at sign-in
//      three hours ago — the same fresh-admin window the delete route
//      uses, so an unattended tablet on the pass locks itself out.
//
// The unlock is a placeholder for the real thing. When manager accounts
// land (email + password + an emailed confirmation code), THIS is the
// endpoint whose `unlock` action changes and nothing else does: every
// route below already asks only "is the admin window fresh".
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireRestaurant, withTenant } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { allowAttempt, nameKey, verifyAdminPasscode, hasAdminPasscode } from "@/lib/restaurant-auth";
import { hasFreshAdmin, setSession, adminWindowRemaining, HOME_SESSION_COOKIE, ADMIN_WINDOW_MS } from "@/lib/session";
import { stripe } from "@/lib/stripe";
import { stripeMessage, isStripeNotConfigured } from "@/lib/stripe";
import {
  DEFAULT_PREFS,
  MAX_DELAY_DAYS,
  PAYOUT_INTERVALS,
  TIP_HANDLING,
  describeSchedule,
  describeStatus,
  loadAccount,
  stripeConfigured,
  stripeTestMode,
  stripeSettingsFrom,
  syncFromStripe,
  validatePrefs,
  type PayoutPrefs,
} from "@/lib/payouts";

export const dynamic = "force-dynamic";

function unlockedFor(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${HOME_SESSION_COOKIE}=`))
    ?.slice(HOME_SESSION_COOKIE.length + 1);
  return adminWindowRemaining(value);
}

/** The public shape. Deliberately never includes the Stripe account id:
 *  it is not a secret, but it is also not something a settings page has
 *  any reason to hand to a browser. */
function present(row: Awaited<ReturnType<typeof loadAccount>>, extras: Record<string, unknown>) {
  const prefs: PayoutPrefs = {
    payoutInterval: row.payoutInterval as PayoutPrefs["payoutInterval"],
    payoutWeeklyAnchor: row.payoutWeeklyAnchor,
    payoutMonthlyAnchor: row.payoutMonthlyAnchor,
    payoutDelayDays: row.payoutDelayDays,
    statementDescriptor: row.statementDescriptor,
    payoutNotifyEmail: row.payoutNotifyEmail,
    tipHandling: row.tipHandling as PayoutPrefs["tipHandling"],
    tipNote: row.tipNote,
  };
  return {
    connected: Boolean(row.stripeAccountId),
    status: row.status,
    statusLine: describeStatus(row),
    payoutsEnabled: row.payoutsEnabled,
    chargesEnabled: row.chargesEnabled,
    detailsSubmitted: row.detailsSubmitted,
    requirementsDue: (row.requirementsDue ?? []) as string[],
    requirementsDueAt: row.requirementsDueAt,
    disabledReason: row.disabledReason,
    bank: row.bankLast4 ? { name: row.bankName, last4: row.bankLast4, currency: row.bankCurrency } : null,
    country: row.country,
    prefs,
    scheduleLine: describeSchedule(prefs),
    lastSyncedAt: row.lastSyncedAt,
    lastSyncError: row.lastSyncError,
    processor: {
      configured: stripeConfigured(),
      testMode: stripeTestMode(),
    },
    ...extras,
  };
}

export async function GET(request: Request) {
  return withTenant(request, async (restaurantId) => {
    const remaining = unlockedFor(request);
    const [row, restaurant, adminSet] = await Promise.all([
      loadAccount(restaurantId),
      prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { name: true, recoveryEmail: true } }),
      hasAdminPasscode(restaurantId),
    ]);

    // Locked: say what this screen is and what it will ask for, and
    // nothing about the account itself. A locked screen that leaks the
    // bank's name is a locked screen in name only.
    if (!remaining) {
      return Response.json({
        unlocked: false,
        adminSet,
        codeLabel: adminSet ? "Owner code" : "Restaurant code",
        restaurantName: restaurant?.name ?? "",
        processor: { configured: stripeConfigured(), testMode: stripeTestMode() },
        connected: Boolean(row.stripeAccountId),
      });
    }

    // Unlocked and connected: refresh from Stripe so the page is not
    // showing last week's verification state, then render the cache.
    let current = row;
    if (row.stripeAccountId && stripeConfigured()) {
      const synced = await syncFromStripe(restaurantId, row.stripeAccountId);
      if (synced) current = synced;
    }

    return Response.json({
      unlocked: true,
      unlockExpiresIn: remaining,
      adminSet,
      restaurantName: restaurant?.name ?? "",
      ...present(current, { fallbackEmail: restaurant?.recoveryEmail ?? null }),
    });
  });
}

export async function POST(request: Request) {
  let restaurantId: string;
  try {
    restaurantId = requireRestaurant(request);
  } catch (error) {
    return error as Response;
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");

  // ── unlock ──────────────────────────────────────────────────────
  if (action === "unlock") {
    if (!allowAttempt(request, "payouts-unlock", 6)) {
      return NextResponse.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 });
    }
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true, nameKey: true },
    });
    if (!restaurant) return NextResponse.json({ error: "Restaurant not found." }, { status: 404 });

    const typed = nameKey(body.name);
    const code = String(body.code ?? "");

    // Both must be right, and the failure message says which is wrong
    // only in the vaguest terms — telling an attacker they got the name
    // right turns two secrets into one.
    const nameOk = Boolean(typed) && typed === restaurant.nameKey;
    const codeResult = await verifyAdminPasscode(restaurantId, code);
    if (!nameOk || !codeResult.ok) {
      return NextResponse.json(
        { error: "That restaurant name and code do not match." },
        { status: 401 },
      );
    }

    await audit({
      restaurantId,
      action: "auth.admin_verified",
      summary: "Unlocked deposit settings",
      detail: { usedRestaurantCode: codeResult.usedFallback },
      req: request,
    });

    const response = NextResponse.json({
      ok: true,
      unlockExpiresIn: ADMIN_WINDOW_MS,
      usedRestaurantCode: codeResult.usedFallback,
    });
    return setSession(response, restaurantId, true);
  }

  // Everything past here needs a fresh unlock.
  if (!hasFreshAdmin(request)) {
    return NextResponse.json(
      { error: "Your deposit settings locked again. Enter the restaurant name and code to continue.", locked: true },
      { status: 401 },
    );
  }

  try {
    // ── connect: create the Connect account and hand back an onboarding link ──
    if (action === "connect" || action === "resume_onboarding") {
      if (!stripeConfigured()) {
        return NextResponse.json(
          { error: "Stripe is not connected to this deployment yet, so deposits cannot be set up." },
          { status: 503 },
        );
      }
      const row = await loadAccount(restaurantId);
      const restaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { name: true, recoveryEmail: true },
      });

      let accountId = row.stripeAccountId;
      if (!accountId) {
        // Express: Stripe hosts onboarding and the payout dashboard, and
        // owns KYC. `card_payments` + `transfers` is the pair a
        // restaurant needs to take a card and be paid for it.
        const account = await stripe().accounts.create({
          type: "express",
          country: "US",
          email: restaurant?.recoveryEmail ?? undefined,
          business_type: "company",
          business_profile: {
            name: restaurant?.name ?? undefined,
            product_description: "Restaurant food and beverage sales",
            // 5812 — Eating Places, Restaurants. Set explicitly so Stripe
            // does not have to guess, which speeds up verification.
            mcc: "5812",
          },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: { travolaRestaurantId: restaurantId },
        });
        accountId = account.id;
        await prisma.payoutAccount.update({
          where: { restaurantId },
          data: { stripeAccountId: accountId, provider: "stripe", status: "onboarding" },
        });
        await audit({
          restaurantId,
          action: "payouts.account_created",
          summary: "Created a Stripe Connect account for deposits",
          req: request,
        });
      }

      const origin = new URL(request.url).origin;
      const link = await stripe().accountLinks.create({
        account: accountId,
        // Both point back at settings. `refresh_url` is what Stripe uses
        // when its own link has expired — sending that to a dead page is
        // the classic Connect bug, so it goes somewhere real.
        refresh_url: `${origin}/settings?deposits=refresh`,
        return_url: `${origin}/settings?deposits=return`,
        type: "account_onboarding",
      });
      return NextResponse.json({ ok: true, url: link.url });
    }

    // ── dashboard: a one-time login link to the Express dashboard ──
    if (action === "dashboard") {
      const row = await loadAccount(restaurantId);
      if (!row.stripeAccountId) {
        return NextResponse.json({ error: "No account is connected yet." }, { status: 400 });
      }
      const link = await stripe().accounts.createLoginLink(row.stripeAccountId);
      await audit({
        restaurantId,
        action: "payouts.dashboard_opened",
        summary: "Opened the Stripe payout dashboard",
        req: request,
      });
      return NextResponse.json({ ok: true, url: link.url });
    }

    // ── refresh: pull Stripe's current view on demand ──
    if (action === "refresh") {
      const row = await loadAccount(restaurantId);
      if (!row.stripeAccountId) return NextResponse.json({ ok: true, changed: false });
      const synced = await syncFromStripe(restaurantId, row.stripeAccountId);
      if (!synced) return NextResponse.json({ error: "Could not reach Stripe. Your settings are unchanged." }, { status: 502 });
      return NextResponse.json({ ok: true, ...present(synced, {}) });
    }

    // ── save: preferences ──
    if (action === "save") {
      const raw = (body.prefs ?? {}) as Record<string, unknown>;
      const edits: Partial<PayoutPrefs> = {};

      if (typeof raw.payoutInterval === "string") edits.payoutInterval = raw.payoutInterval as never;
      if (raw.payoutWeeklyAnchor !== undefined) edits.payoutWeeklyAnchor = Number(raw.payoutWeeklyAnchor);
      if (raw.payoutMonthlyAnchor !== undefined) edits.payoutMonthlyAnchor = Number(raw.payoutMonthlyAnchor);
      if (raw.payoutDelayDays !== undefined) {
        edits.payoutDelayDays =
          raw.payoutDelayDays === null || raw.payoutDelayDays === "" ? null : Number(raw.payoutDelayDays);
      }
      if (raw.statementDescriptor !== undefined) {
        edits.statementDescriptor = String(raw.statementDescriptor ?? "").trim() || null;
      }
      if (raw.payoutNotifyEmail !== undefined) {
        edits.payoutNotifyEmail = String(raw.payoutNotifyEmail ?? "").trim() || null;
      }
      if (typeof raw.tipHandling === "string") edits.tipHandling = raw.tipHandling as never;
      if (raw.tipNote !== undefined) edits.tipNote = String(raw.tipNote ?? "").trim() || null;

      const problems = validatePrefs(edits);
      if (problems.length) {
        return NextResponse.json({ error: problems[0].message, fields: problems }, { status: 400 });
      }

      const row = await loadAccount(restaurantId);
      const merged: PayoutPrefs = {
        payoutInterval: (edits.payoutInterval ?? row.payoutInterval) as PayoutPrefs["payoutInterval"],
        payoutWeeklyAnchor: edits.payoutWeeklyAnchor ?? row.payoutWeeklyAnchor,
        payoutMonthlyAnchor: edits.payoutMonthlyAnchor ?? row.payoutMonthlyAnchor,
        payoutDelayDays: edits.payoutDelayDays !== undefined ? edits.payoutDelayDays : row.payoutDelayDays,
        statementDescriptor:
          edits.statementDescriptor !== undefined ? edits.statementDescriptor : row.statementDescriptor,
        payoutNotifyEmail: edits.payoutNotifyEmail !== undefined ? edits.payoutNotifyEmail : row.payoutNotifyEmail,
        tipHandling: (edits.tipHandling ?? row.tipHandling) as PayoutPrefs["tipHandling"],
        tipNote: edits.tipNote !== undefined ? edits.tipNote : row.tipNote,
      };

      // Push to Stripe FIRST when there is an account to push to. If
      // Stripe rejects the schedule we must not be left showing a saved
      // preference that Stripe never accepted — that is how an owner
      // ends up believing they are on weekly payouts when they are not.
      // NOTE: we do NOT send `email`. On an Express account the platform
      // is not authorised to edit it — Stripe returns
      // StripePermissionError — because that address belongs to the
      // account holder and they change it in the Express dashboard.
      // `payoutNotifyEmail` is therefore a TRAVOLA-side preference, and
      // the UI says so rather than implying it rewires Stripe's own
      // notifications.
      if (row.stripeAccountId && stripeConfigured()) {
        await stripe().accounts.update(row.stripeAccountId, {
          settings: stripeSettingsFrom(merged) as never,
        });
      }

      const saved = await prisma.payoutAccount.update({ where: { restaurantId }, data: merged });
      await audit({
        restaurantId,
        action: "payouts.settings_updated",
        summary: `Deposit settings updated — ${describeSchedule(merged)}`,
        detail: merged,
        req: request,
      });
      return NextResponse.json({ ok: true, ...present(saved, {}) });
    }

    // ── disconnect: forget the account here, never delete it at Stripe ──
    if (action === "disconnect") {
      const row = await loadAccount(restaurantId);
      // Deliberately does NOT call accounts.del. The restaurant's Stripe
      // account holds their transaction history, their tax documents and
      // possibly a pending payout. Travola forgetting the link is a
      // Travola decision; destroying the account is theirs to make, in
      // Stripe, with Stripe's own warnings in front of them.
      await prisma.payoutAccount.update({
        where: { restaurantId },
        data: {
          stripeAccountId: null,
          status: "not_started",
          detailsSubmitted: false,
          chargesEnabled: false,
          payoutsEnabled: false,
          requirementsDue: [] as never,
          requirementsDueAt: null,
          disabledReason: null,
          bankName: null,
          bankLast4: null,
          bankCurrency: null,
          lastSyncedAt: null,
          lastSyncError: null,
        },
      });
      await audit({
        restaurantId,
        action: "payouts.disconnected",
        summary: `Disconnected the deposit account${row.bankLast4 ? ` ending ${row.bankLast4}` : ""}`,
        detail: { stripeAccountId: row.stripeAccountId },
        req: request,
      });
      return NextResponse.json({ ok: true, note: "Disconnected here. The Stripe account itself still exists — close it in Stripe if you want it gone." });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (isStripeNotConfigured(error)) {
      return NextResponse.json({ error: stripeMessage(error) }, { status: 503 });
    }
    console.error("[payouts]", error);
    return NextResponse.json({ error: stripeMessage(error) }, { status: 502 });
  }
}
