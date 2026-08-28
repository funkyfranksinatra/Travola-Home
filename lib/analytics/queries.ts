// lib/analytics/queries.ts — the aggregation layer.
//
// Everything here is raw SQL on purpose. Sixteen thousand reservations
// is already too many to pull into Node and reduce, and the number only
// goes one way: rolling up in Postgres keeps the analysis tab at a
// handful of grouped scans no matter how much history a restaurant
// brings with it. Each query is scoped by restaurantId in its WHERE
// clause — there is no query in this file that could return another
// restaurant's rows.
//
// ⚠ TWO CLOCKS LIVE IN THIS DATABASE. Getting this wrong silently moves
// every dinner service into brunch, so it is spelled out here:
//
//   · The floor app writes Reservation/WaitlistEntry times as LOCAL WALL
//     CLOCK into naive `timestamp without time zone` columns. Volario's
//     16:00–21:00 service is stored as 16:00–21:00, and the floor app
//     reads it back with getHours() on a UTC server — which returns the
//     stored local hour unchanged. So Travola Home reads those columns
//     NAIVELY too. (Verified against production: targetTime hours run
//     16–21, exactly the configured 960–1260 service window. Converting
//     them through America/Denver produced hours of 9–15 and filed the
//     entire dinner history as brunch.)
//
//   · The POS writes Check/TableSession timestamps from now(), so those
//     ARE real UTC instants and DO need converting to the restaurant's
//     zone before a local hour or a service date is taken from them.
//
// Until the two apps agree, this file is where the seam is handled, and
// `localFromUtc` vs a bare column reference is the difference.
//
// ⚠ WHY THESE ARE STRINGS AND NOT `Prisma.sql` FRAGMENTS. Nesting a
// `Prisma.sql` fragment inside a `$queryRaw` template relies on the
// client recognising it with `instanceof Sql`. The bundler is free to
// place the Prisma runtime and this module in different chunks — which it
// did, the moment the overview route started importing the analysis
// engine — and across two copies of the module that check fails silently.
// The fragment is then bound as a PARAMETER, and Postgres rejects
// `EXTRACT(HOUR FROM ...)` as "invalid input syntax for type integer".
//
// So the SQL here is assembled from plain constant strings with numbered
// placeholders, and only real values are ever parameters. Nothing
// user-supplied is ever concatenated: restaurantId, dates and the
// timezone all arrive as $1, $2, $3. It is also simply less magic.
import { prisma } from "../prisma";

/**
 * Turn times outside this band are excluded, not clamped.
 *
 * Production carries 37 reservations with turn times up to 14,370
 * minutes — tables that were seated and never cleared, so finishedTime
 * landed days later. They are 0.2% of the rows and would move the mean
 * turn time by tens of minutes. The count of what was dropped is
 * surfaced to the UI rather than hidden.
 */
export const TURN_MIN_MINUTES = 10;
export const TURN_MAX_MINUTES = 360;

const SANE_TURN = `"turnMinutes" BETWEEN ${TURN_MIN_MINUTES} AND ${TURN_MAX_MINUTES}`;
const SANE_TURN_R = `r."turnMinutes" BETWEEN ${TURN_MIN_MINUTES} AND ${TURN_MAX_MINUTES}`;

/**
 * How far past midnight still counts as the previous service day. A
 * check closed at 00:40 belongs to the night that produced it, not to
 * the morning it happened to end in.
 */
const SERVICE_DAY_CUTOFF_HOURS = 5;

/** A POS UTC instant, rendered in the restaurant's own clock. The zone is
 *  a PARAMETER ($3), never concatenated. */
const localFromUtc = (col: string, tzParam: string) => `(${col} AT TIME ZONE 'UTC' AT TIME ZONE ${tzParam})`;

/** The service day a POS timestamp belongs to. */
const posServiceDay = (col: string, tzParam: string) =>
  `DATE(${localFromUtc(col, tzParam)} - INTERVAL '${SERVICE_DAY_CUTOFF_HOURS} hours')`;

// The statuses that mean "this party actually ate here". Imported
// history lands as FINISHED; a live service moves SEATED -> FINISHED.
const SERVED = `status IN ('SEATED'::"ReservationStatus", 'FINISHED'::"ReservationStatus")`;
const NOT_CANCELLED = `status <> 'CANCELLED'::"ReservationStatus"`;
const IMPORTED = `source IN ('OPENTABLE_IMPORT'::"BookingSource",'RESY_IMPORT'::"BookingSource",'PAPER_IMPORT'::"BookingSource")`;

/** Local-clock hour of a FLOOR-APP timestamp (already local wall clock). */
const floorHour = (col: string) => `EXTRACT(HOUR FROM ${col})`;
const SEATED_OR_TARGET = `COALESCE("seatedTime", "targetTime")`;

/** A date-only value Postgres will accept for a `date` column. */
const dateKey = (value: Date) => value.toISOString().slice(0, 10);

/** Scope + window, the three parameters almost every query takes. */
const scope = (restaurantId: string, from: Date, to: Date) => [restaurantId, dateKey(from), dateKey(to)];

export type Bounds = {
  firstServiceDate: Date | null;
  lastServiceDate: Date | null;
  reservations: bigint;
  importedReservations: bigint;
  waitlistEntries: bigint;
  tableSessions: bigint;
  closedChecks: bigint;
  firstCheckAt: Date | null;
  guests: bigint;
};

/** What history exists at all — drives the range picker and the gaps banner. */
export async function loadBounds(restaurantId: string): Promise<Bounds> {
  const rows = await prisma.$queryRawUnsafe<Bounds[]>(
    `SELECT
      (SELECT MIN("serviceDate") FROM "Reservation" WHERE "restaurantId" = $1) AS "firstServiceDate",
      (SELECT MAX("serviceDate") FROM "Reservation" WHERE "restaurantId" = $1) AS "lastServiceDate",
      (SELECT COUNT(*) FROM "Reservation" WHERE "restaurantId" = $1) AS "reservations",
      (SELECT COUNT(*) FROM "Reservation" WHERE "restaurantId" = $1 AND ${IMPORTED}) AS "importedReservations",
      (SELECT COUNT(*) FROM "WaitlistEntry" WHERE "restaurantId" = $1) AS "waitlistEntries",
      (SELECT COUNT(*) FROM "TableSession" WHERE "restaurantId" = $1) AS "tableSessions",
      (SELECT COUNT(*) FROM "Check" WHERE "restaurantId" = $1 AND status = 'closed') AS "closedChecks",
      (SELECT MIN("openedAt") FROM "Check" WHERE "restaurantId" = $1 AND status = 'closed') AS "firstCheckAt",
      (SELECT COUNT(*) FROM "Guest" WHERE "restaurantId" = $1) AS "guests"`,
    restaurantId,
  );
  return rows[0];
}

export type ShiftRollupRow = {
  d: Date;
  period: string;
  dow: number;
  parties: bigint;
  covers: bigint | null;
  no_shows: bigint;
  cancellations: bigint;
  walk_in_parties: bigint;
  imported_parties: bigint;
  avg_party: string | null;
  avg_turn: string | null;
  median_turn: string | null;
  turn_outliers: bigint;
  avg_seat_delay: string | null;
  vip_parties: bigint;
};

/**
 * The spine of the analysis tab: one row per service day and period,
 * derived from reservations rather than from the Shift table.
 *
 * This is deliberate. Shift rows only exist for days the floor app has
 * finalised — four of them here — while the reservation history runs
 * nineteen months back. Deriving the shift list from reservations is what
 * makes "all past shifts, as far back as there is data" true for imported
 * history too.
 */
export async function loadShiftRollup(restaurantId: string, from: Date, to: Date) {
  return prisma.$queryRawUnsafe<ShiftRollupRow[]>(
    `WITH r AS (
      SELECT
        "serviceDate" AS d,
        "dayOfWeek" AS dow,
        CASE
          WHEN ${floorHour(SEATED_OR_TARGET)} < 11 THEN 'BRUNCH'
          WHEN ${floorHour(SEATED_OR_TARGET)} < 16 THEN 'LUNCH'
          ELSE 'DINNER'
        END AS period,
        "partySize", status, source, vip, "turnMinutes",
        CASE WHEN "seatedTime" IS NOT NULL
             THEN EXTRACT(EPOCH FROM ("seatedTime" - "targetTime")) / 60.0 END AS seat_delay
      FROM "Reservation"
      WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date
    )
    SELECT
      d, dow, period,
      COUNT(*) FILTER (WHERE ${NOT_CANCELLED})                                   AS parties,
      SUM("partySize") FILTER (WHERE ${SERVED})                                  AS covers,
      COUNT(*) FILTER (WHERE status = 'NO_SHOW'::"ReservationStatus")            AS no_shows,
      COUNT(*) FILTER (WHERE status = 'CANCELLED'::"ReservationStatus")          AS cancellations,
      COUNT(*) FILTER (WHERE source = 'WALK_IN'::"BookingSource" AND ${NOT_CANCELLED}) AS walk_in_parties,
      COUNT(*) FILTER (WHERE ${IMPORTED})                                        AS imported_parties,
      COUNT(*) FILTER (WHERE vip AND ${NOT_CANCELLED})                           AS vip_parties,
      AVG("partySize") FILTER (WHERE ${SERVED})                                  AS avg_party,
      AVG("turnMinutes") FILTER (WHERE ${SANE_TURN})                             AS avg_turn,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "turnMinutes")
        FILTER (WHERE ${SANE_TURN})                                              AS median_turn,
      COUNT(*) FILTER (WHERE "turnMinutes" IS NOT NULL AND NOT (${SANE_TURN}))   AS turn_outliers,
      AVG(seat_delay) FILTER (WHERE seat_delay IS NOT NULL AND seat_delay BETWEEN -120 AND 240) AS avg_seat_delay
    FROM r
    GROUP BY d, dow, period
    ORDER BY d DESC, period`,
    ...scope(restaurantId, from, to),
  );
}

export type MoneyDayRow = {
  d: Date;
  checks: bigint;
  revenue: bigint | null;
  subtotal: bigint | null;
  tips: bigint | null;
  guests: bigint | null;
  median_check: string | null;
};

/** Money per service day, from closed checks. Empty until the POS runs. */
export async function loadMoneyByDay(restaurantId: string, tz: string, from: Date, to: Date) {
  const day = posServiceDay(`"openedAt"`, "$4");
  // TWO SOURCES, deliberately unioned rather than chosen between.
  //
  // Closed checks are the richer source — they carry a check count, a
  // tip and a distribution, so they give a per-BILL average. The shift
  // close-out is the source that exists: with no POS in the product,
  // a manager types the night's net sales and covers, which gives
  // revenue and a per-PERSON average but no check count at all.
  //
  // The NULLs below are load-bearing, not laziness. `checks`, `tips` and
  // `median_check` are genuinely unknown for a close-out, and returning
  // 0 for them would let the caller compute an average bill by dividing
  // by zero-turned-one and print a confident wrong number. Null makes
  // the caller say "we do not know that yet", which is the truth.
  //
  // A day with both — a restaurant that reconnects a POS — yields two
  // rows and sums to double revenue, so the close-out is EXCLUDED for
  // any service day that already has closed checks. Checks win because
  // they are the more granular record.
  return prisma.$queryRawUnsafe<MoneyDayRow[]>(
    `SELECT
      ${day} AS d,
      COUNT(*)                            AS checks,
      SUM("totalCents")                   AS revenue,
      SUM("subtotalCents")                AS subtotal,
      SUM("tipCents")                     AS tips,
      SUM("guestCount")                   AS guests,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "totalCents") AS median_check
    FROM "Check"
    WHERE "restaurantId" = $1
      AND status = 'closed'
      AND ${day} >= $2::date
      AND ${day} <= $3::date
    GROUP BY 1

    UNION ALL

    SELECT
      s."serviceDate"          AS d,
      NULL::bigint             AS checks,
      SUM(s."netSalesCents")   AS revenue,
      SUM(s."netSalesCents")   AS subtotal,
      NULL::bigint             AS tips,
      SUM(s."covers")          AS guests,
      NULL::numeric            AS median_check
    FROM "ShiftSalesEntry" s
    WHERE s."restaurantId" = $1
      AND s."serviceDate" >= $2::date
      AND s."serviceDate" <= $3::date
      AND NOT EXISTS (
        SELECT 1 FROM "Check" c
         WHERE c."restaurantId" = $1
           AND c.status = 'closed'
           AND ${posServiceDay(`c."openedAt"`, "$4")} = s."serviceDate"
      )
    GROUP BY 1

    ORDER BY 1 DESC`,
    ...scope(restaurantId, from, to), tz,
  );
}

export type MonthRow = { month: string; covers: bigint | null; parties: bigint; revenue: bigint | null };

/** Monthly covers — the series behind month-over-month and year-over-year. */
export async function loadMonthlyCovers(restaurantId: string) {
  return prisma.$queryRawUnsafe<MonthRow[]>(
    `SELECT
      TO_CHAR("serviceDate", 'YYYY-MM')            AS month,
      SUM("partySize") FILTER (WHERE ${SERVED})    AS covers,
      COUNT(*) FILTER (WHERE ${NOT_CANCELLED})     AS parties,
      NULL::bigint                                 AS revenue
    FROM "Reservation"
    WHERE "restaurantId" = $1
    GROUP BY 1
    ORDER BY 1`,
    restaurantId,
  );
}

export async function loadMonthlyRevenue(restaurantId: string, tz: string) {
  // Same two sources as loadMoneyByDay, same precedence: a service day
  // with closed checks ignores its close-out so revenue is never counted
  // twice. Summed per month AFTER the union, so a month that switched
  // from one source to the other mid-way still totals correctly.
  return prisma.$queryRawUnsafe<MonthRow[]>(
    `SELECT month, NULL::bigint AS covers, SUM(parties) AS parties, SUM(revenue) AS revenue
     FROM (
       SELECT
         TO_CHAR(${posServiceDay(`"openedAt"`, "$2")}, 'YYYY-MM') AS month,
         COUNT(*)                                                 AS parties,
         SUM("totalCents")                                        AS revenue
       FROM "Check"
       WHERE "restaurantId" = $1 AND status = 'closed'
       GROUP BY 1

       UNION ALL

       SELECT
         TO_CHAR(s."serviceDate", 'YYYY-MM') AS month,
         0::bigint                           AS parties,
         SUM(s."netSalesCents")              AS revenue
       FROM "ShiftSalesEntry" s
       WHERE s."restaurantId" = $1
         AND NOT EXISTS (
           SELECT 1 FROM "Check" c
            WHERE c."restaurantId" = $1
              AND c.status = 'closed'
              AND ${posServiceDay(`c."openedAt"`, "$2")} = s."serviceDate"
         )
       GROUP BY 1
     ) sources
     GROUP BY month
     ORDER BY month`,
    restaurantId, tz,
  );
}

export type BucketRow = { bucket: number; covers: bigint | null; parties: bigint; avg_turn: string | null };

/** Covers by local hour — where the peak actually is. */
export async function loadHourly(restaurantId: string, from: Date, to: Date) {
  return prisma.$queryRawUnsafe<BucketRow[]>(
    `SELECT
      ${floorHour(SEATED_OR_TARGET)}::int       AS bucket,
      SUM("partySize") FILTER (WHERE ${SERVED}) AS covers,
      COUNT(*) FILTER (WHERE ${NOT_CANCELLED})  AS parties,
      NULL::numeric                             AS avg_turn
    FROM "Reservation"
    WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date
    GROUP BY 1 ORDER BY 1`,
    ...scope(restaurantId, from, to),
  );
}

/** Covers by day of week, and how long a table sits on each. */
export async function loadDayOfWeek(restaurantId: string, from: Date, to: Date) {
  return prisma.$queryRawUnsafe<BucketRow[]>(
    `SELECT
      "dayOfWeek"::int                          AS bucket,
      SUM("partySize") FILTER (WHERE ${SERVED}) AS covers,
      COUNT(*) FILTER (WHERE ${NOT_CANCELLED})  AS parties,
      AVG("turnMinutes") FILTER (WHERE ${SANE_TURN}) AS avg_turn
    FROM "Reservation"
    WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date
    GROUP BY 1 ORDER BY 1`,
    ...scope(restaurantId, from, to),
  );
}

/**
 * Party-size distribution and the turn time each size actually takes —
 * the pair that tells a manager whether their two-tops are the constraint
 * or their sixes are.
 */
export async function loadPartySize(restaurantId: string, from: Date, to: Date) {
  return prisma.$queryRawUnsafe<BucketRow[]>(
    `SELECT
      LEAST("partySize", 12)::int               AS bucket,
      SUM("partySize") FILTER (WHERE ${SERVED}) AS covers,
      COUNT(*) FILTER (WHERE ${SERVED})         AS parties,
      AVG("turnMinutes") FILTER (WHERE ${SANE_TURN}) AS avg_turn
    FROM "Reservation"
    WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date
      AND "partySize" > 0
    GROUP BY 1 ORDER BY 1`,
    ...scope(restaurantId, from, to),
  );
}

export type DayPoint = { d: Date; covers: bigint | null; parties: bigint; revenue: bigint | null };

/** Daily covers — the series behind the overview sparklines. */
export async function loadDailyCovers(restaurantId: string, from: Date, to: Date) {
  return prisma.$queryRawUnsafe<DayPoint[]>(
    `SELECT
      "serviceDate"                             AS d,
      SUM("partySize") FILTER (WHERE ${SERVED}) AS covers,
      COUNT(*) FILTER (WHERE ${NOT_CANCELLED})  AS parties,
      NULL::bigint                              AS revenue
    FROM "Reservation"
    WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date
    GROUP BY 1 ORDER BY 1`,
    ...scope(restaurantId, from, to),
  );
}

export type HeatCell = { dow: number; hour: number; covers: bigint | null };

/**
 * Day of week × local hour. The one picture that answers "when are we
 * actually busy" without the reader assembling it from two bar charts.
 */
export async function loadWeekHeatmap(restaurantId: string, from: Date, to: Date) {
  return prisma.$queryRawUnsafe<HeatCell[]>(
    `SELECT
      "dayOfWeek"::int                          AS dow,
      ${floorHour(SEATED_OR_TARGET)}::int       AS hour,
      SUM("partySize") FILTER (WHERE ${SERVED}) AS covers
    FROM "Reservation"
    WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date
    GROUP BY 1, 2`,
    ...scope(restaurantId, from, to),
  );
}

export type ItemRow = { name: string; quantity: bigint; revenue: bigint; price: string; checks: bigint };

/** Item mix from closed checks. Voided lines are excluded, not counted as zero. */
export async function loadItemMix(restaurantId: string, tz: string, from: Date, to: Date) {
  const day = posServiceDay(`c."openedAt"`, "$4");
  return prisma.$queryRawUnsafe<ItemRow[]>(
    `SELECT
      ci."nameSnapshot"                  AS name,
      SUM(ci.quantity)                   AS quantity,
      SUM(ci.quantity * ci."priceCents") AS revenue,
      AVG(ci."priceCents")               AS price,
      COUNT(DISTINCT ci."checkId")       AS checks
    FROM "CheckItem" ci
    JOIN "Check" c ON c.id = ci."checkId"
    WHERE c."restaurantId" = $1
      AND c.status = 'closed'
      AND ci.state <> 'voided'
      AND ${day} >= $2::date
      AND ${day} <= $3::date
    GROUP BY 1
    ORDER BY quantity DESC`,
    ...scope(restaurantId, from, to), tz,
  );
}

/**
 * Active menu items that have never appeared on a closed check.
 *
 * More useful than "least sold": a dish that sold twice is a dish with a
 * problem, but a dish that has never sold at all may not even be reaching
 * the guest — wrong section of the menu, or never entered.
 */
export async function loadNeverSold(restaurantId: string) {
  return prisma.$queryRawUnsafe<Array<{ name: string; priceCents: number }>>(
    `SELECT mi.name, mi."priceCents"
    FROM "MenuItem" mi
    WHERE mi."restaurantId" = $1
      AND mi.active
      AND NOT mi.ephemeral
      AND NOT EXISTS (
        SELECT 1 FROM "CheckItem" ci
        JOIN "Check" c ON c.id = ci."checkId"
        WHERE c."restaurantId" = $1
          AND c.status = 'closed'
          AND ci.state <> 'voided'
          AND ci."nameSnapshot" = mi.name
      )
    ORDER BY mi.name
    LIMIT 50`,
    restaurantId,
  );
}

export type ServerRow = {
  serverId: string;
  name: string;
  shifts: bigint;
  covers: bigint | null;
  parties: bigint;
  avg_turn: string | null;
  avg_check: string | null;
};

/** Per-server performance. Covers and turn come from the floor; money joins in from the POS. */
export async function loadServerPerformance(restaurantId: string, from: Date, to: Date) {
  return prisma.$queryRawUnsafe<ServerRow[]>(
    `SELECT
      s.id                                        AS "serverId",
      s.name                                      AS name,
      COUNT(DISTINCT r."serviceDate")             AS shifts,
      SUM(r."partySize") FILTER (WHERE ${SERVED}) AS covers,
      COUNT(r.id) FILTER (WHERE ${NOT_CANCELLED}) AS parties,
      AVG(r."turnMinutes") FILTER (WHERE ${SANE_TURN_R}) AS avg_turn,
      (SELECT AVG(c."totalCents") FROM "Check" c
        WHERE c."restaurantId" = $1 AND c.status = 'closed' AND c."serverId" = s.id
      )                                           AS avg_check
    FROM "Server" s
    LEFT JOIN "Reservation" r
      ON r."serverId" = s.id
     AND r."restaurantId" = $1
     AND r."serviceDate" >= $2::date AND r."serviceDate" <= $3::date
    WHERE s."restaurantId" = $1
    GROUP BY s.id, s.name
    HAVING COUNT(r.id) > 0
    ORDER BY covers DESC NULLS LAST`,
    ...scope(restaurantId, from, to),
  );
}

export type WaitlistRow = {
  entries: bigint;
  seated: bigint;
  left: bigint;
  avg_quoted: string | null;
  avg_actual: string | null;
  covers: bigint | null;
};

/** Walk-in volume and how honest the quote was. */
export async function loadWaitlist(restaurantId: string, from: Date, to: Date) {
  const rows = await prisma.$queryRawUnsafe<WaitlistRow[]>(
    `SELECT
      COUNT(*)                                                       AS entries,
      COUNT(*) FILTER (WHERE status = 'SEATED'::"WaitlistStatus")     AS seated,
      COUNT(*) FILTER (WHERE status = 'LEFT'::"WaitlistStatus")       AS "left",
      AVG("quotedMinutes") FILTER (WHERE "quotedMinutes" > 0)         AS avg_quoted,
      AVG("actualWaitMinutes") FILTER (WHERE "actualWaitMinutes" > 0) AS avg_actual,
      SUM("partySize") FILTER (WHERE status = 'SEATED'::"WaitlistStatus") AS covers
    FROM "WaitlistEntry"
    WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date`,
    ...scope(restaurantId, from, to),
  );
  return rows[0];
}

export type GuestRow = { total_guests: bigint; repeat_guests: bigint; repeat_covers: bigint | null; new_covers: bigint | null };

/**
 * Repeat-guest share, measured over the window rather than from
 * Guest.totalVisits — a lifetime counter would call every guest a
 * "repeat" the moment they returned once in 2025.
 */
export async function loadGuestRetention(restaurantId: string, from: Date, to: Date) {
  const rows = await prisma.$queryRawUnsafe<GuestRow[]>(
    `WITH visits AS (
      SELECT "guestId", COUNT(*) AS n, SUM("partySize") AS covers
      FROM "Reservation"
      WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date
        AND ${SERVED}
      GROUP BY "guestId"
    )
    SELECT
      COUNT(*)                         AS total_guests,
      COUNT(*) FILTER (WHERE n > 1)    AS repeat_guests,
      SUM(covers) FILTER (WHERE n > 1) AS repeat_covers,
      SUM(covers) FILTER (WHERE n = 1) AS new_covers
    FROM visits`,
    ...scope(restaurantId, from, to),
  );
  return rows[0];
}

export type PaceRow = {
  sessions: bigint;
  avg_seat_to_order: string | null;
  avg_paid_to_clear: string | null;
  avg_turn: string | null;
  avg_ppa: string | null;
};

/** POS-side pace: how long before the first order, how long after the check is paid. */
export async function loadPace(restaurantId: string, from: Date, to: Date) {
  const rows = await prisma.$queryRawUnsafe<PaceRow[]>(
    `SELECT
      COUNT(*)                                                                 AS sessions,
      AVG(EXTRACT(EPOCH FROM ("firstOrderAt" - "seatedAt")) / 60.0)
        FILTER (WHERE "firstOrderAt" IS NOT NULL)                              AS avg_seat_to_order,
      AVG("paidToClearMinutes") FILTER (WHERE "paidToClearMinutes" IS NOT NULL) AS avg_paid_to_clear,
      AVG("turnMinutes") FILTER (WHERE ${SANE_TURN})                            AS avg_turn,
      AVG("ppaCents") FILTER (WHERE "ppaCents" > 0)                             AS avg_ppa
    FROM "TableSession"
    WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date`,
    ...scope(restaurantId, from, to),
  );
  return rows[0];
}

export type ForecastRow = { date: string; predicted: number | null; actual: number | null };

/**
 * Predicted covers against what actually happened. Reads the forecast
 * cache rather than the Shift table so it covers every day the AI
 * published a number for, finalised or not.
 */
export async function loadForecastAccuracy(restaurantId: string, from: Date, to: Date) {
  return prisma.$queryRawUnsafe<ForecastRow[]>(
    `WITH latest AS (
      SELECT DISTINCT ON (date) date, payload
      FROM "ShiftForecast"
      WHERE "restaurantId" = $1
      ORDER BY date, "createdAt" DESC
    ), actual AS (
      SELECT TO_CHAR("serviceDate", 'YYYY-MM-DD') AS date,
             SUM("partySize") FILTER (WHERE ${SERVED}) AS covers
      FROM "Reservation"
      WHERE "restaurantId" = $1 AND "serviceDate" >= $2::date AND "serviceDate" <= $3::date
      GROUP BY 1
    )
    SELECT
      latest.date                                              AS date,
      (latest.payload -> 'covers' ->> 'expected')::numeric::int AS predicted,
      actual.covers::int                                        AS actual
    FROM latest
    JOIN actual ON actual.date = latest.date
    ORDER BY latest.date DESC
    LIMIT 120`,
    ...scope(restaurantId, from, to),
  );
}
