"use client";

// components/ui.tsx — the small set of primitives every screen is built from.
//
// They read the CSS variables set by the style layer (app/globals.css)
// rather than hard-coding padding, radius or type size, which is what lets
// one component tree render as three genuinely different designs.
//
// The charts are hand-rolled SVG on purpose. A charting library would add
// ~100KB to a page whose job is to load fast on a manager's phone in a
// back office, and none of these shapes need one.
import type { ReactNode } from "react";
import type { Availability, Metric, SeriesPoint } from "@/lib/analytics/types";
import { DASH, delta as fmtDelta, formatMetric } from "@/lib/format";

/**
 * `panel` marks a card that must keep a real surface in every style. The
 * ledger treatment strips card fills so a grid of metrics reads as a
 * ruled sheet — but a chart or a data table still needs a container, and
 * without this it would float on the canvas with nothing holding it.
 */
export function Card({ children, className = "", as: Tag = "div", panel = true }: {
  children: ReactNode; className?: string; as?: "div" | "section" | "article"; panel?: boolean;
}) {
  return <Tag className={`tv-card ${panel ? "tv-panel" : ""} ${className}`}>{children}</Tag>;
}

export function SectionHeading({ title, note, action }: { title: string; note?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4 mb-3">
      <div>
        <h2 className="tv-heading text-ink-50">{title}</h2>
        {note ? <p className="text-sm text-ink-400 mt-1 max-w-2xl">{note}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Chip({ tone = "neutral", children }: {
  tone?: "neutral" | "good" | "bad" | "warn" | "accent"; children: ReactNode;
}) {
  const tones = {
    neutral: "bg-panel-up text-ink-200",
    good: "bg-state-availBg text-state-avail",
    bad: "bg-state-seatedBg text-state-seated",
    warn: "bg-state-diningBg text-state-dining",
    accent: "bg-ai-bg text-ai",
  } as const;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** A trend chip that knows whether up is good. Turn time rising is bad. */
export function Delta({ pct, goodWhen = "up", basis }: {
  pct: number | null | undefined; goodWhen?: "up" | "down" | "neutral"; basis?: string;
}) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const flat = Math.abs(pct) < 0.5;
  const positive = pct > 0;
  const tone = flat || goodWhen === "neutral"
    ? "neutral"
    : (positive && goodWhen === "up") || (!positive && goodWhen === "down")
      ? "good"
      : "bad";
  return (
    <span title={basis}>
      <Chip tone={tone as "neutral" | "good" | "bad"}>
        {flat ? "flat" : fmtDelta(pct)}
      </Chip>
    </span>
  );
}

const AVAILABILITY_CHIP: Record<Availability, { label: string; tone: "warn" | "accent" | "neutral" } | null> = {
  ready: null,
  partial: { label: "thin data", tone: "warn" },
  awaiting_pos: { label: "awaiting POS", tone: "accent" },
  insufficient: { label: "no data", tone: "neutral" },
};

export function MetricCard({ metric }: { metric: Metric }) {
  const missing = metric.value == null;
  const badge = AVAILABILITY_CHIP[metric.available];
  return (
    <Card panel={false} className={missing ? "tv-missing" : ""}>
      <div className="flex items-start justify-between gap-2">
        <span className="tv-label">{metric.label}</span>
        {badge ? <Chip tone={badge.tone}>{badge.label}</Chip> : null}
      </div>
      <div className="mt-2 flex items-baseline gap-2 flex-wrap">
        <span className="tv-metric text-ink-50">{formatMetric(metric)}</span>
        {metric.trend ? <Delta pct={metric.trend.pct} goodWhen={metric.trend.goodWhen} basis={metric.trend.basis} /> : null}
      </div>
      {metric.hint && !missing ? <p className="mt-2 text-xs text-ink-400 leading-relaxed">{metric.hint}</p> : null}
      {metric.reason ? <p className="mt-2 text-xs text-ink-400 leading-relaxed">{metric.reason}</p> : null}
      {metric.sampleSize != null && metric.sampleSize > 0 && !missing ? (
        <p className="mt-1 text-[11px] text-ink-400/70">{metric.sampleSize.toLocaleString("en-US")} records</p>
      ) : null}
    </Card>
  );
}

/** Horizontal bars — the honest default for a categorical comparison. */
export function BarChart({ points, format, height = 200 }: {
  points: SeriesPoint[]; format?: (value: number) => string; height?: number;
}) {
  const max = Math.max(1, ...points.map((p) => p.value ?? 0));
  if (!points.length) return <Empty>Nothing to chart in this window.</Empty>;
  return (
    <div className="flex flex-col gap-1.5" style={{ minHeight: height }}>
      {points.map((point) => {
        const value = point.value ?? 0;
        return (
          <div key={point.key} className="flex items-center gap-3 text-xs">
            <span className="w-20 shrink-0 text-ink-400 text-right">{point.label}</span>
            <span className="flex-1 h-5 rounded bg-panel-up/60 overflow-hidden">
              <span
                className="block h-full rounded bg-ai/70"
                style={{ width: `${Math.max(value > 0 ? 2 : 0, (value / max) * 100)}%` }}
              />
            </span>
            <span className="w-20 shrink-0 tabular-nums text-ink-200">
              {format ? format(value) : value.toLocaleString("en-US")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A filled line for a time series.
 *
 * `partialLast` marks the final point as an incomplete period. It matters
 * more than it sounds: a month that is three days old plotted next to
 * eleven full ones draws a cliff, and the cliff is the calendar, not the
 * business. The last segment is dashed and the caption says so.
 *
 * Below four points a line is not a trend, so it renders as bars instead
 * — two points joined by a line is a shape the eye reads as a direction
 * on no evidence at all.
 */
export function LineChart({ points, format, height = 160, partialLast = false }: {
  points: SeriesPoint[]; format?: (value: number) => string; height?: number; partialLast?: boolean;
}) {
  const usable = points.filter((p) => p.value != null);
  if (usable.length < 2) return <Empty>Not enough points yet to draw a trend.</Empty>;
  if (usable.length < 4) {
    return (
      <div>
        <BarChart points={usable} format={format} height={Math.min(height, 90)} />
        {partialLast ? (
          <p className="text-[11px] text-ink-400 mt-2">
            {usable[usable.length - 1].label} is still in progress — it is a partial figure.
          </p>
        ) : null}
      </div>
    );
  }
  const values = usable.map((p) => p.value as number);
  const max = Math.max(...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const width = 100;
  const step = width / (usable.length - 1);
  const coords = usable.map((point, i) => {
    const y = 100 - (((point.value as number) - min) / span) * 100;
    return `${(i * step).toFixed(2)},${y.toFixed(2)}`;
  });
  const last = usable[usable.length - 1];
  const first = usable[0];
  return (
    <figure className="w-full">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="w-full block"
        style={{ height }}
        role="img"
        aria-label={`Trend from ${first.label} to ${last.label}`}
      >
        <polygon points={`0,100 ${coords.join(" ")} ${width},100`} fill="var(--color-ai-muted)" />
        <polyline
          points={(partialLast ? coords.slice(0, -1) : coords).join(" ")}
          fill="none"
          stroke="var(--color-ai)"
          strokeWidth="0.8"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
        {partialLast ? (
          <polyline
            points={coords.slice(-2).join(" ")}
            fill="none"
            stroke="var(--color-ai)"
            strokeWidth="0.8"
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <figcaption className="flex justify-between text-[11px] text-ink-400 mt-1">
        <span>{first.label}</span>
        <span className="text-ink-200 tabular-nums">
          {format ? format(last.value as number) : (last.value as number).toLocaleString("en-US")} · {last.label}
          {partialLast ? " (in progress)" : ""}
        </span>
      </figcaption>
    </figure>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-ink-400 py-6 text-center border border-dashed border-border rounded-lg">
      {children}
    </p>
  );
}

export function Value({ children }: { children: ReactNode }) {
  return <span className="tabular-nums text-ink-50">{children ?? DASH}</span>;
}

export function Button({
  children, onClick, tone = "default", type = "button", disabled, className = "", title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "default" | "primary" | "danger" | "ghost";
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const tones = {
    default: "bg-panel-up text-ink-50 hover:bg-panel-up/70 border border-border",
    primary: "bg-ai text-bg hover:opacity-90 border border-transparent font-medium",
    danger: "bg-state-seatedBg text-state-seated hover:bg-state-seatedBg/70 border border-state-seated/30",
    ghost: "bg-transparent text-ink-400 hover:text-ink-50 border border-transparent",
  } as const;
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed ${tones[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="tv-label block mb-1">{label}</span>
      {children}
      {hint ? <span className="block mt-1 text-xs text-ink-400">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg bg-panel-card border border-border px-3 py-2 text-sm text-ink-50 " +
  "placeholder:text-ink-400/60 focus:border-border-hi outline-none";
