// lib/billing/stub.ts — the database-backed billing provider.
//
// Real state, simulated money. Every restaurant gets a 30-day trial on
// first read; plan changes, cancellations and resumes are durable; each
// renewal issues an invoice row. What it does NOT do is move money, and
// the UI says so on every screen rather than hiding it — an owner who
// thinks they have cancelled a live charge and has not is a support
// ticket at best.
import { prisma } from "../prisma";
import { PLAN_BY_KEY, priceCents, type PlanKey } from "./plans";
import type { BillingProvider, InvoiceView, SubscriptionView } from "./provider";

const DAY = 24 * 60 * 60 * 1000;
const TRIAL_DAYS = 30;

function addMonths(from: Date, months: number) {
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function view(row: {
  plan: string; status: string; interval: string; priceCents: number; currency: string; seats: number;
  trialEndsAt: Date | null; currentPeriodStart: Date | null; currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean; canceledAt: Date | null; cancelReason: string | null;
  provider: string; billingContact: unknown;
}): SubscriptionView {
  const plan = (row.plan in PLAN_BY_KEY ? row.plan : "standard") as PlanKey;
  return {
    plan,
    planName: PLAN_BY_KEY[plan].name,
    status: row.status as SubscriptionView["status"],
    interval: row.interval === "year" ? "year" : "month",
    priceCents: row.priceCents,
    currency: row.currency,
    seats: row.seats,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    currentPeriodStart: row.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    canceledAt: row.canceledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    provider: row.provider,
    simulated: row.provider === "stub",
    billingContact: (row.billingContact ?? null) as SubscriptionView["billingContact"],
  };
}

async function ensure(restaurantId: string) {
  const existing = await prisma.subscription.findUnique({ where: { restaurantId } });
  if (existing) return existing;
  const now = new Date();
  return prisma.subscription.create({
    data: {
      restaurantId,
      plan: "standard",
      status: "trialing",
      interval: "month",
      priceCents: priceCents("standard", "month"),
      trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY),
      currentPeriodStart: now,
      currentPeriodEnd: addMonths(now, 1),
      provider: "stub",
    },
  });
}

export const stubBilling: BillingProvider = {
  key: "stub",

  async getSubscription(restaurantId) {
    return view(await ensure(restaurantId));
  },

  async listInvoices(restaurantId, limit = 24) {
    const rows = await prisma.invoice.findMany({
      where: { restaurantId },
      orderBy: { issuedAt: "desc" },
      take: limit,
    });
    return rows.map<InvoiceView>((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      totalCents: row.totalCents,
      currency: row.currency,
      periodStart: row.periodStart?.toISOString() ?? null,
      periodEnd: row.periodEnd?.toISOString() ?? null,
      issuedAt: row.issuedAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
      description: row.description,
      hostedUrl: row.hostedUrl,
      pdfUrl: row.pdfUrl,
    }));
  },

  async changePlan(restaurantId, plan, interval) {
    const current = await ensure(restaurantId);
    const now = new Date();
    const updated = await prisma.subscription.update({
      where: { restaurantId },
      data: {
        plan,
        interval,
        priceCents: priceCents(plan, interval),
        // A plan change also un-cancels: an owner who upgrades has
        // plainly changed their mind about leaving, and leaving a
        // scheduled cancellation in place would silently end the
        // subscription they just paid more for.
        cancelAtPeriodEnd: false,
        canceledAt: null,
        cancelReason: null,
        status: current.status === "canceled" ? "active" : current.status,
        currentPeriodStart: current.currentPeriodStart ?? now,
        currentPeriodEnd:
          current.interval === interval && current.currentPeriodEnd
            ? current.currentPeriodEnd
            : addMonths(now, interval === "year" ? 12 : 1),
      },
    });
    return view(updated);
  },

  async cancel(restaurantId, opts) {
    await ensure(restaurantId);
    const now = new Date();
    const updated = await prisma.subscription.update({
      where: { restaurantId },
      data: opts.immediate
        ? { status: "canceled", cancelAtPeriodEnd: false, canceledAt: now, cancelReason: opts.reason ?? null }
        // The default is period-end, not immediate: a restaurant that
        // cancels on the 3rd has paid through the month and should keep
        // its floor plan and its history until then.
        : { cancelAtPeriodEnd: true, canceledAt: now, cancelReason: opts.reason ?? null },
    });
    return view(updated);
  },

  async resume(restaurantId) {
    await ensure(restaurantId);
    const updated = await prisma.subscription.update({
      where: { restaurantId },
      data: {
        cancelAtPeriodEnd: false,
        canceledAt: null,
        cancelReason: null,
        status: "active",
      },
    });
    return view(updated);
  },

  async updateContact(restaurantId, contact) {
    await ensure(restaurantId);
    const updated = await prisma.subscription.update({
      where: { restaurantId },
      data: { billingContact: (contact ?? undefined) as never },
    });
    return view(updated);
  },
};
