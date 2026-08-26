"use client";

// app/(console)/analysis/page.tsx — every shift this restaurant has ever run.
//
// The page is ordered the way an owner actually reads it: what changed
// (growth), then how the room performed (metrics), then why (patterns and
// menu), then the raw shifts underneath for anyone who wants to check the
// working. Metrics that cannot be computed yet are shown in place, greyed,
// naming the source they are waiting on — never as a zero.
import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Button, Card, Chip, Delta, Empty, LineChart, MetricCard, SectionHeading,
} from "@/components/ui";
import { GROUP_LABELS, type AnalysisResult, type MetricGroup } from "@/lib/analytics/types";
import { dateLabel, decimal, delta as fmtDelta, integer, minutes, money, percent, periodLabel, shortDate } from "@/lib/format";

const RANGES = [
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "365d", label: "12 months" },
  { key: "all", label: "All time" },
] as const;

const GROUP_ORDER: MetricGroup[] = ["volume", "money", "throughput", "reliability", "guests", "forecast"];

export default function AnalysisPage() {
  const [range, setRange] = useState<string>("90d");
  const [data, setData] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shiftLimit, setShiftLimit] = useState(60);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setShiftLimit(60);
    fetch(`/api/analysis?range=${range}`)
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not load.");
        return response.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [range]);

  const byGroup = useMemo(() => {
    const map = new Map<MetricGroup, AnalysisResult["metrics"]>();
    for (const metric of data?.metrics ?? []) {
      if (!map.has(metric.group)) map.set(metric.group, []);
      map.get(metric.group)!.push(metric);
    }
    return map;
  }, [data]);

  return (
    <div className="space-y-8" style={{ gap: "var(--section-gap)" }}>
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="tv-label">Analysis</p>
          <h1 className="tv-heading text-ink-50 mt-1" style={{ fontSize: "calc(var(--heading-size) * 1.3)" }}>
            {data ? data.range.label : "…"}
          </h1>
          {data ? (
            <p className="text-sm text-ink-400 mt-1">
              {data.range.from} to {data.range.to} · {integer(data.coverage.serviceDays)} service days
              {data.coverage.firstServiceDate
                ? ` · history from ${dateLabel(data.coverage.firstServiceDate)}`
                : ""}
              {data.coverage.importedReservations > 0
                ? ` · ${integer(data.coverage.importedReservations)} imported records included`
                : ""}
            </p>
          ) : null}
        </div>
        <div className="tv-no-print flex gap-1">
          {RANGES.map((option) => (
            <Button
              key={option.key}
              tone={range === option.key ? "primary" : "default"}
              onClick={() => setRange(option.key)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </header>

      {error ? <Empty>{error}</Empty> : null}
      {loading && !data ? <p className="text-sm text-ink-400">Reading the history…</p> : null}

      {data ? (
        <>
          {data.coverage.gaps.length > 0 ? (
            <section className="space-y-2">
              {data.coverage.gaps.map((gap) => (
                <Card key={gap.source} className="border-l-2 border-l-ai">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Chip tone="accent">{gap.source}</Chip>
                    <span className="text-sm text-ink-200">{gap.note}</span>
                  </div>
                  <p className="text-xs text-ink-400 mt-2">
                    Waiting on this: {gap.blocks.join(" · ")}
                  </p>
                </Card>
              ))}
            </section>
          ) : null}

          <Growth data={data} />

          {GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => (
            <section key={group}>
              <SectionHeading title={GROUP_LABELS[group]} />
              <div className="tv-metric-grid">
                {byGroup.get(group)!.map((metric) => (
                  <MetricCard key={metric.key} metric={metric} />
                ))}
              </div>
            </section>
          ))}

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <SectionHeading title="Covers by month" note="Every month on record, imported history included." />
              <LineChart
                points={data.series.monthlyCovers}
                format={(value) => `${integer(value)} covers`}
                partialLast={lastMonthPartial(data)}
              />
            </Card>
            <Card>
              <SectionHeading
                title="Revenue by month"
                note="Starts the month the POS went live — earlier months have covers but no money."
              />
              {data.series.monthlyRevenue.length ? (
                <LineChart
                  points={data.series.monthlyRevenue}
                  format={(value) => money(value)}
                  partialLast={lastMonthPartial(data)}
                />
              ) : (
                <Empty>No POS revenue recorded yet.</Empty>
              )}
            </Card>
          </section>

          <MonthTable data={data} />

          <MenuMix data={data} />

          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <SectionHeading title="Covers by day" />
              <BarChart points={data.series.dayOfWeek} format={(value) => integer(value)} height={160} />
            </Card>
            <Card>
              <SectionHeading title="Covers by hour" note="Where the room actually fills, in your own clock." />
              <BarChart points={data.series.hourly} format={(value) => integer(value)} height={160} />
            </Card>
            <Card>
              <SectionHeading title="Parties by size" />
              <BarChart points={data.series.partySize} format={(value) => integer(value)} height={160} />
            </Card>
            <Card>
              <SectionHeading
                title="Turn time by party size"
                note="What each size actually costs you in table minutes — the number to price a large-party policy against."
              />
              <BarChart points={data.series.turnByPartySize} format={(value) => minutes(value)} height={160} />
            </Card>
          </section>

          <Staff data={data} />

          <section>
            <SectionHeading
              title="Every shift"
              note={`${integer(data.shifts.length)} service periods in this window, newest first.`}
            />
            <div className="tv-card tv-panel overflow-x-auto p-0">
              <table className="tv-table w-full text-sm min-w-[900px]">
                <thead>
                  <tr className="border-b border-border">
                    <th className="pl-3">Date</th>
                    <th>Service</th>
                    <th className="text-right">Covers</th>
                    <th className="text-right">Parties</th>
                    <th className="text-right">Avg size</th>
                    <th className="text-right">Turn</th>
                    <th className="text-right">Walk-ins</th>
                    <th className="text-right">No-shows</th>
                    <th className="text-right">Revenue</th>
                    <th className="text-right pr-3">Avg bill</th>
                  </tr>
                </thead>
                <tbody>
                  {data.shifts.slice(0, shiftLimit).map((shift) => (
                    <tr key={`${shift.date}-${shift.period}`} className="border-b border-border/60 last:border-0">
                      <td className="pl-3 text-ink-200 whitespace-nowrap">
                        {shortDate(shift.date)}
                        {shift.imported ? <span className="ml-1.5 text-[10px] text-ink-400/70">imported</span> : null}
                      </td>
                      <td className="text-ink-400">{periodLabel(shift.period)}</td>
                      <td className="text-right text-ink-50">{integer(shift.covers)}</td>
                      <td className="text-right text-ink-200">{integer(shift.parties)}</td>
                      <td className="text-right text-ink-200">{decimal(shift.avgPartySize, 1)}</td>
                      <td className="text-right text-ink-200">{minutes(shift.avgTurnMinutes)}</td>
                      <td className="text-right text-ink-400">{integer(shift.walkInParties)}</td>
                      <td className="text-right text-ink-400">{shift.noShows || "—"}</td>
                      <td className="text-right text-ink-50">{shift.revenueCents == null ? "—" : money(shift.revenueCents)}</td>
                      <td className="text-right pr-3 text-ink-200">{shift.avgCheckCents == null ? "—" : money(shift.avgCheckCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.shifts.length > shiftLimit ? (
              <div className="tv-no-print mt-3 flex justify-center">
                <Button onClick={() => setShiftLimit((value) => value + 120)}>
                  Show more ({integer(data.shifts.length - shiftLimit)} remaining)
                </Button>
              </div>
            ) : null}
          </section>

          <p className="text-xs text-ink-400/70">
            Generated {new Date(data.generatedAt).toLocaleString()} from {integer(data.coverage.reservations)} reservations
            {data.coverage.closedChecks > 0 ? ` and ${integer(data.coverage.closedChecks)} closed checks` : ""}.
          </p>
        </>
      ) : null}
    </div>
  );
}

/** Is the newest month in the series still running? The month table
 *  already carries a `complete` flag per month; reuse it rather than
 *  re-deriving "is it the current month" in the browser's timezone. */
function lastMonthPartial(data: AnalysisResult): boolean {
  const newest = data.growth.monthTable[0];
  return newest ? !newest.complete : false;
}

function Growth({ data }: { data: AnalysisResult }) {
  const cells = [
    { label: "Covers, month over month", pct: data.growth.coversMoM, goodWhen: "up" as const },
    { label: "Covers, year over year", pct: data.growth.coversYoY, goodWhen: "up" as const },
    { label: "Revenue, month over month", pct: data.growth.revenueMoM, goodWhen: "up" as const },
    { label: "Revenue, year over year", pct: data.growth.revenueYoY, goodWhen: "up" as const },
  ];
  return (
    <section>
      <SectionHeading
        title="Growth"
        note="Measured from the last complete month. A month still in progress is never compared against a finished one."
      />
      <div className="tv-metric-grid">
        {cells.map((cell) => (
          <Card key={cell.label} panel={false} className={cell.pct == null ? "tv-missing" : ""}>
            <span className="tv-label">{cell.label}</span>
            <p className="tv-metric mt-2 text-ink-50">{cell.pct == null ? "—" : fmtDelta(cell.pct)}</p>
            {cell.pct == null ? (
              <p className="text-xs text-ink-400 mt-2">No comparable prior period on record.</p>
            ) : null}
          </Card>
        ))}
      </div>
    </section>
  );
}

function MonthTable({ data }: { data: AnalysisResult }) {
  if (!data.growth.monthTable.length) return null;
  return (
    <section>
      <SectionHeading title="Month by month" note="Each month against the same month last year." />
      <div className="tv-card tv-panel overflow-x-auto p-0">
        <table className="tv-table w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-border">
              <th className="pl-3">Month</th>
              <th className="text-right">Covers</th>
              <th className="text-right">Last year</th>
              <th className="text-right">Change</th>
              <th className="text-right">Revenue</th>
              <th className="text-right">Last year</th>
              <th className="text-right pr-3">Change</th>
            </tr>
          </thead>
          <tbody>
            {data.growth.monthTable.map((row) => (
              <tr key={row.month} className="border-b border-border/60 last:border-0">
                <td className="pl-3 text-ink-200 whitespace-nowrap">
                  {row.label}
                  {!row.complete ? (
                    <span className="ml-2 text-[10px] text-state-dining">in progress</span>
                  ) : null}
                </td>
                <td className="text-right text-ink-50">{integer(row.covers)}</td>
                <td className="text-right text-ink-400">{row.coversPrior == null ? "—" : integer(row.coversPrior)}</td>
                <td className="text-right">
                  {row.complete ? <Delta pct={row.coversDeltaPct} goodWhen="up" /> : <span className="text-ink-400/60 text-xs">—</span>}
                </td>
                <td className="text-right text-ink-50">{row.revenueCents == null ? "—" : money(row.revenueCents)}</td>
                <td className="text-right text-ink-400">{row.revenuePriorCents == null ? "—" : money(row.revenuePriorCents)}</td>
                <td className="text-right pr-3">
                  {row.complete ? <Delta pct={row.revenueDeltaPct} goodWhen="up" /> : <span className="text-ink-400/60 text-xs">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const QUADRANT_COPY = {
  star: { tone: "good" as const, label: "star", note: "Popular and high-priced. Protect these." },
  plowhorse: { tone: "warn" as const, label: "plowhorse", note: "Popular but cheap. Candidates for a price test." },
  puzzle: { tone: "accent" as const, label: "puzzle", note: "High-priced but rarely ordered. Reposition or describe better." },
  dog: { tone: "neutral" as const, label: "dog", note: "Neither popular nor high-priced." },
};

function MenuMix({ data }: { data: AnalysisResult }) {
  const mix = data.menuMix;
  return (
    <section>
      <SectionHeading
        title="Menu"
        note="Quadrants use price as a stand-in for margin, because the Console has no food-cost data — read them as a prompt, not a verdict."
      />
      {mix.available === "awaiting_pos" ? (
        <Card className="tv-missing">
          <p className="text-sm text-ink-200">{mix.reason}</p>
          {mix.neverSold.length ? (
            <p className="text-xs text-ink-400 mt-3">
              {mix.neverSold.length} items are on the menu and have never appeared on a closed check:{" "}
              {mix.neverSold.slice(0, 8).map((item) => item.name).join(", ")}
              {mix.neverSold.length > 8 ? "…" : ""}
            </p>
          ) : null}
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <SectionHeading title="Most sold" />
            <ItemList rows={mix.top} />
          </Card>
          <Card>
            <SectionHeading title="Least sold" />
            <ItemList rows={mix.bottom} />
          </Card>
          <Card>
            <SectionHeading title="Never sold" note="On the menu, never rung in." />
            {mix.neverSold.length === 0 ? (
              <Empty>Everything on the menu has sold at least once.</Empty>
            ) : (
              <ul className="text-sm space-y-1">
                {mix.neverSold.map((item) => (
                  <li key={item.name} className="flex justify-between gap-3">
                    <span className="text-ink-200 truncate">{item.name}</span>
                    <span className="text-ink-400 tabular-nums shrink-0">{money(item.priceCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </section>
  );
}

function ItemList({ rows }: { rows: AnalysisResult["menuMix"]["top"] }) {
  if (!rows.length) return <Empty>Nothing sold in this window.</Empty>;
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.name} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0">
            <span className="block text-ink-50 truncate">{row.name}</span>
            <span className="block text-[11px] text-ink-400">
              {money(row.revenueCents)} · {percent(row.sharePct)} of items sold
            </span>
          </span>
          <span className="shrink-0 text-right">
            <span className="block tabular-nums text-ink-200">{integer(row.quantity)}</span>
            <span className="block mt-0.5" title={QUADRANT_COPY[row.quadrant].note}>
              <Chip tone={QUADRANT_COPY[row.quadrant].tone}>{QUADRANT_COPY[row.quadrant].label}</Chip>
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Staff({ data }: { data: AnalysisResult }) {
  if (!data.staff.length) return null;
  return (
    <section>
      <SectionHeading
        title="By server"
        note="Covers and turn time come from the floor; average bill joins in from the POS."
      />
      <div className="tv-card tv-panel overflow-x-auto p-0">
        <table className="tv-table w-full text-sm min-w-[560px]">
          <thead>
            <tr className="border-b border-border">
              <th className="pl-3">Server</th>
              <th className="text-right">Shifts</th>
              <th className="text-right">Covers</th>
              <th className="text-right">Parties</th>
              <th className="text-right">Avg turn</th>
              <th className="text-right pr-3">Avg bill</th>
            </tr>
          </thead>
          <tbody>
            {data.staff.map((row) => (
              <tr key={row.serverId} className="border-b border-border/60 last:border-0">
                <td className="pl-3 text-ink-50">{row.name}</td>
                <td className="text-right text-ink-400">{integer(row.shifts)}</td>
                <td className="text-right text-ink-50">{integer(row.covers)}</td>
                <td className="text-right text-ink-200">{integer(row.parties)}</td>
                <td className="text-right text-ink-200">{minutes(row.avgTurnMinutes)}</td>
                <td className="text-right pr-3 text-ink-200">{row.avgCheckCents == null ? "—" : money(row.avgCheckCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
