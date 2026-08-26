"use client";

// app/(console)/page.tsx — the plan view.
//
// Ordered the way an owner actually reads it: what needs a decision, then
// the room, then how the last month went. The floor plan is given the most
// space on the page deliberately — it is the thing an owner recognises as
// theirs, and recognising it is what makes the figures beside it land as
// being about their restaurant rather than about a spreadsheet.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Delta, Empty, StatTile } from "@/components/charts";
import { PageHeader } from "@/components/ui";
import { FloorPlan, type PlanTable } from "@/components/FloorPlan";
import { dateLabel, formatMetric, integer, money } from "@/lib/format";
import type { Metric, SeriesPoint } from "@/lib/analytics/types";
import type { SubscriptionView, InvoiceView } from "@/lib/billing";

type Overview = {
  restaurant: { name: string; recoveryEmail: string | null; since: string | null };
  subscription: SubscriptionView;
  recentInvoices: InvoiceView[];
  floor: { staffCount: number; tableCount: number; seatCount: number; floorCount: number; openChecks: number; lastServiceDate: string | null };
  tables: PlanTable[];
  headline: {
    rangeLabel: string;
    metrics: Metric[];
    dailyCovers: SeriesPoint[];
    gaps: Array<{ source: string; blocks: string[]; note: string }>;
    coverage: { serviceDays: number; reservations: number; closedChecks: number };
  };
  nextForecast: null | { date: string; expectedCovers: number | null; low: number | null; high: number | null; confidence: string };
  security: { adminPasscodeSet: boolean };
  links: { floor: string; pos: string };
};

const GOOD_WHEN: Record<string, "up" | "down" | "neutral"> = {
  covers: "up", revenue: "up", avg_check: "up",
  turn_time: "down", no_show_rate: "down", avg_party: "neutral",
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
  if (!data) return <Skeleton />;

  const spark = data.headline.dailyCovers.map((point) => point.value);
  const metric = (key: string) => data.headline.metrics.find((m) => m.key === key);

  return (
    <div className="flex flex-col gap-6">
      <Hero data={data} />
      <Attention data={data} />

      <section className="grid gap-5 lg:grid-cols-5">
        <div className="lg:col-span-3 card p-5">
          <div className="flex items-baseline justify-between gap-4 mb-4">
            <div>
              <p className="label">Your room</p>
              <h2 className="text-lg font-semibold text-ink-50 mt-1 tracking-tight">Floor plan</h2>
            </div>
            {data.links.floor ? (
              <a href={data.links.floor} target="_blank" rel="noreferrer" className="text-sm text-ai hover:underline shrink-0">
                Edit in floor manager ↗
              </a>
            ) : null}
          </div>
          <FloorPlan tables={data.tables} />
        </div>

        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="card p-5">
            <p className="label">Tonight</p>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4">
              <Mini label="Tables" value={integer(data.floor.tableCount)} />
              <Mini label="Seats" value={integer(data.floor.seatCount)} />
              <Mini label="Staff with access" value={integer(data.floor.staffCount)} href="/staff" />
              <Mini label="Checks open" value={integer(data.floor.openChecks)} />
            </div>
          </div>

          <ForecastCard data={data} />
          <QuickActions data={data} />
        </div>
      </section>

      <section>
        <div className="flex items-baseline justify-between gap-4 mb-3">
          <h2 className="text-lg font-semibold text-ink-50 tracking-tight">
            Last 30 days
          </h2>
          <Link href="/analysis" className="text-sm text-ai hover:underline">Full analysis →</Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {["covers", "avg_check", "turn_time", "no_show_rate"].map((key) => {
            const found = metric(key);
            if (!found) return null;
            return (
              <StatTile
                key={key}
                label={found.label}
                value={formatMetric(found)}
                delta={found.trend?.pct ?? null}
                goodWhen={GOOD_WHEN[key] ?? "neutral"}
                spark={key === "covers" ? spark : undefined}
                awaiting={found.available === "awaiting_pos" ? found.reason : null}
                hint={found.hint}
                footnote={found.available === "partial" ? found.reason : undefined}
              />
            );
          })}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        <PlanCard data={data} />
        <div className="lg:col-span-2 card p-5">
          <div className="flex items-baseline justify-between gap-4 mb-3">
            <h2 className="text-lg font-semibold text-ink-50 tracking-tight">Recent invoices</h2>
            <Link href="/billing" className="text-sm text-ai hover:underline">All invoices →</Link>
          </div>
          {data.recentInvoices.length === 0 ? (
            <Empty>No invoices issued yet.</Empty>
          ) : (
            <table className="data-table text-sm">
              <thead>
                <tr>
                  <th>Issued</th>
                  <th>Number</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {data.recentInvoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="text-ink-300">{dateLabel(invoice.issuedAt.slice(0, 10))}</td>
                    <td className="text-ink-400">{invoice.number}</td>
                    <td className="text-ink-50" style={{ textAlign: "right" }}>{money(invoice.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}

function Hero({ data }: { data: Overview }) {
  const covers = data.headline.metrics.find((m) => m.key === "covers");
  return (
    <PageHeader
      eyebrow="Overview"
      title={data.restaurant.name}
      note={
        (data.floor.lastServiceDate
          ? `Last service recorded ${dateLabel(data.floor.lastServiceDate)}`
          : "No service recorded yet") +
        (data.headline.coverage.reservations > 0
          ? ` · ${integer(data.headline.coverage.reservations)} reservations on record`
          : "")
      }
      right={
        covers?.value != null ? (
          <div className="text-right">
            <p className="label">Covers, last 30 days</p>
            <p className="mt-1.5 flex items-end justify-end gap-3">
              <span className="figure text-ink-50">{formatMetric(covers)}</span>
              <span className="pb-1">
                <Delta pct={covers.trend?.pct ?? null} goodWhen="up" basis={covers.trend?.basis} size="lg" />
              </span>
            </p>
          </div>
        ) : null
      }
    />
  );
}

/** The four things an owner most often opens this page to do. Placed in
 *  the column beside the room rather than hidden behind a menu, and it
 *  keeps that column from ending in dead space. */
function QuickActions({ data }: { data: Overview }) {
  const actions = [
    { label: "Open the POS", hint: "Orders, kitchen, checks", href: data.links.pos, external: true },
    { label: "Open the floor manager", hint: "Reservations, waitlist, sections", href: data.links.floor, external: true },
    { label: "Export your data", hint: "One CSV per table", href: "/data", external: false },
    { label: "Manage logins", hint: "Staff PINs and codes", href: "/staff", external: false },
  ].filter((action) => action.href);

  if (!actions.length) return null;

  return (
    <div className="card p-2">
      <p className="label px-3 pt-2.5 pb-1.5">Jump to</p>
      <ul>
        {actions.map((action) => (
          <li key={action.label}>
            {action.external ? (
              <a
                href={action.href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 hover:bg-panel-up"
              >
                <span className="min-w-0">
                  <span className="block text-sm text-ink-50">{action.label}</span>
                  <span className="block text-[11px] text-ink-400">{action.hint}</span>
                </span>
                <span className="text-ai shrink-0" aria-hidden="true">↗</span>
              </a>
            ) : (
              <Link
                href={action.href}
                className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 hover:bg-panel-up"
              >
                <span className="min-w-0">
                  <span className="block text-sm text-ink-50">{action.label}</span>
                  <span className="block text-[11px] text-ink-400">{action.hint}</span>
                </span>
                <span className="text-ai shrink-0" aria-hidden="true">→</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ForecastCard({ data }: { data: Overview }) {
  const forecast = data.nextForecast;
  if (!forecast?.expectedCovers) {
    return (
      <div className="card p-5">
        <p className="label">Next forecast</p>
        <p className="text-sm text-ink-400 mt-3 leading-relaxed">
          No forecast has been published for the days ahead. They are generated by the floor app&rsquo;s shift
          intelligence.
        </p>
        <Link href="/predictions" className="inline-block mt-3 text-sm text-ai hover:underline">
          See predictions →
        </Link>
      </div>
    );
  }
  const { low, high, expectedCovers } = forecast;
  const span = low != null && high != null && high > low ? high - low : null;
  const position = span ? ((expectedCovers - (low as number)) / span) * 100 : 50;
  return (
    <div className="card card-lit p-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="label">Next forecast</p>
        <span className="text-[11px] text-ink-400">{dateLabel(forecast.date)}</span>
      </div>
      <p className="figure text-ink-50 mt-2.5">{integer(expectedCovers)}<span className="text-base font-normal text-ink-400 ml-2">covers</span></p>
      {span ? (
        <div className="mt-4">
          {/* The band is the forecast. Showing only the midpoint would
              claim a precision the model does not have. */}
          <div className="relative h-1.5 rounded-full bg-panel-up overflow-hidden">
            <span className="absolute inset-y-0 left-0 right-0 bg-viz-band" style={{ background: "linear-gradient(90deg, var(--color-ai-muted), var(--color-ai-bg), var(--color-ai-muted))" }} />
            <span className="absolute top-1/2 w-2.5 h-2.5 rounded-full bg-ai -translate-y-1/2 -translate-x-1/2" style={{ left: `${Math.max(4, Math.min(96, position))}%` }} />
          </div>
          <p className="flex justify-between text-[11px] text-ink-400 mt-1.5 tabular-nums">
            <span>{integer(low)}</span>
            <span>likely range</span>
            <span>{integer(high)}</span>
          </p>
        </div>
      ) : null}
      <Link href="/predictions" className="inline-block mt-4 text-sm text-ai hover:underline">
        The week ahead →
      </Link>
    </div>
  );
}

function PlanCard({ data }: { data: Overview }) {
  const sub = data.subscription;
  const trialing = sub.status === "trialing";
  return (
    <div className="card p-5">
      <div className="flex items-baseline justify-between gap-4 mb-3">
        <h2 className="text-lg font-semibold text-ink-50 tracking-tight">Plan</h2>
        <Link href="/billing" className="text-sm text-ai hover:underline">Manage →</Link>
      </div>
      <div className="flex items-baseline gap-2.5 flex-wrap">
        <span className="figure-sm text-ink-50">{sub.planName}</span>
        <Pill tone={sub.status === "active" || trialing ? "good" : sub.status === "past_due" ? "bad" : "neutral"}>
          {trialing ? "trial" : sub.status.replace("_", " ")}
        </Pill>
        {sub.cancelAtPeriodEnd ? <Pill tone="warn">cancels at period end</Pill> : null}
      </div>
      <p className="text-sm text-ink-400 mt-2">
        {money(sub.priceCents)} per {sub.interval}
        {sub.currentPeriodEnd ? ` · renews ${dateLabel(sub.currentPeriodEnd.slice(0, 10))}` : ""}
      </p>
      {sub.simulated ? (
        <p className="text-xs text-ink-400/80 mt-3 leading-relaxed">
          No payment processor is connected yet, so nothing is charged. Changes here are real and recorded — they
          just do not move money.
        </p>
      ) : null}
    </div>
  );
}

function Attention({ data }: { data: Overview }) {
  const items: Array<{ tone: "warn" | "bad" | "accent"; text: string; href?: string; cta?: string }> = [];

  if (!data.security.adminPasscodeSet) {
    items.push({
      tone: "warn",
      text: "No separate owner code is set — deleting data currently falls back to the four digits the whole floor uses.",
      href: "/staff", cta: "Set one",
    });
  }
  if (data.subscription.status === "past_due") {
    items.push({ tone: "bad", text: "The last payment did not go through.", href: "/billing", cta: "Fix billing" });
  }
  if (data.subscription.cancelAtPeriodEnd && data.subscription.currentPeriodEnd) {
    items.push({
      tone: "warn",
      text: `Your subscription ends ${dateLabel(data.subscription.currentPeriodEnd.slice(0, 10))}. After that the floor manager and the POS stop.`,
      href: "/billing", cta: "Keep it",
    });
  }
  if (data.subscription.status === "trialing" && data.subscription.trialEndsAt) {
    const days = Math.ceil((new Date(data.subscription.trialEndsAt).getTime() - Date.now()) / 86_400_000);
    if (days <= 10) {
      items.push({ tone: "accent", text: `${days} ${days === 1 ? "day" : "days"} left in your trial.`, href: "/billing", cta: "Choose a plan" });
    }
  }
  for (const gap of data.headline.gaps.slice(0, 1)) {
    items.push({ tone: "accent", text: gap.note, href: "/analysis", cta: "See what it blocks" });
  }
  if (data.tables.length === 0) {
    items.push({
      tone: "accent",
      text: "No floor plan yet — the room above is an example. Build yours in the floor manager and it appears here.",
      href: data.links.floor, cta: "Open floor manager",
    });
  }

  if (!items.length) return null;

  return (
    <section className="flex flex-col gap-2">
      {items.map((item, index) => (
        <div key={index} className="card px-4 py-3 flex items-center justify-between gap-4 flex-wrap border-l-2 border-l-ai">
          <span className="flex items-center gap-3 min-w-0">
            <Pill tone={item.tone}>{item.tone === "bad" ? "action needed" : "worth a look"}</Pill>
            <span className="text-sm text-ink-200">{item.text}</span>
          </span>
          {item.href ? (
            item.href.startsWith("http") ? (
              <a href={item.href} target="_blank" rel="noreferrer" className="text-sm text-ai hover:underline shrink-0">{item.cta} ↗</a>
            ) : (
              <Link href={item.href} className="text-sm text-ai hover:underline shrink-0">{item.cta} →</Link>
            )
          ) : null}
        </div>
      ))}
    </section>
  );
}

function Mini({ label, value, href }: { label: string; value: string; href?: string }) {
  const body = (
    <>
      <p className="label">{label}</p>
      <p className="figure-sm text-ink-50 mt-1.5">{value}</p>
    </>
  );
  return href ? <Link href={href} className="block hover:opacity-80">{body}</Link> : <div>{body}</div>;
}

export function Pill({ tone = "neutral", children }: { tone?: "neutral" | "good" | "bad" | "warn" | "accent"; children: React.ReactNode }) {
  const tones = {
    neutral: "bg-panel-up text-ink-200",
    good: "bg-state-availBg text-state-avail",
    bad: "bg-state-seatedBg text-state-seated",
    warn: "bg-state-diningBg text-state-dining",
    accent: "bg-ai-bg text-ai",
  } as const;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-6 animate-pulse">
      <div className="card h-32" />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 card h-[26rem]" />
        <div className="card h-[26rem]" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="card h-40" />)}
      </div>
    </div>
  );
}
