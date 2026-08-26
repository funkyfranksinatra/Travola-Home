"use client";

// app/(console)/page.tsx — the plan view.
//
// The answer to "what is going on and what do I need to deal with",
// above the fold, before any drilling. Everything here is either a status
// an owner should know without asking or a door into somewhere else.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Chip, Empty, SectionHeading } from "@/components/ui";
import { dateLabel, integer, money } from "@/lib/format";
import type { SubscriptionView, InvoiceView } from "@/lib/billing";

type Overview = {
  restaurant: { name: string; recoveryEmail: string | null; since: string | null };
  subscription: SubscriptionView;
  recentInvoices: InvoiceView[];
  floor: { staffCount: number; tableCount: number; openChecks: number; lastServiceDate: string | null };
  nextForecast: null | {
    date: string; source: string; expectedCovers: number | null;
    low: number | null; high: number | null; confidence: string;
  };
  security: { adminPasscodeSet: boolean; adminWindowMs: number };
  links: { floor: string; pos: string };
};

export default function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/overview")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not load.");
        return response.json();
      })
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) return <Empty>{error}</Empty>;
  if (!data) return <p className="text-sm text-ink-400">Loading…</p>;

  const sub = data.subscription;
  const trialing = sub.status === "trialing";

  return (
    <div className="space-y-8">
      <header>
        <p className="tv-label">Overview</p>
        <h1 className="tv-heading text-ink-50 mt-1" style={{ fontSize: "calc(var(--heading-size) * 1.3)" }}>
          {data.restaurant.name}
        </h1>
        <p className="text-sm text-ink-400 mt-1">
          {data.floor.lastServiceDate
            ? `Last service recorded ${dateLabel(data.floor.lastServiceDate)}.`
            : "No service recorded yet."}
        </p>
      </header>

      {/* Attention first: the things that are wrong or about to be. */}
      <Attention data={data} />

      <section>
        <SectionHeading title="Tonight" />
        <div className="tv-metric-grid">
          <Tile label="Tables in the room" value={integer(data.floor.tableCount)} />
          <Tile label="Staff with access" value={integer(data.floor.staffCount)} href="/staff" />
          <Tile label="Checks open now" value={integer(data.floor.openChecks)} />
          <Tile
            label="Forecast covers"
            value={data.nextForecast?.expectedCovers != null ? integer(data.nextForecast.expectedCovers) : "—"}
            note={
              data.nextForecast
                ? `${dateLabel(data.nextForecast.date)}${
                    data.nextForecast.low != null && data.nextForecast.high != null
                      ? ` · ${data.nextForecast.low}–${data.nextForecast.high}`
                      : ""
                  }`
                : "No forecast published"
            }
            href="/predictions"
          />
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionHeading
            title="Plan"
            action={<Link href="/billing" className="text-sm text-ai hover:underline">Manage →</Link>}
          />
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="tv-metric text-ink-50">{sub.planName}</span>
            <Chip tone={sub.status === "active" || trialing ? "good" : sub.status === "past_due" ? "bad" : "neutral"}>
              {trialing ? "trial" : sub.status.replace("_", " ")}
            </Chip>
            {sub.cancelAtPeriodEnd ? <Chip tone="warn">cancels at period end</Chip> : null}
          </div>
          <p className="text-sm text-ink-400 mt-2">
            {money(sub.priceCents)} per {sub.interval}
            {sub.currentPeriodEnd ? ` · renews ${dateLabel(sub.currentPeriodEnd.slice(0, 10))}` : ""}
          </p>
          {sub.simulated ? (
            <p className="text-xs text-ink-400/80 mt-3 leading-relaxed">
              No payment processor is connected yet, so nothing is charged. Plan changes and cancellations here are
              real and are recorded — they just do not move money until a processor is wired in.
            </p>
          ) : null}
        </Card>

        <Card>
          <SectionHeading
            title="Recent invoices"
            action={<Link href="/billing" className="text-sm text-ai hover:underline">All →</Link>}
          />
          {data.recentInvoices.length === 0 ? (
            <Empty>No invoices issued yet.</Empty>
          ) : (
            <table className="tv-table w-full text-sm">
              <tbody>
                {data.recentInvoices.map((invoice) => (
                  <tr key={invoice.id} className="border-t border-border first:border-0">
                    <td className="text-ink-400">{dateLabel(invoice.issuedAt.slice(0, 10))}</td>
                    <td className="text-ink-200">{invoice.number}</td>
                    <td className="text-right text-ink-50">{money(invoice.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </div>
  );
}

/** Only renders when something actually needs a decision. */
function Attention({ data }: { data: Overview }) {
  const items: Array<{ tone: "warn" | "bad" | "accent"; text: string; href?: string; cta?: string }> = [];

  if (!data.security.adminPasscodeSet) {
    items.push({
      tone: "warn",
      text: "No separate owner code is set. Deleting data currently falls back to the same four digits the whole floor uses to sign in.",
      href: "/staff",
      cta: "Set one",
    });
  }
  if (data.subscription.status === "past_due") {
    items.push({ tone: "bad", text: "The last payment did not go through.", href: "/billing", cta: "Fix billing" });
  }
  if (data.subscription.cancelAtPeriodEnd && data.subscription.currentPeriodEnd) {
    items.push({
      tone: "warn",
      text: `Your subscription ends ${dateLabel(data.subscription.currentPeriodEnd.slice(0, 10))}. After that the floor manager and the POS stop.`,
      href: "/billing",
      cta: "Keep it",
    });
  }
  if (data.subscription.status === "trialing" && data.subscription.trialEndsAt) {
    const daysLeft = Math.ceil((new Date(data.subscription.trialEndsAt).getTime() - Date.now()) / 86_400_000);
    if (daysLeft <= 10) {
      items.push({
        tone: "accent",
        text: `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left in your trial.`,
        href: "/billing",
        cta: "Choose a plan",
      });
    }
  }
  if (!data.links.floor || !data.links.pos) {
    items.push({
      tone: "accent",
      text: "The floor manager and POS links are not configured, so the launcher in the sidebar is inactive.",
    });
  }

  if (!items.length) return null;

  return (
    <section className="space-y-2">
      {items.map((item, index) => (
        <Card key={index} className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <Chip tone={item.tone}>{item.tone === "bad" ? "action needed" : "worth a look"}</Chip>
            <span className="text-sm text-ink-200">{item.text}</span>
          </div>
          {item.href ? (
            <Link href={item.href} className="text-sm text-ai hover:underline shrink-0">
              {item.cta} →
            </Link>
          ) : null}
        </Card>
      ))}
    </section>
  );
}

function Tile({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  const inner = (
    <Card panel={false} className={href ? "hover:border-border-hi h-full" : "h-full"}>
      <span className="tv-label">{label}</span>
      <p className="tv-metric text-ink-50 mt-2">{value}</p>
      {note ? <p className="text-xs text-ink-400 mt-1">{note}</p> : null}
    </Card>
  );
  return href ? <Link href={href} className="block">{inner}</Link> : inner;
}
