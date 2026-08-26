// app/api/billing/route.ts — subscription, plan changes, invoices.
//
// Everything routes through the billing provider seam (lib/billing) so
// connecting a real processor later changes one file and not this one.
import { NextResponse } from "next/server";
import { withTenant, requireRestaurant } from "@/lib/tenant";
import { billing, isPlanKey, PLANS } from "@/lib/billing";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return withTenant(request, async (restaurantId) => {
    const provider = billing();
    const [subscription, invoices] = await Promise.all([
      provider.getSubscription(restaurantId),
      provider.listInvoices(restaurantId),
    ]);
    return Response.json({ subscription, invoices, plans: PLANS });
  });
}

export async function POST(request: Request) {
  let restaurantId: string;
  try {
    restaurantId = requireRestaurant(request);
  } catch (error) {
    return error as Response;
  }

  const body = await request.json().catch(() => null);
  const action = String(body?.action ?? "");
  const provider = billing();

  if (action === "change_plan") {
    const plan = body?.plan;
    const interval = body?.interval === "year" ? "year" : "month";
    if (!isPlanKey(plan)) return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
    const before = await provider.getSubscription(restaurantId);
    const subscription = await provider.changePlan(restaurantId, plan, interval);
    await audit({
      restaurantId, action: "plan.change", req: request,
      summary: `Changed plan from ${before.planName} (${before.interval}ly) to ${subscription.planName} (${subscription.interval}ly)`,
      detail: { from: { plan: before.plan, interval: before.interval }, to: { plan, interval } },
    });
    return NextResponse.json({ subscription });
  }

  if (action === "cancel") {
    const subscription = await provider.cancel(restaurantId, {
      reason: typeof body?.reason === "string" ? body.reason.slice(0, 500) : undefined,
      // Immediate cancellation is possible but never the default: a
      // restaurant that has paid through the month keeps its service.
      immediate: body?.immediate === true,
    });
    await audit({
      restaurantId, action: "plan.cancel", req: request,
      summary: subscription.cancelAtPeriodEnd
        ? `Scheduled cancellation for the end of the current period`
        : `Cancelled the subscription immediately`,
      detail: { reason: body?.reason ?? null },
    });
    return NextResponse.json({ subscription });
  }

  if (action === "resume") {
    const subscription = await provider.resume(restaurantId);
    await audit({ restaurantId, action: "plan.resume", summary: "Kept the subscription running", req: request });
    return NextResponse.json({ subscription });
  }

  if (action === "update_contact") {
    const contact = body?.contact ?? null;
    const subscription = await provider.updateContact(restaurantId, contact);
    await audit({ restaurantId, action: "billing.contact_updated", summary: "Updated billing contact details", req: request });
    return NextResponse.json({ subscription });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
