// lib/analytics/types.ts — the vocabulary the analysis tab is built on.
//
// The single most important idea here is `availability`. This restaurant
// has nineteen months of covers history (much of it imported from a
// previous system) and, on the day Travola Home ships, no money history at
// all — the POS has only just gone live. A dashboard that answers
// "average bill: $0.00" in that situation is worse than one that says
// nothing: it is confidently wrong, and an owner who sees one zero stops
// trusting the other forty numbers on the page.
//
// So every metric carries what it knows AND what it is missing, and the
// UI renders the three states differently: a value, an "awaiting POS
// data" placeholder that names the source it needs, or a "not enough
// history yet" note that names how much more it wants.

export type Availability =
  /** Enough data; render the number. */
  | "ready"
  /** Rendered, but from a thin sample — show the caveat. */
  | "partial"
  /** The source exists but is empty (no closed checks yet). */
  | "awaiting_pos"
  /** Not enough service history to be meaningful. */
  | "insufficient";

export type Unit = "count" | "people" | "minutes" | "cents" | "percent" | "text" | "ratio";

export type Trend = {
  /** Percent change vs the comparison window. Null when incomparable. */
  pct: number | null;
  /** What it was compared against, e.g. "vs previous 90 days". */
  basis: string;
  /** Is up good? Turn time going up is bad; covers going up is good. */
  goodWhen: "up" | "down" | "neutral";
};

export type Metric = {
  key: string;
  label: string;
  unit: Unit;
  value: number | string | null;
  available: Availability;
  /** Plain-English reason when not `ready`. Shown verbatim in the UI. */
  reason?: string;
  /** Rows behind the number — what makes "partial" honest. */
  sampleSize?: number;
  trend?: Trend | null;
  /** One line of interpretation, not a definition of the metric. */
  hint?: string;
  /** Group heading in the UI. */
  group: MetricGroup;
};

export type MetricGroup =
  | "volume"
  | "money"
  | "throughput"
  | "reliability"
  | "guests"
  | "staff"
  | "forecast";

export const GROUP_LABELS: Record<MetricGroup, string> = {
  volume: "Volume & demand",
  money: "Money",
  throughput: "Throughput & pace",
  reliability: "Reliability",
  guests: "Guests",
  staff: "Staff",
  forecast: "Forecast accuracy",
};

/** One row in the "all past shifts" table. */
export type ServiceShiftRow = {
  date: string;          // YYYY-MM-DD
  period: "BRUNCH" | "LUNCH" | "DINNER";
  dayOfWeek: number;
  covers: number;
  parties: number;
  avgPartySize: number | null;
  avgTurnMinutes: number | null;
  walkInParties: number;
  noShows: number;
  cancellations: number;
  avgSeatDelayMinutes: number | null;
  revenueCents: number | null;
  checks: number;
  avgCheckCents: number | null;
  ppaCents: number | null;
  /** true when every number in this row comes from imported history. */
  imported: boolean;
};

export type SeriesPoint = { key: string; label: string; value: number | null; sample?: number };

export type MenuMixRow = {
  name: string;
  quantity: number;
  revenueCents: number;
  priceCents: number;
  /** Menu-engineering quadrant. */
  quadrant: "star" | "plowhorse" | "puzzle" | "dog";
  sharePct: number;
};

export type AnalysisResult = {
  range: { from: string; to: string; label: string; days: number };
  coverage: {
    firstServiceDate: string | null;
    lastServiceDate: string | null;
    serviceDays: number;
    reservations: number;
    importedReservations: number;
    closedChecks: number;
    tableSessions: number;
    /** What is missing and what it blocks — drives the banner. */
    gaps: Array<{ source: string; blocks: string[]; note: string }>;
  };
  metrics: Metric[];
  shifts: ServiceShiftRow[];
  series: {
    monthlyCovers: SeriesPoint[];
    monthlyRevenue: SeriesPoint[];
    /** Same months as monthlyCovers, shifted a year — the year-over-year
     *  comparison series, aligned so one axis serves both. */
    monthlyCoversPriorYear: SeriesPoint[];
    dayOfWeek: SeriesPoint[];
    hourly: SeriesPoint[];
    partySize: SeriesPoint[];
    turnByPartySize: SeriesPoint[];
    dailyCovers: SeriesPoint[];
    /** "<dayOfWeek>-<hour>" -> covers. */
    weekHeatmap: Array<{ dow: number; hour: number; covers: number }>;
  };
  growth: {
    coversMoM: number | null;
    coversYoY: number | null;
    revenueMoM: number | null;
    revenueYoY: number | null;
    /** Month-by-month table: this year vs last year. */
    monthTable: Array<{
      month: string;
      label: string;
      /** False when the month is still running — its totals are partial
       *  and any comparison against a full month reads as a collapse. */
      complete: boolean;
      covers: number;
      coversPrior: number | null;
      coversDeltaPct: number | null;
      revenueCents: number | null;
      revenuePriorCents: number | null;
      revenueDeltaPct: number | null;
    }>;
  };
  menuMix: {
    available: Availability;
    reason?: string;
    top: MenuMixRow[];
    bottom: MenuMixRow[];
    neverSold: Array<{ name: string; priceCents: number }>;
  };
  staff: Array<{
    serverId: string;
    name: string;
    shifts: number;
    covers: number;
    parties: number;
    avgTurnMinutes: number | null;
    avgCheckCents: number | null;
  }>;
  generatedAt: string;
};
