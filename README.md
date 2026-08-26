# Travola Console

The simple page in front of the two complicated ones.

Travola is three products against **one Postgres database**:

| App | Repo | What it is |
|---|---|---|
| Travola-OS | `mesaos-web` | The floor manager — layout, reservations, waitlist, shift intelligence |
| Travola POS | `Travola-POS` | Orders, kitchen display, checks, menu |
| **Travola Console** | **this repo** | Plan, analyse, and administer the account |

A restaurant signs in to all three with the **same name and four-digit code**.

---

## What the Console does

- **Overview** — what needs attention, tonight's numbers, and one-click launch into the floor manager or the POS.
- **Analysis** — every shift on record, back to the earliest imported reservation. Covers, turn time, party size, no-shows, walk-in share, average bill, per-person average, revenue per seat hour, most and least sold items, month-over-month and year-over-year growth. See [`docs/ANALYSIS.md`](docs/ANALYSIS.md) for the full metric list and how each one degrades when its source is missing.
- **Predictions** — the floor app's published weekly forecast, plus how accurate the last two months of forecasts turned out to be.
- **Logins** — staff PINs, the restaurant code, and a separate owner code that gates anything irreversible.
- **Plan & billing** — plan changes, invoices, billing details, cancellation.
- **Data** — CSV export of every table, and gated deletion.
- **Settings** — service hours, days open, timezone, turn time and the other
  facts that are the denominators behind the analysis tab.

---

## Running it

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL and SESSION_SECRET
npm run dev
```

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | The **same** Neon database as Travola-OS and the POS |
| `SESSION_SECRET` | yes | Must be **byte-identical** to the value on the other two apps |
| `NEXT_PUBLIC_FLOOR_URL` | no | Where the sidebar's "Floor manager" button goes |
| `NEXT_PUBLIC_POS_URL` | no | Where the sidebar's "POS" button goes |
| `BILLING_PROVIDER` | no | `stub` (default). See [`docs/BILLING.md`](docs/BILLING.md) |
| `NEXT_PUBLIC_CONSOLE_STYLE` | no | Default visual treatment: `ledger`, `brief` or `console` |

### ⚠ This repo never migrates

Travola-OS owns **every** migration for the shared database. This repo runs
`prisma generate` only. Running `prisma migrate` or `prisma db push` from here
would try to reconcile the whole database to this partial mirror and **drop the
floor app's tables**.

The tables the Console introduced — `Subscription`, `Invoice`, `AuditLog`,
`DataExport`, and `Restaurant.adminPasscodeHash` — ship as
`20260826180000_console_account` in the Travola-OS repo.

---

## Tests

```bash
npm test
```

Covers the arithmetic a dashboard lies with: percent change against a zero base,
weighted versus naive averaging, partial-month comparison, menu-engineering
quadrants, range resolution, and the rule that a missing value never prints as
zero.

---

## Design

Top tabs, matching the floor manager's 56px bar, brand lockup and uppercase tab
treatment — a manager moving between the two products should not have to
relearn where anything is.

Two colour layers, deliberately different:

- **Chrome** (surfaces, type, borders) uses the floor app's calm values
  unchanged. A page someone stares at for an hour should not shout.
- **Data marks** use their own set, because chart marks have a job the chrome
  does not: they must stay separable from each other on a dark surface, for
  colour-blind readers too. The chrome indigo sits above the dark-mode
  lightness band for a mark, so the series colours are stepped versions of the
  same hues, checked with a palette validator rather than by eye — worst
  adjacent pair ΔE 10.1 (deutan) / 23.7 (normal vision), all ≥ 3:1 on the card
  surface.

Green and red are **reserved for direction** and always ship with an arrow and a
number, so a rise or a fall is never carried by colour alone.

See [`docs/DESIGN.md`](docs/DESIGN.md).
