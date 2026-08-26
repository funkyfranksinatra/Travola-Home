"use client";

// app/(home)/billing/page.tsx — plan, invoices, and leaving.
//
// The cancellation flow is deliberately not hidden and not made painful.
// It asks one question (why), states plainly what stops working and when,
// and defaults to end-of-period rather than immediate — a restaurant that
// has paid through the month keeps its floor plan through the month. An
// owner who trusts they can leave is an owner who stays.
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Empty, Field, PageHeader, SectionHeading, inputClass } from "@/components/ui";
import { dateLabel, money } from "@/lib/format";
import type { InvoiceView, Plan, SubscriptionView } from "@/lib/billing";

type Payload = { subscription: SubscriptionView; invoices: InvoiceView[]; plans: Plan[] };

export default function BillingPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(() => {
    fetch("/api/billing")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not load.");
        return response.json();
      })
      .then((payload: Payload) => {
        setData(payload);
        setInterval(payload.subscription.interval);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/billing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setError(payload.error ?? "That did not work.");
      return;
    }
    load();
  }

  if (error && !data) return <Empty>{error}</Empty>;
  if (!data) return <p className="text-sm text-ink-400">Loading…</p>;

  const sub = data.subscription;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Plan & billing"
        title={sub.planName}
        note={`${money(sub.priceCents)} per ${sub.interval}${
          sub.currentPeriodEnd ? ` · current period ends ${dateLabel(sub.currentPeriodEnd.slice(0, 10))}` : ""
        }`}
        right={
          <div className="flex gap-2 flex-wrap">
            <Chip tone={sub.status === "active" || sub.status === "trialing" ? "good" : sub.status === "past_due" ? "bad" : "neutral"}>
              {sub.status === "trialing" ? "trial" : sub.status.replace("_", " ")}
            </Chip>
            {sub.cancelAtPeriodEnd ? <Chip tone="warn">cancels at period end</Chip> : null}
          </div>
        }
      />

      {error ? <p className="text-sm text-state-seated">{error}</p> : null}

      {sub.simulated ? (
        <Card className="p-5 border-l-2 border-l-ai">
          <p className="text-sm text-ink-200">
            No payment processor is connected, so nothing is charged and no card is stored. Everything on this page is
            real and recorded — plan changes, cancellations, invoices — it just does not move money yet. Connecting a
            processor later changes one file and none of this screen.
          </p>
        </Card>
      ) : null}

      {sub.cancelAtPeriodEnd ? (
        <Card className="p-5 border-l-2 border-l-state-dining">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm text-ink-50">
                Cancelling{sub.currentPeriodEnd ? ` on ${dateLabel(sub.currentPeriodEnd.slice(0, 10))}` : ""}.
              </p>
              <p className="text-xs text-ink-400 mt-1">
                Until then everything keeps working. After that the floor manager and the POS stop accepting sign-ins.
                Your data stays and can be exported.
              </p>
            </div>
            <Button tone="primary" disabled={busy} onClick={() => act({ action: "resume" })}>
              Keep my subscription
            </Button>
          </div>
        </Card>
      ) : null}

      <section>
        <SectionHeading
          title="Plans"
          action={
            <div className="flex gap-1">
              <Button tone={interval === "month" ? "primary" : "default"} onClick={() => setInterval("month")}>Monthly</Button>
              <Button tone={interval === "year" ? "primary" : "default"} onClick={() => setInterval("year")}>Yearly</Button>
            </div>
          }
          note="Yearly is billed as ten months — two free."
        />
        <div className="grid gap-4 lg:grid-cols-3">
          {data.plans.map((plan) => {
            const current = plan.key === sub.plan && interval === sub.interval;
            const price = interval === "year" ? plan.yearlyCents : plan.monthlyCents;
            return (
              <Card key={plan.key} className={current ? "border-ai" : ""}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-lg font-semibold tracking-tight text-ink-50">{plan.name}</span>
                  {current ? <Chip tone="accent">current</Chip> : null}
                </div>
                <p className="text-sm text-ink-400 mt-1">{plan.blurb}</p>
                <p className="figure-sm text-ink-50 mt-3">
                  {money(price)}
                  <span className="text-sm text-ink-400 font-normal"> /{interval}</span>
                </p>
                <ul className="mt-3 space-y-1 text-sm text-ink-200">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2">
                      <span className="text-state-avail shrink-0">·</span>
                      <span>{feature}</span>
                    </li>
                  ))}
                  {plan.limits.map((limit) => (
                    <li key={limit} className="flex gap-2 text-ink-400">
                      <span className="shrink-0">·</span>
                      <span>{limit}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4">
                  <Button
                    tone={current ? "ghost" : "primary"}
                    disabled={busy || current}
                    onClick={() => act({ action: "change_plan", plan: plan.key, interval })}
                    className="w-full"
                  >
                    {current ? "Your plan" : plan.key === sub.plan ? `Switch to ${interval}ly` : `Move to ${plan.name}`}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <BillingContact contact={sub.billingContact} busy={busy} onSave={(contact) => act({ action: "update_contact", contact })} />

      <section>
        <SectionHeading title="Invoices" />
        {data.invoices.length === 0 ? (
          <Empty>No invoices have been issued yet.</Empty>
        ) : (
          <div className="card overflow-x-auto">
            <table className="data-table text-sm min-w-[560px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="pl-3">Issued</th>
                  <th>Number</th>
                  <th>Period</th>
                  <th>Status</th>
                  <th className="text-right pr-3">Total</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((invoice) => (
                  <tr key={invoice.id} className="border-b border-border/60 last:border-0">
                    <td className="pl-3 text-ink-200">{dateLabel(invoice.issuedAt.slice(0, 10))}</td>
                    <td className="text-ink-400">{invoice.number}</td>
                    <td className="text-ink-400">
                      {invoice.periodStart && invoice.periodEnd
                        ? `${invoice.periodStart.slice(0, 10)} → ${invoice.periodEnd.slice(0, 10)}`
                        : "—"}
                    </td>
                    <td><Chip tone={invoice.status === "paid" ? "good" : "warn"}>{invoice.status}</Chip></td>
                    <td className="text-right pr-3 text-ink-50">{money(invoice.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!sub.cancelAtPeriodEnd && sub.status !== "canceled" ? (
        <section>
          <SectionHeading title="Cancel" />
          {cancelling ? (
            <Card className="p-5 space-y-3">
              <p className="text-sm text-ink-200">
                Your subscription will run to the end of the current period
                {sub.currentPeriodEnd ? ` (${dateLabel(sub.currentPeriodEnd.slice(0, 10))})` : ""} and then stop. The
                floor manager and the POS stop accepting sign-ins at that point. Your data is not deleted — export it
                any time from the Data tab.
              </p>
              <Field label="What made you cancel?" hint="Optional, and it genuinely gets read.">
                <input className={inputClass} value={reason} onChange={(event) => setReason(event.target.value)} />
              </Field>
              <div className="flex gap-2 flex-wrap">
                <Button tone="danger" disabled={busy} onClick={() => { act({ action: "cancel", reason }); setCancelling(false); }}>
                  Cancel at period end
                </Button>
                <Button tone="ghost" onClick={() => setCancelling(false)}>Never mind</Button>
              </div>
            </Card>
          ) : (
            <Button tone="ghost" onClick={() => setCancelling(true)}>Cancel my subscription</Button>
          )}
        </section>
      ) : null}
    </div>
  );
}

function BillingContact({ contact, busy, onSave }: {
  contact: SubscriptionView["billingContact"];
  busy: boolean;
  onSave: (contact: NonNullable<SubscriptionView["billingContact"]>) => void;
}) {
  const [form, setForm] = useState(() => ({
    name: contact?.name ?? "", email: contact?.email ?? "", phone: contact?.phone ?? "",
    line1: contact?.line1 ?? "", line2: contact?.line2 ?? "", city: contact?.city ?? "",
    region: contact?.region ?? "", postal: contact?.postal ?? "", country: contact?.country ?? "",
  }));
  const [open, setOpen] = useState(false);

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((value) => ({ ...value, [key]: event.target.value }));

  return (
    <section>
      <SectionHeading
        title="Billing details"
        note="Printed on every invoice. Stored as a snapshot, so changing it does not rewrite invoices already issued."
        action={<Button tone="ghost" onClick={() => setOpen((value) => !value)}>{open ? "Close" : "Edit"}</Button>}
      />
      {!open ? (
        <Card className="p-5 p-5">
          {contact?.name || contact?.email ? (
            <p className="text-sm text-ink-200">
              {[contact?.name, contact?.email, contact?.line1, contact?.city, contact?.region, contact?.postal]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : (
            <p className="text-sm text-ink-400">No billing details on file yet.</p>
          )}
        </Card>
      ) : (
        <Card className="p-5 grid gap-3 sm:grid-cols-2">
          <Field label="Billing name"><input className={inputClass} value={form.name} onChange={set("name")} /></Field>
          <Field label="Email"><input className={inputClass} value={form.email} onChange={set("email")} type="email" /></Field>
          <Field label="Phone"><input className={inputClass} value={form.phone} onChange={set("phone")} /></Field>
          <Field label="Address"><input className={inputClass} value={form.line1} onChange={set("line1")} /></Field>
          <Field label="Address line 2"><input className={inputClass} value={form.line2} onChange={set("line2")} /></Field>
          <Field label="City"><input className={inputClass} value={form.city} onChange={set("city")} /></Field>
          <Field label="State / region"><input className={inputClass} value={form.region} onChange={set("region")} /></Field>
          <Field label="Postal code"><input className={inputClass} value={form.postal} onChange={set("postal")} /></Field>
          <div className="sm:col-span-2">
            <Button tone="primary" disabled={busy} onClick={() => { onSave(form); setOpen(false); }}>Save details</Button>
          </div>
        </Card>
      )}
    </section>
  );
}
