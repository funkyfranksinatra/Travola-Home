"use client";

// app/(home)/analysis/page.tsx — every shift this restaurant has run.
//
// Ordered the way an owner reads it: what changed, how the room performed,
// when it was busy, what sold, then the raw shifts underneath for anyone
// who wants to check the working.
//
// The rule the whole page is built on: never print a number the data
// cannot support. A metric with no source yet is shown in place, greyed,
// naming what it is waiting on — never as a zero.
import { useEffect, useMemo, useState } from "react";
import {
  AreaChart, Columns, Delta, Empty, Heatmap, RankedBars, Ring, StatTile, VIZ,
} from "@/components/charts";
import { Pill } from "../page";
import { PageHeader } from "@/components/ui";
import { GROUP_LABELS, type AnalysisResult, type MetricGroup } from "@/lib/analytics/types";
import {
  dateLabel, decimal, delta as fmtDelta, formatMetric, integer, minutes, money, percent, periodLabel, shortDate,
} from "@/lib/format";

const RANGES = [
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "365d", label: "12 months" },
  { key: "all", label: "All time" },
] as const;

/** Groups with enough metrics to fill a row of tiles. */
const HEADLINE_GROUPS: MetricGroup[] = ["volume", "money"];
/** Everything else, rendered as compact panels four across. */
const PANEL_GROUPS: MetricGroup[] = ["throughput", "reliability", "guests", "forecast"];

const GOOD_WHEN: Record<string, "up" | "down" | "neutral"> = {
  covers: "up", parties: "up", revenue: "up", avg_check: "up", median_check: "up",
  ppa: "up", tip_pct: "up", revpash: "up", repeat_rate: "up", repeat_covers: "up",
  seat_utilisation: "up", service_days: "neutral", avg_party: "neutral", walk_in_share: "neutral",
  vip_share: "neutral", turn_time: "down", seat_delay: "down", seat_to_order: "down",
  paid_to_clear: "down", quote_accuracy: "down", no_show_rate: "down",
  cancellation_rate: "down", walk_away_rate: "down", forecast_error: "down",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function AnalysisPage() {
  const [range, setRange] = useState<string>("90d");
  const [data, setData] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shiftLimit, setShiftLimit] = useState(40);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setShiftLimit(40);
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

  const heat = useMemo(() => {
    const cells = new Map<string, number>();
    for (const cell of data?.series.weekHeatmap ?? []) {
      cells.set(`${cell.dow}-${cell.hour}`, (cells.get(`${cell.dow}-${cell.hour}`) ?? 0) + cell.covers);
    }
    const hours = [...new Set((data?.series.weekHeatmap ?? []).map((c) => c.hour))].sort((a, b) => a - b);
    return { cells, hours };
  }, [data]);

  const partialLast = data ? !(data.growth.monthTable[0]?.complete ?? true) : false;

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Analysis"
        title={data ? data.range.label : "…"}
        note={
          data
            ? `${data.range.from} to ${data.range.to} · ${integer(data.coverage.serviceDays)} service days` +
              (data.coverage.firstServiceDate ? ` · history from ${dateLabel(data.coverage.firstServiceDate)}` : "") +
              (data.coverage.importedReservations > 0
                ? ` · ${integer(data.coverage.importedReservations)} imported records included`
                : "")
            : undefined
        }
        right={
          <div className="no-print flex rounded-xl bg-panel border border-border p-1">
            {RANGES.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => setRange(option.key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  range === option.key ? "bg-ai text-bg" : "text-ink-400 hover:text-ink-50"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        }
      />

      {error ? <Empty>{error}</Empty> : null}
      {loading && !data ? <Loading /> : null}

      {data ? (
        <>
          {data.coverage.gaps.length > 0 ? (
            <section className="flex flex-col gap-2">
              {data.coverage.gaps.map((gap) => (
                <div key={gap.source} className="card px-4 py-3 border-l-2 border-l-ai">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <Pill tone="accent">{gap.source}</Pill>
                    <span className="text-sm text-ink-200">{gap.note}</span>
                  </div>
                  <p className="text-xs text-ink-400 mt-2">Waiting on this: {gap.blocks.join(" · ")}</p>
                </div>
              ))}
            </section>
          ) : null}

          <Growth data={data} />

          {/* The two groups big enough to fill their rows get full tiles.
              The rest become compact panels — a four-column grid holding
              two metrics leaves a ragged half-row on every section, which
              is what makes a long page read as disjointed rather than as
              one document. */}
          {HEADLINE_GROUPS.filter((group) => byGroup.has(group)).map((group) => (
            <section key={group}>
              <SectionHead title={GROUP_LABELS[group]} />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {byGroup.get(group)!.map((metric) => (
                  <StatTile
                    key={metric.key}
                    label={metric.label}
                    value={formatMetric(metric)}
                    delta={metric.trend?.pct ?? null}
                    goodWhen={GOOD_WHEN[metric.key] ?? "neutral"}
                    awaiting={metric.available === "awaiting_pos" || metric.available === "insufficient" ? metric.reason ?? "No data yet." : null}
                    hint={metric.hint}
                    footnote={metric.available === "partial" ? metric.reason : undefined}
                  />
                ))}
              </div>
            </section>
          ))}

          <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4 items-start">
            {PANEL_GROUPS.filter((group) => byGroup.has(group)).map((group) => (
              <div key={group} className="card p-5">
                <h2 className="text-base font-semibold text-ink-50 tracking-tight mb-3">{GROUP_LABELS[group]}</h2>
                <ul className="flex flex-col">
                  {byGroup.get(group)!.map((metric) => {
                    const missing = metric.value == null;
                    return (
                      <li
                        key={metric.key}
                        className={`flex items-baseline justify-between gap-3 py-2.5 border-b border-border last:border-0 ${missing ? "awaiting" : ""}`}
                        title={metric.hint ?? metric.reason ?? undefined}
                      >
                        <span className="text-sm text-ink-300 min-w-0 truncate">{metric.label}</span>
                        <span className="flex items-baseline gap-2 shrink-0">
                          <span className="figure-sm text-ink-50">{formatMetric(metric)}</span>
                          <Delta pct={metric.trend?.pct ?? null} goodWhen={GOOD_WHEN[metric.key] ?? "neutral"} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>

          <section className="grid gap-5 lg:grid-cols-2">
            <div className="card p-5">
              <SectionHead
                title="Covers by month"
                note="Every month on record against the same month a year earlier."
              />
              <AreaChart
                series={[
                  { name: "This year", points: data.series.monthlyCovers },
                  { name: "Year earlier", points: data.series.monthlyCoversPriorYear },
                ]}
                format={(value) => `${integer(value)} covers`}
                partialLast={partialLast}
                height={220}
              />
            </div>
            <div className="card p-5">
              <SectionHead
                title="Revenue by month"
                note="Begins the month the POS went live — earlier months have covers but no money."
              />
              {data.series.monthlyRevenue.length ? (
                <AreaChart
                  series={[{ name: "Revenue", points: data.series.monthlyRevenue }]}
                  format={(value) => money(value)}
                  partialLast={partialLast}
                  height={220}
                />
              ) : (
                <Empty>No POS revenue recorded yet.</Empty>
              )}
            </div>
          </section>

          <section className="card p-5">
            <SectionHead
              title="When the room fills"
              note="Covers by day and hour, in your own clock. The single clearest read on where to put staff."
            />
            <Heatmap cells={heat.cells} days={DAYS} hours={heat.hours} format={(value) => integer(value)} />
          </section>

          <section className="grid gap-5 lg:grid-cols-3">
            <div className="card p-5">
              <SectionHead title="Covers by day" />
              <Columns
                points={data.series.dayOfWeek}
                format={(value) => integer(value)}
                highlight={data.series.dayOfWeek.reduce((best, p) => ((p.value ?? 0) > (best.value ?? 0) ? p : best), data.series.dayOfWeek[0])?.key}
              />
            </div>
            <div className="card p-5">
              <SectionHead title="Parties by size" note="Where the demand actually sits." />
              <Columns points={data.series.partySize} format={(value) => integer(value)} tone={VIZ[3]} />
            </div>
            <div className="card p-5">
              <SectionHead
                title="Turn time by party size"
                note="What each size costs in table minutes — the number to price a large-party policy against."
              />
              <Columns points={data.series.turnByPartySize} format={(value) => minutes(value)} tone={VIZ[1]} />
            </div>
          </section>

          <section className="grid gap-5 lg:grid-cols-3">
            <div className="card p-5 lg:col-span-1 flex items-center">
              <Ring
                pct={Number(data.metrics.find((m) => m.key === "seat_utilisation")?.value ?? null) || null}
                label="Seat utilisation"
                caption="Covers served against what the room could physically seat at the observed turn time."
              />
            </div>
            <MonthTable data={data} />
          </section>

          <MenuMix data={data} />

          <Staff data={data} />

          <section>
            <SectionHead
              title="Every shift"
              note={`${integer(data.shifts.length)} service periods in this window, newest first.`}
            />
            <div className="card overflow-x-auto">
              <table className="data-table text-sm min-w-[900px]">
                <thead>
                  <tr>
                    <th style={{ paddingLeft: "1rem" }}>Date</th>
                    <th>Service</th>
                    <th style={{ textAlign: "right" }}>Covers</th>
                    <th style={{ textAlign: "right" }}>Parties</th>
                    <th style={{ textAlign: "right" }}>Avg size</th>
                    <th style={{ textAlign: "right" }}>Turn</th>
                    <th style={{ textAlign: "right" }}>Walk-ins</th>
                    <th style={{ textAlign: "right" }}>No-shows</th>
                    <th style={{ textAlign: "right" }}>Revenue</th>
                    <th style={{ textAlign: "right", paddingRight: "1rem" }}>Avg bill</th>
                  </tr>
                </thead>
                <tbody>
                  {data.shifts.slice(0, shiftLimit).map((shift) => (
                    <tr key={`${shift.date}-${shift.period}`}>
                      <td className="text-ink-200 whitespace-nowrap" style={{ paddingLeft: "1rem" }}>
                        {shortDate(shift.date)}
                        {shift.imported ? <span className="ml-2 text-[10px] text-ink-400/70">imported</span> : null}
                      </td>
                      <td className="text-ink-400">{periodLabel(shift.period)}</td>
                      <td className="text-ink-50" style={{ textAlign: "right" }}>{integer(shift.covers)}</td>
                      <td className="text-ink-200" style={{ textAlign: "right" }}>{integer(shift.parties)}</td>
                      <td className="text-ink-200" style={{ textAlign: "right" }}>{decimal(shift.avgPartySize, 1)}</td>
                      <td className="text-ink-200" style={{ textAlign: "right" }}>{minutes(shift.avgTurnMinutes)}</td>
                      <td className="text-ink-400" style={{ textAlign: "right" }}>{integer(shift.walkInParties)}</td>
                      <td className="text-ink-400" style={{ textAlign: "right" }}>{shift.noShows || "—"}</td>
                      <td className="text-ink-50" style={{ textAlign: "right" }}>{shift.revenueCents == null ? "—" : money(shift.revenueCents)}</td>
                      <td className="text-ink-200" style={{ textAlign: "right", paddingRight: "1rem" }}>{shift.avgCheckCents == null ? "—" : money(shift.avgCheckCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.shifts.length > shiftLimit ? (
              <div className="no-print mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => setShiftLimit((value) => value + 120)}
                  className="rounded-lg border border-border bg-panel-card px-4 py-2 text-sm text-ink-200 hover:border-border-hi"
                >
                  Show more ({integer(data.shifts.length - shiftLimit)} remaining)
                </button>
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

function SectionHead({ title, note, action }: { title: string; note?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-4">
      <div>
        <h2 className="text-lg font-semibold text-ink-50 tracking-tight">{title}</h2>
        {note ? <p className="text-sm text-ink-400 mt-1 max-w-2xl leading-relaxed">{note}</p> : null}
      </div>
      {action}
    </div>
  );
}

function Growth({ data }: { data: AnalysisResult }) {
  const cells = [
    { label: "Covers, month over month", pct: data.growth.coversMoM },
    { label: "Covers, year over year", pct: data.growth.coversYoY },
    { label: "Revenue, month over month", pct: data.growth.revenueMoM },
    { label: "Revenue, year over year", pct: data.growth.revenueYoY },
  ];
  return (
    <section>
      <SectionHead
        title="Growth"
        note="Measured from the last complete month. A month still in progress is never compared against a finished one."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cells.map((cell) => {
          const missing = cell.pct == null;
          const up = (cell.pct ?? 0) > 0;
          return (
            <div key={cell.label} className={`card card-lit p-4 ${missing ? "awaiting" : ""}`}>
              <span className="label">{cell.label}</span>
              {/* One arrow, one number. An arrow chip beside a figure that
                  already carries a sign just says the same thing twice. */}
              <div className="mt-2.5 flex items-center gap-2">
                {!missing ? (
                  <span
                    className="inline-flex items-center justify-center w-8 h-8 rounded-full shrink-0"
                    style={{
                      background: up ? "var(--color-state-availBg)" : "var(--color-state-seatedBg)",
                      color: up ? "var(--color-state-avail)" : "var(--color-state-seated)",
                    }}
                    aria-hidden="true"
                  >
                    <svg width="14" height="14" viewBox="0 0 10 10">
                      <path
                        d={up ? "M5 8.5V2M5 2 1.8 5.2M5 2l3.2 3.2" : "M5 1.5V8M5 8l3.2-3.2M5 8 1.8 4.8"}
                        stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" fill="none"
                      />
                    </svg>
                  </span>
                ) : null}
                <span
                  className="figure"
                  style={{ color: missing ? undefined : up ? "var(--color-state-avail)" : "var(--color-state-seated)" }}
                >
                  {missing ? "—" : fmtDelta(cell.pct)}
                </span>
              </div>
              {missing ? <p className="text-xs text-ink-400 mt-3">No comparable prior period on record.</p> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MonthTable({ data }: { data: AnalysisResult }) {
  if (!data.growth.monthTable.length) return null;
  return (
    <div className="card p-5 lg:col-span-2 overflow-x-auto">
      <SectionHead title="Month by month" note="Each month against the same month last year." />
      <table className="data-table text-sm min-w-[560px]">
        <thead>
          <tr>
            <th>Month</th>
            <th style={{ textAlign: "right" }}>Covers</th>
            <th style={{ textAlign: "right" }}>Last year</th>
            <th style={{ textAlign: "right" }}>Change</th>
            <th style={{ textAlign: "right" }}>Revenue</th>
            <th style={{ textAlign: "right" }}>Change</th>
          </tr>
        </thead>
        <tbody>
          {data.growth.monthTable.slice(0, 14).map((row) => (
            <tr key={row.month}>
              <td className="text-ink-200 whitespace-nowrap">
                {row.label}
                {!row.complete ? <span className="ml-2 text-[10px] text-state-dining">in progress</span> : null}
              </td>
              <td className="text-ink-50" style={{ textAlign: "right" }}>{integer(row.covers)}</td>
              <td className="text-ink-400" style={{ textAlign: "right" }}>{row.coversPrior == null ? "—" : integer(row.coversPrior)}</td>
              <td style={{ textAlign: "right" }}>
                {row.complete ? <Delta pct={row.coversDeltaPct} goodWhen="up" /> : <span className="text-ink-400/60 text-xs">—</span>}
              </td>
              <td className="text-ink-50" style={{ textAlign: "right" }}>{row.revenueCents == null ? "—" : money(row.revenueCents)}</td>
              <td style={{ textAlign: "right" }}>
                {row.complete ? <Delta pct={row.revenueDeltaPct} goodWhen="up" /> : <span className="text-ink-400/60 text-xs">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const QUADRANT = {
  star: { tone: "good" as const, note: "Popular and high-priced. Protect these." },
  plowhorse: { tone: "warn" as const, note: "Popular but cheap. Candidates for a price test." },
  puzzle: { tone: "accent" as const, note: "High-priced but rarely ordered. Reposition or describe better." },
  dog: { tone: "neutral" as const, note: "Neither popular nor high-priced." },
};

function MenuMix({ data }: { data: AnalysisResult }) {
  const mix = data.menuMix;
  return (
    <section>
      <SectionHead
        title="Menu"
        note="Quadrants use price as a stand-in for margin, because Travola Home has no food-cost data — read them as a prompt, not a verdict."
      />
      {mix.available === "awaiting_pos" ? (
        <div className="card p-5 awaiting">
          <p className="text-sm text-ink-200">{mix.reason}</p>
          {mix.neverSold.length ? (
            <p className="text-xs text-ink-400 mt-3">
              {mix.neverSold.length} items are on the menu and have never appeared on a closed check:{" "}
              {mix.neverSold.slice(0, 8).map((item) => item.name).join(", ")}
              {mix.neverSold.length > 8 ? "…" : ""}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-3">
          <div className="card p-5">
            <SectionHead title="Most sold" />
            <RankedBars
              rows={mix.top.map((row) => ({ key: row.name, label: row.name, value: row.quantity, meta: money(row.revenueCents) }))}
              format={(value) => integer(value)}
            />
            <ul className="mt-4 flex flex-wrap gap-1.5">
              {mix.top.slice(0, 6).map((row) => (
                <li key={row.name} title={QUADRANT[row.quadrant].note}>
                  <Pill tone={QUADRANT[row.quadrant].tone}>{row.name} · {row.quadrant}</Pill>
                </li>
              ))}
            </ul>
          </div>
          <div className="card p-5">
            <SectionHead title="Least sold" />
            <RankedBars
              rows={mix.bottom.map((row) => ({ key: row.name, label: row.name, value: row.quantity, meta: money(row.revenueCents) }))}
              format={(value) => integer(value)}
              tone={VIZ[1]}
            />
          </div>
          <div className="card p-5">
            <SectionHead title="Never sold" note="On the menu, never rung in." />
            {mix.neverSold.length === 0 ? (
              <Empty>Everything on the menu has sold at least once.</Empty>
            ) : (
              <ul className="text-sm flex flex-col gap-1.5">
                {mix.neverSold.map((item) => (
                  <li key={item.name} className="flex justify-between gap-3">
                    <span className="text-ink-200 truncate">{item.name}</span>
                    <span className="text-ink-400 tabular-nums shrink-0">{money(item.priceCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Staff({ data }: { data: AnalysisResult }) {
  if (!data.staff.length) return null;
  return (
    <section className="grid gap-5 lg:grid-cols-3">
      <div className="card p-5">
        <SectionHead title="Covers by server" note="Who is carrying the room." />
        <RankedBars
          rows={data.staff.slice(0, 8).map((row) => ({
            key: row.serverId, label: row.name, value: row.covers,
            meta: `${integer(row.shifts)} shifts`,
          }))}
          format={(value) => integer(value)}
          tone={VIZ[2]}
        />
      </div>
      <div className="card p-5 lg:col-span-2 overflow-x-auto">
        <SectionHead title="By server" note="Covers and turn come from the floor; average bill joins in from the POS." />
        <table className="data-table text-sm min-w-[520px]">
          <thead>
            <tr>
              <th>Server</th>
              <th style={{ textAlign: "right" }}>Shifts</th>
              <th style={{ textAlign: "right" }}>Covers</th>
              <th style={{ textAlign: "right" }}>Parties</th>
              <th style={{ textAlign: "right" }}>Avg turn</th>
              <th style={{ textAlign: "right" }}>Avg bill</th>
            </tr>
          </thead>
          <tbody>
            {data.staff.map((row) => (
              <tr key={row.serverId}>
                <td className="text-ink-50">{row.name}</td>
                <td className="text-ink-400" style={{ textAlign: "right" }}>{integer(row.shifts)}</td>
                <td className="text-ink-50" style={{ textAlign: "right" }}>{integer(row.covers)}</td>
                <td className="text-ink-200" style={{ textAlign: "right" }}>{integer(row.parties)}</td>
                <td className="text-ink-200" style={{ textAlign: "right" }}>{minutes(row.avgTurnMinutes)}</td>
                <td className="text-ink-200" style={{ textAlign: "right" }}>{row.avgCheckCents == null ? "—" : money(row.avgCheckCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-6 animate-pulse">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="card h-36" />)}
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="card h-72" /><div className="card h-72" />
      </div>
    </div>
  );
}
