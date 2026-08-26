# The analysis tab

## The problem this page had to solve

At the time it was built, this restaurant's database held:

| Source | Rows | Range |
|---|---|---|
| Reservations | 16,439 | Jan 2025 – Aug 2026 |
| …of which imported | 16,326 | from a previous system |
| Waitlist entries | 66 | Jul – Aug 2026 |
| Finalised `Shift` rows | 4 | Jun – Jul 2026 |
| **Closed checks** | **0** | — |
| **Table sessions** | **0** | — |

So there is nineteen months of covers, party size and turn-time history and
**no money history at all**, because the POS had only just gone live.

A dashboard that answers "average bill: $0.00" in that situation is worse than
one that says nothing. It is confidently wrong, and an owner who sees one zero
stops trusting the other forty numbers on the page.

Every metric therefore carries an **availability state** alongside its value:

| State | Renders as | Means |
|---|---|---|
| `ready` | the number | enough data |
| `partial` | the number + a caveat | thin sample, stated in service days |
| `awaiting_pos` | greyed, with the source named | the source exists but is empty |
| `insufficient` | greyed | not enough history to be meaningful |

The page also carries a **gaps banner** naming each missing source and listing
exactly which metrics it blocks, so an owner knows what to do about it rather
than assuming the product is broken.

---

## The metrics

### Volume & demand
| Metric | Source | Notes |
|---|---|---|
| Covers served | Reservations | Guests in parties with status `SEATED` or `FINISHED` |
| Parties seated | Reservations | Excludes cancellations |
| Average table size | Reservations | Covers ÷ parties, weighted — never a mean of daily means |
| Service days | Reservations | Distinct dates with activity |
| Walk-in share | Reservations | Share of parties with source `WALK_IN` |
| Peak hour | Reservations | Local clock, not UTC — see "Two clocks" below |
| Busiest day | Reservations | By covers |

### Money — all awaiting POS
| Metric | Source | Notes |
|---|---|---|
| Average bill | Closed checks | Total per check, tip included |
| Median bill | Closed checks | Right-skewed; the median is the honest centre |
| Per-person average | Closed checks | Revenue ÷ guests |
| Revenue | Closed checks | Per-day rate divides by days that HAD revenue, not by every service day |
| Tip rate | Closed checks | Tips ÷ pre-tax subtotal |
| Revenue per seat hour | Checks + table layout | RevPASH: fills-the-room and charges-for-it in one figure |

### Throughput & pace
| Metric | Source | Notes |
|---|---|---|
| Average table turn | Reservations | Median, and outliers excluded — see below |
| Seat utilisation | Reservations + layout | Covers ÷ what the room could physically seat |
| Seated vs booked time | Reservations | Positive = parties waited past their booked time |
| Seated to first order | Table sessions | Awaiting POS |
| Paid to cleared | Table sessions | Bussing lag. Awaiting POS |
| Wait quote error | Waitlist | Actual minus quoted |

### Reliability
No-show rate · cancellation rate · waitlist walk-aways · VIP share.

### Guests
Repeat-guest rate and share of covers from returning guests, measured **inside
the window** rather than from `Guest.totalVisits` — a lifetime counter would call
everyone a repeat guest the moment they returned once in 2025.

### Forecast accuracy
Mean absolute percentage error between the published forecast's expected covers
and what actually happened.

### Menu
Most sold, least sold, and **never sold** — items on the menu that have never
appeared on a closed check, which is more actionable than "least sold". Each item
carries a menu-engineering quadrant (star / plowhorse / puzzle / dog) using price
as a stand-in for margin, because Travola Home has no food-cost data. The UI says
so.

---

## Decisions that are easy to get wrong

### Two clocks live in this database

- The **floor app** writes `Reservation.targetTime` and friends as **local wall
  clock** into naive `timestamp` columns, and reads them back with `getHours()`
  on a UTC server — which returns the stored local hour unchanged.
- The **POS** writes `Check.openedAt` from `now()`, so those **are** real UTC
  instants and must be converted to the restaurant's zone.

Verified against production: `targetTime` hours run 16–21, exactly the configured
960–1260 service window. Reading them through `America/Denver` produced hours of
9–15 and filed **the entire dinner history as brunch** — 16,353 dinner covers
became 86. `lib/analytics/queries.ts` handles this seam; `floorHour()` versus
`localFromUtc()` is the difference.

### Turn-time outliers are excluded, not clamped

Production carries 37 reservations with turn times up to **14,370 minutes** —
tables seated and never cleared, so `finishedTime` landed days later. They are
0.2% of rows and move the mean by tens of minutes. Anything outside 10–360
minutes is dropped, and the count of what was dropped is shown on the card.

### Growth never compares a partial month to a full one

Headline month-over-month and year-over-year are measured from the last
**complete** month. In the month-by-month table an in-progress month is flagged
and its change column is blank rather than showing a fake collapse. Charts dash
the final segment.

### Percent change against zero is null, not infinity

Going from 0 to 40 covers has no percentage. The UI says "no comparable prior
period"; it does not say "+100%".

### Averages are weighted

A Tuesday with four covers does not get the same vote as a Saturday with two
hundred. `weightedMean` is used wherever a per-day figure rolls up to a period.

### Service days are derived from reservations, not from `Shift`

Only four `Shift` rows exist; the reservation history runs nineteen months.
Deriving the shift list from reservations is what makes "all past shifts, as far
back as there is data" true for imported history too.

### A stale window says so

If nothing has been recorded for more than three days, the banner says so — a
window whose data stops early makes every trend look like a collapse, and the
collapse is the calendar, not the business.

---

## Performance

One request, one grouped-SQL pass. Everything aggregates in Postgres rather than
in Node: 16,000 reservations is already too many to pull down and reduce, and the
number only goes one way.

Measured against a 14,000-reservation fixture: **50–120 ms** for the whole
payload across 30-day, 90-day and all-time ranges.
