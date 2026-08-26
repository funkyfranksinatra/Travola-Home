"use client";

// app/(home)/settings/page.tsx — the handful of facts that shape the rest.
//
// Service hours, days open and the timezone are not cosmetic: they are the
// denominators behind seat utilisation and revenue per seat hour, and the
// clock the analysis tab reads an hour in. Each field therefore says what
// it changes elsewhere, rather than sitting in a list of unexplained
// controls.
import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Empty, Field, PageHeader, SectionHeading, inputClass } from "@/components/ui";
import { Delta } from "@/components/charts";
import { Deposits } from "@/components/Deposits";
import { integer } from "@/lib/format";

type Settings = {
  restaurant: { name: string; nameKey: string; recoveryEmail: string; since: string | null };
  service: {
    openMinutes: number | null; closeMinutes: number | null; daysOpen: boolean[];
    timeZone: string; turnMinutes: number; largePartySize: number;
    holdWindowMinutes: number; reservationBufferMinutes: number;
    locationName: string; address: string;
  };
  inventory: { tables: number; floors: number; menuItems: number; staff: number };
  links: { floor: string; pos: string };
  dayNames: string[];
};

const ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
  "Europe/London", "Europe/Paris", "Europe/Madrid", "Australia/Sydney", "UTC",
];

/** "1 floor", not "1 floors". */
const plural = (count: number, one: string, many = `${one}s`) =>
  `${integer(count)} ${count === 1 ? one : many}`;

const toTime = (minutes: number | null) =>
  minutes == null ? "" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const fromTime = (value: string) => {
  const [h, m] = value.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

export default function SettingsPage() {
  const [data, setData] = useState<Settings | null>(null);
  const [form, setForm] = useState<Settings["service"] | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch("/api/settings")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not load.");
        return response.json();
      })
      .then((payload: Settings) => {
        setData(payload);
        setForm(payload.service);
        setName(payload.restaurant.name);
        setEmail(payload.restaurant.recoveryEmail);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotes([]);
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, recoveryEmail: email, ...form }),
    });
    const payload = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      setError(payload.error ?? "That did not save.");
      return;
    }
    setNotes(["Saved.", ...(payload.notes ?? [])]);
    load();
  }

  if (error && !data) return <Empty>{error}</Empty>;
  if (!data || !form) return <div className="card h-64 animate-pulse" />;

  const set = <K extends keyof Settings["service"]>(key: K, value: Settings["service"][K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const serviceHours =
    form.openMinutes != null && form.closeMinutes != null
      ? (form.closeMinutes > form.openMinutes
          ? form.closeMinutes - form.openMinutes
          : form.closeMinutes + 1440 - form.openMinutes) / 60
      : null;

  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="Settings"
        title={data.restaurant.name}
        note="These settings are shared with the floor manager and the POS — changing them here changes them everywhere."
        right={
          <div className="flex flex-wrap gap-2">
          <Chip>{plural(data.inventory.tables, "table")}</Chip>
          <Chip>{plural(data.inventory.floors, "floor")}</Chip>
          <Chip>{plural(data.inventory.staff, "staff member", "staff")}</Chip>
            <Chip tone={data.inventory.menuItems ? "neutral" : "warn"}>
              {plural(data.inventory.menuItems, "menu item")}
            </Chip>
          </div>
        }
      />

      {error ? <Card className="p-4 border-l-2 border-l-state-seated"><p className="text-sm text-state-seated">{error}</p></Card> : null}
      {notes.length ? (
        <Card className="p-4 border-l-2 border-l-state-avail">
          {notes.map((note, index) => (
            <p key={index} className={index === 0 ? "text-sm text-state-avail" : "text-xs text-ink-400 mt-1"}>{note}</p>
          ))}
        </Card>
      ) : null}

      <section className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <SectionHeading title="Identity" note="The name is what everyone types to sign in — to all three apps." />
          <div className="flex flex-col gap-4">
            <Field
              label="Restaurant name"
              hint={
                name.trim() !== data.restaurant.name
                  ? "Changing this changes the sign-in name for the floor manager, the POS and Travola Home."
                  : "Typed at sign-in. Apostrophes and capitalisation do not matter."
              }
            >
              <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Recovery email" hint="Where account recovery would be sent.">
              <input className={inputClass} type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            <Field label="Address" hint="Used by the weekly forecast to research local events and weather.">
              <input className={inputClass} value={form.address} onChange={(event) => set("address", event.target.value)} />
            </Field>
          </div>
        </Card>

        <Card className="p-5">
          <SectionHeading
            title="Service"
            note="Hours and timezone are the denominators behind seat utilisation and revenue per seat hour."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Opens">
              <input
                className={inputClass} type="time" value={toTime(form.openMinutes)}
                onChange={(event) => set("openMinutes", fromTime(event.target.value))}
              />
            </Field>
            <Field label="Closes">
              <input
                className={inputClass} type="time" value={toTime(form.closeMinutes)}
                onChange={(event) => set("closeMinutes", fromTime(event.target.value))}
              />
            </Field>
            <div className="sm:col-span-2">
              <Field
                label="Timezone"
                hint="The clock the analysis tab reads an hour in. Set this wrong and the peak-hour chart moves."
              >
                <select
                  className={inputClass} value={form.timeZone}
                  onChange={(event) => set("timeZone", event.target.value)}
                >
                  {[...new Set([form.timeZone, ...ZONES])].map((zone) => (
                    <option key={zone} value={zone}>{zone}</option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
          {serviceHours ? (
            <p className="text-xs text-ink-400 mt-4">
              {serviceHours.toFixed(1)} hours of service a day
              {form.daysOpen.filter(Boolean).length
                ? `, ${form.daysOpen.filter(Boolean).length} days a week`
                : ""}.
            </p>
          ) : null}
        </Card>
      </section>

      <Card className="p-5">
        <SectionHeading title="Days open" note="A closed day is excluded from forecasts and from the day-of-week averages." />
        <div className="flex flex-wrap gap-2">
          {data.dayNames.map((day, index) => {
            const open = form.daysOpen[index];
            return (
              <button
                key={day}
                type="button"
                onClick={() => set("daysOpen", form.daysOpen.map((value, i) => (i === index ? !value : value)))}
                className={`rounded-xl px-4 py-2.5 text-sm font-semibold border ${
                  open
                    ? "bg-ai-bg border-ai/40 text-ai"
                    : "bg-panel border-border text-ink-400 hover:text-ink-50"
                }`}
                aria-pressed={open}
              >
                {day.slice(0, 3)}
                <span className="block text-[10px] font-normal mt-0.5 opacity-70">{open ? "open" : "closed"}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <section className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <NumberCard
          label="Default turn time"
          suffix="min"
          value={form.turnMinutes}
          onChange={(value) => set("turnMinutes", value)}
          hint="Used when a party has no observed turn yet — and as the capacity assumption behind seat utilisation."
        />
        <NumberCard
          label="Large party from"
          suffix="guests"
          value={form.largePartySize}
          onChange={(value) => set("largePartySize", value)}
          hint="Parties this size and up are flagged for a manager on the floor."
        />
        <NumberCard
          label="Table hold window"
          suffix="min"
          value={form.holdWindowMinutes}
          onChange={(value) => set("holdWindowMinutes", value)}
          hint="How long a table is held past a booking before it is offered to a walk-in."
        />
        <NumberCard
          label="Reservation buffer"
          suffix="min"
          value={form.reservationBufferMinutes}
          onChange={(value) => set("reservationBufferMinutes", value)}
          hint="Padding between two bookings on the same table."
        />
      </section>

      {/* Deposits sits above the app links and below the operating
          settings: it is the only thing on this page that decides where
          money goes, so it gets its own guarded block rather than a row
          among service hours. */}
      <Deposits />

      <Card className="p-5">
        <SectionHeading
          title="Your other two apps"
          note="Same restaurant name and code as this one. Nothing to set up — every restaurant uses these addresses, and the sign-in decides which restaurant you see."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <LinkRow label="Floor manager" hint="Reservations, waitlist, sections" href={data.links.floor} />
          <LinkRow label="POS" hint="Orders, kitchen, checks" href={data.links.pos} />
        </div>
      </Card>

      <div className="no-print sticky bottom-4 flex justify-end">
        <div className="card p-3 flex items-center gap-3 shadow-2xl">
          <span className="text-xs text-ink-400 px-1">Hours, days and service &mdash; shared with the floor manager and the POS</span>
          <Button tone="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save settings"}</Button>
        </div>
      </div>
    </div>
  );
}

function NumberCard({ label, value, suffix, hint, onChange }: {
  label: string; value: number; suffix: string; hint: string; onChange: (value: number) => void;
}) {
  return (
    <Card className="p-4" lit>
      <span className="label">{label}</span>
      <div className="mt-2.5 flex items-baseline gap-2">
        <input
          type="number"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="figure-sm w-20 bg-transparent border-b border-border focus:border-ai outline-none text-ink-50"
        />
        <span className="text-sm text-ink-400">{suffix}</span>
      </div>
      <p className="text-xs text-ink-400 mt-3 leading-relaxed">{hint}</p>
    </Card>
  );
}

function LinkRow({ label, hint, href }: { label: string; hint: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block rounded-xl bg-panel border border-border px-4 py-3 hover:border-border-hi"
    >
      <p className="label">{label}</p>
      <p className="text-sm text-ink-50 mt-1.5">{hint}</p>
      <p className="text-xs text-ai mt-1.5 truncate">{href} ↗</p>
    </a>
  );
}
